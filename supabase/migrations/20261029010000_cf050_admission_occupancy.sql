-- CF-050 admission: canonical consent, privacy-safe refusals, and protected
-- per-report occupancy.
--
-- WHY THIS FILE EXISTS. `supabase/tests/verify_cf050_admission.sql` is RED on
-- the shipped chain (admission-red-r2b.log, 21 named violations). The current
-- writers can be driven into every one of these states:
--
--   * `findback_propose_match` trusts the caller's argument order, reads
--     without locks, checks only existence/ownership/OPEN, and never records
--     the proposer's acknowledgement. It also answers "Report not found" or
--     "Only report owners can propose matches", which is an existence/owner
--     oracle, and it lets a blocked, hidden or seriously sanctioned account
--     open a consent flow.
--   * `findback_confirm_match` counts arbitrary confirmation rows instead of
--     the two current owners, has no committed retry, no current-eligibility
--     recheck, and no occupancy: two confirmed links can share a report.
--   * `report_matches` has no cancellation reason, so a pending attempt
--     invalidated by a winning confirmation cannot say why.
--
-- WHAT THIS FILE DOES
--   1. Adds `report_matches.cancel_reason` with a constrained vocabulary.
--   2. Fails the migration closed on ambiguous legacy relationships, then
--      backfills a new protected `report_match_occupancy` authority for the
--      unambiguous CONFIRMED rows. No acknowledgement is synthesized.
--   3. Rewrites propose: lexical report locks, canonical LOST/FOUND
--      orientation, current visibility/standing/block/recovery checks, one
--      generic `P0002 Match unavailable` refusal, active-pair replay for
--      either current owner without added consent, and exactly the proposer's
--      acknowledgement on a new proposal.
--   4. Rewrites confirm: locks reports lexically then the relationship,
--      reapplies current eligibility, records only the caller's consent,
--      counts the two current owners, invalidates conflicting pending
--      attempts atomically, occupies both reports, and returns MATCHED on a
--      committed participant retry.
--   5. Adds an internal trigger so occupancy disappears whenever a
--      relationship leaves CONFIRMED or is deleted, and keeps participant
--      cancellation labelled `USER_CANCELLED`.
--
-- BOUNDED CLAIM. This is RPC admission under the current snapshot. Direct
-- owner `type` edits, report/account deletion repair, durable
-- recovery/rating retention, participant projection, notifications, consumer
-- wiring, matching-quality calibration, hosted apply and device acceptance
-- remain separate gates named in ADMISSION-DESIGN.md. D25's unilateral
-- unlinked recovery is unchanged; no linked escape window is introduced.
begin;

-- 1. Cancellation reason: history must say why a pending attempt ended.
alter table public.report_matches
  add column if not exists cancel_reason text;

alter table public.report_matches
  drop constraint if exists report_matches_cancel_reason_check;
alter table public.report_matches
  add constraint report_matches_cancel_reason_check
  check (cancel_reason is null
         or cancel_reason in ('USER_CANCELLED', 'SUPERSEDED_BY_CONFIRMED'));

comment on column public.report_matches.cancel_reason is
  'Why a relationship ended, when the actor is not a participant: SUPERSEDED_BY_CONFIRMED is written by the winning confirmation with cancelled_by NULL; USER_CANCELLED is the participant action. Legacy rows and D25 stay NULL until their own explicit reason is added.';

-- 2. Fail closed on ambiguous legacy state before any occupancy authority is
--    created. Counts only: a migration diagnostic never names a user, report
--    or relationship. No row is cancelled, reoriented, adopted or erased.
do $$
declare
  v_bad integer;
  v_msg text := '';
begin
  -- 2a. Live relationships that cannot describe a real LOST -> FOUND pair.
  select count(*) into v_bad
    from public.report_matches m
    left join public.item_posts lp on lp.id = m.lost_report_id
    left join public.item_posts fp on fp.id = m.found_report_id
   where m.status <> 'CANCELLED'
     and (m.lost_report_id = m.found_report_id
          or lp.id is null or fp.id is null
          or lp.type is distinct from 'LOST'
          or fp.type is distinct from 'FOUND'
          or lp.user_id is null or fp.user_id is null
          or lp.user_id = fp.user_id);
  if v_bad > 0 then v_msg := v_msg || format('invalid_live_pair=%s; ', v_bad); end if;

  -- 2b. PENDING rows a confirmation can never resolve, and confirmations that
  --     name somebody other than the two current owners.
  select count(*) into v_bad
    from public.report_matches m
    join public.item_posts lp on lp.id = m.lost_report_id
    join public.item_posts fp on fp.id = m.found_report_id
   where m.status = 'PENDING'
     and (lp.status not in ('OPEN', 'CLOSED')
          or fp.status not in ('OPEN', 'CLOSED'));
  if v_bad > 0 then v_msg := v_msg || format('pending_report_state=%s; ', v_bad); end if;

  select count(*) into v_bad
    from public.report_matches m
   where m.status = 'PENDING'
     and exists (
       select 1 from public.match_confirmations c
        where c.match_id = m.id
          and not exists (
            select 1 from public.item_posts p
             where p.id in (m.lost_report_id, m.found_report_id)
               and p.user_id = c.owner_id_original));
  if v_bad > 0 then v_msg := v_msg || format('pending_foreign_ack=%s; ', v_bad); end if;

  -- 2c. CONFIRMED rows without exactly one acknowledgement from each current
  --     owner (retained identifiers are the durable truth).
  select count(*) into v_bad
    from public.report_matches m
    join public.item_posts lp on lp.id = m.lost_report_id
    join public.item_posts fp on fp.id = m.found_report_id
   where m.status = 'CONFIRMED'
     and (select count(distinct c.owner_id_original)
            from public.match_confirmations c
           where c.match_id = m.id
             and c.owner_id_original in (lp.user_id, fp.user_id)) <> 2;
  if v_bad > 0 then v_msg := v_msg || format('confirmed_consent=%s; ', v_bad); end if;

  -- 2d. CONFIRMED rows whose report lifecycle is not the canonical pair:
  --     both MATCHED with no recovery, or both RECOVERED with exactly the
  --     linked return naming this LOST/FOUND pair.
  select count(*) into v_bad
    from public.report_matches m
    join public.item_posts lp on lp.id = m.lost_report_id
    join public.item_posts fp on fp.id = m.found_report_id
   where m.status = 'CONFIRMED'
     and not (
       (lp.status = 'MATCHED' and fp.status = 'MATCHED'
        and not exists (select 1 from public.successful_returns r
                         where r.lost_post_id = m.lost_report_id
                            or r.found_post_id = m.lost_report_id
                            or r.lost_post_id = m.found_report_id
                            or r.found_post_id = m.found_report_id))
       or
       (lp.status = 'RECOVERED' and fp.status = 'RECOVERED'
        and exists (select 1 from public.successful_returns r
                     where r.lost_post_id = m.lost_report_id
                       and r.found_post_id = m.found_report_id))
     );
  if v_bad > 0 then v_msg := v_msg || format('confirmed_lifecycle=%s; ', v_bad); end if;

  -- 2e. Two CONFIRMED rows claiming the same report.
  select count(*) into v_bad
    from (
      select x.report_id
        from (select lost_report_id as report_id
                from public.report_matches where status = 'CONFIRMED'
              union all
              select found_report_id
                from public.report_matches where status = 'CONFIRMED') x
       group by x.report_id
      having count(*) > 1
    ) y;
  if v_bad > 0 then v_msg := v_msg || format('shared_confirmed_report=%s; ', v_bad); end if;

  -- 2f. A recovery that contradicts a live relationship.
  select count(*) into v_bad
    from public.report_matches m
   where m.status <> 'CANCELLED'
     and exists (
       select 1 from public.successful_returns r
        where (r.lost_post_id in (m.lost_report_id, m.found_report_id)
               or r.found_post_id in (m.lost_report_id, m.found_report_id))
          and not (m.status = 'CONFIRMED'
                   and r.lost_post_id = m.lost_report_id
                   and r.found_post_id = m.found_report_id));
  if v_bad > 0 then v_msg := v_msg || format('recovery_contradiction=%s; ', v_bad); end if;

  if v_msg <> '' then
    raise exception 'CF-050 admission preflight failed closed: %', v_msg
      using errcode = 'P0001',
            hint = 'Repair the counted relationships explicitly; this migration never guesses or rewrites history.';
  end if;
end $$;

-- 3. Protected occupancy authority: one live CONFIRMED/RECOVERED relationship
--    per report, independent of stored orientation.
create table if not exists public.report_match_occupancy (
  report_id  text primary key references public.item_posts(id) on delete cascade,
  match_id   text not null references public.report_matches(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists ix_report_match_occupancy_match
  on public.report_match_occupancy (match_id);

alter table public.report_match_occupancy enable row level security;
revoke all on table public.report_match_occupancy
  from public, anon, authenticated, service_role;

comment on table public.report_match_occupancy is
  'CF-050 admission authority: exactly one live CONFIRMED relationship per report. Written only by findback_confirm_match and the backfill; cleared by the relationship trigger. No grant and no policy: a definer reader is the only consumer.';

insert into public.report_match_occupancy (report_id, match_id)
select m.lost_report_id, m.id
  from public.report_matches m
 where m.status = 'CONFIRMED'
union all
select m.found_report_id, m.id
  from public.report_matches m
 where m.status = 'CONFIRMED';

-- 4. Occupancy follows the relationship. The trigger never locks a peer
--    report, so it cannot invert the report-first lock order.
create or replace function public.findback_report_match_occupancy_release()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.report_match_occupancy where match_id = old.id;
    return old;
  end if;
  if new.status is distinct from 'CONFIRMED' then
    delete from public.report_match_occupancy where match_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function public.findback_report_match_occupancy_release()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_report_matches_occupancy_release
  on public.report_matches;
create trigger trg_report_matches_occupancy_release
  after update of status or delete on public.report_matches
  for each row execute function public.findback_report_match_occupancy_release();

-- 5. Proposal: consent is explicit, orientation is derived, refusal is one
--    generic answer.
--
-- The parameter names are historical: either order is accepted and the stored
-- orientation is derived from the locked rows. `P0002 Match unavailable` is
-- byte-identical for missing, hidden, foreign, same-owner, same-type,
-- wrong-state, blocked, sanctioned and recovery-conflicted pairs; `22023
-- Invalid match pair` is only for caller-structural input.
create or replace function public.findback_propose_match(p_lost_id text, p_found_id text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_a text := nullif(btrim(coalesce(p_lost_id, '')), '');
  v_b text := nullif(btrim(coalesce(p_found_id, '')), '');
  v_row_a record;
  v_row_b record;
  v_lost_id text;
  v_found_id text;
  v_lost_owner text;
  v_found_owner text;
  v_lost_status text;
  v_found_status text;
  v_match_id text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if v_a is null or v_b is null or v_a = v_b then
    raise exception 'Invalid match pair' using errcode = '22023';
  end if;

  -- Contract lock order: report rows, lexical. Only the supplied ids are
  -- locked; a missing row is simply not locked and is refused below.
  perform 1
     from public.item_posts p
    where p.id in (v_a, v_b)
    order by p.id
      for update;

  select p.id, p.user_id, p.type, p.status, p.moderation_visibility
    into v_row_a
    from public.item_posts p
   where p.id = v_a;
  select p.id, p.user_id, p.type, p.status, p.moderation_visibility
    into v_row_b
    from public.item_posts p
   where p.id = v_b;

  if v_row_a.id is null or v_row_b.id is null
     or v_row_a.user_id is null or v_row_b.user_id is null then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;
  if v_row_a.user_id <> v_uid and v_row_b.user_id <> v_uid then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;
  if v_row_a.user_id = v_row_b.user_id then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;
  -- Canonical visibility is owner OR published. The invoker view is not
  -- authority inside a definer, so the atom is written out here.
  if not (v_row_a.user_id = v_uid or v_row_a.moderation_visibility = 'PUBLISHED')
     or not (v_row_b.user_id = v_uid or v_row_b.moderation_visibility = 'PUBLISHED') then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  if v_row_a.type = 'LOST' and v_row_b.type = 'FOUND' then
    v_lost_id := v_row_a.id;  v_found_id := v_row_b.id;
    v_lost_owner := v_row_a.user_id; v_found_owner := v_row_b.user_id;
    v_lost_status := v_row_a.status; v_found_status := v_row_b.status;
  elsif v_row_a.type = 'FOUND' and v_row_b.type = 'LOST' then
    v_lost_id := v_row_b.id;  v_found_id := v_row_a.id;
    v_lost_owner := v_row_b.user_id; v_found_owner := v_row_a.user_id;
    v_lost_status := v_row_b.status; v_found_status := v_row_a.status;
  else
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  if v_lost_status <> 'OPEN' or v_found_status <> 'OPEN' then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.successful_returns r
     where r.lost_post_id in (v_lost_id, v_found_id)
        or r.found_post_id in (v_lost_id, v_found_id)
  ) then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  -- PROBATION and RESTRICTED are public-write controls; they do not ban a
  -- private consent flow. SUSPENDED and BANNED do.
  if coalesce(public.findback_active_sanction_kind(v_lost_owner), '')
       in ('SUSPENDED', 'BANNED')
     or coalesce(public.findback_active_sanction_kind(v_found_owner), '')
       in ('SUSPENDED', 'BANNED') then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  if public.findback_is_blocked_pair(v_lost_owner, v_found_owner) then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  -- Active-pair replay is authorization, not consent: either current owner
  -- may discover the existing operation, and nobody's acknowledgement is
  -- added. A foreign caller never reaches here.
  select m.id into v_match_id
    from public.report_matches m
   where m.lost_report_id = v_lost_id
     and m.found_report_id = v_found_id
     and m.status <> 'CANCELLED';
  if v_match_id is not null then
    return v_match_id;
  end if;

  insert into public.report_matches (lost_report_id, found_report_id, proposed_by)
  values (v_lost_id, v_found_id, v_uid)
  returning id into v_match_id;

  insert into public.match_confirmations
    (match_id, match_id_original, owner_id, owner_id_original)
  values (v_match_id, v_match_id, v_uid, v_uid);

  return v_match_id;
end;
$$;
revoke all on function public.findback_propose_match(text, text) from public, anon;
grant execute on function public.findback_propose_match(text, text) to authenticated;

comment on function public.findback_propose_match(text, text) is
  'CF-050 proposal (owner-only). Locks both reports lexically, derives canonical LOST->FOUND orientation, reapplies current visibility/standing/block/recovery eligibility, and records exactly the proposer''s acknowledgement. Either current owner replaying an active pair receives the same identity with no added consent. Every ineligible, foreign, hidden or missing pair answers the same P0002 Match unavailable with no write.';

-- 6. Confirmation: the other owner's explicit consent, one live occupancy,
--    atomic invalidation of conflicting attempts, committed retry.
create or replace function public.findback_confirm_match(p_match_id text)
returns text  -- 'PARTIAL' or 'MATCHED'
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_id text := nullif(btrim(coalesce(p_match_id, '')), '');
  v_lost_hint text;
  v_found_hint text;
  v_lost_id text;
  v_found_id text;
  v_lost_owner text;
  v_found_owner text;
  v_lost_status text;
  v_found_status text;
  v_lost_type text;
  v_found_type text;
  v_lost_visibility text;
  v_found_visibility text;
  v_status text;
  v_count integer;
  v_conflicts text[];
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if v_id is null then raise exception 'Match unavailable' using errcode = 'P0002'; end if;

  select m.lost_report_id, m.found_report_id
    into v_lost_hint, v_found_hint
    from public.report_matches m
   where m.id = v_id;
  if v_lost_hint is null or v_found_hint is null then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  -- Contract lock order: report rows lexical, then the relationship row.
  perform 1
     from public.item_posts p
    where p.id in (v_lost_hint, v_found_hint)
    order by p.id
      for update;

  select m.status, m.lost_report_id, m.found_report_id
    into v_status, v_lost_id, v_found_id
    from public.report_matches m
   where m.id = v_id
     for update;
  -- A changed pair means the rows locked above are the wrong ones. Refuse
  -- rather than confirm against a snapshot we do not hold.
  if v_status is null
     or v_lost_id is distinct from v_lost_hint
     or v_found_id is distinct from v_found_hint then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  select p.user_id, p.type, p.status, p.moderation_visibility
    into v_lost_owner, v_lost_type, v_lost_status, v_lost_visibility
    from public.item_posts p
   where p.id = v_lost_id;
  select p.user_id, p.type, p.status, p.moderation_visibility
    into v_found_owner, v_found_type, v_found_status, v_found_visibility
    from public.item_posts p
   where p.id = v_found_id;

  if v_lost_owner is null or v_found_owner is null
     or v_lost_type is distinct from 'LOST'
     or v_found_type is distinct from 'FOUND' then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;
  if v_uid <> v_lost_owner and v_uid <> v_found_owner then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;
  if not (v_lost_owner = v_uid or v_lost_visibility = 'PUBLISHED')
     or not (v_found_owner = v_uid or v_found_visibility = 'PUBLISHED') then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;
  if coalesce(public.findback_active_sanction_kind(v_lost_owner), '')
       in ('SUSPENDED', 'BANNED')
     or coalesce(public.findback_active_sanction_kind(v_found_owner), '')
       in ('SUSPENDED', 'BANNED') then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;
  if public.findback_is_blocked_pair(v_lost_owner, v_found_owner) then
    raise exception 'Match unavailable' using errcode = 'P0002';
  end if;

  if v_status = 'PENDING' then
    if v_lost_status <> 'OPEN' or v_found_status <> 'OPEN' then
      raise exception 'Match unavailable' using errcode = 'P0002';
    end if;
    if exists (
      select 1 from public.successful_returns r
       where r.lost_post_id in (v_lost_id, v_found_id)
          or r.found_post_id in (v_lost_id, v_found_id)
    ) then
      raise exception 'Match unavailable' using errcode = 'P0002';
    end if;

    insert into public.match_confirmations
      (match_id, match_id_original, owner_id, owner_id_original)
    values (v_id, v_id, v_uid, v_uid)
    on conflict (match_id, owner_id) do nothing;

    -- Count the two CURRENT owners only. An arbitrary row, a stale owner or
    -- a deleted account's retained acknowledgement is not consent.
    select count(distinct c.owner_id_original)
      into v_count
      from public.match_confirmations c
     where c.match_id = v_id
       and c.owner_id_original in (v_lost_owner, v_found_owner);

    if v_count < 2 then
      return 'PARTIAL';
    end if;

    -- Lock every competing PENDING attempt sharing either report. Each of
    -- those writers must first acquire a report row this transaction already
    -- holds, so it cannot hold one of these relationship rows while waiting.
    perform 1
       from public.report_matches m
      where m.status = 'PENDING'
        and m.id <> v_id
        and (m.lost_report_id in (v_lost_id, v_found_id)
             or m.found_report_id in (v_lost_id, v_found_id))
      order by m.id
        for update;

    select coalesce(array_agg(m.id order by m.id), '{}')
      into v_conflicts
      from public.report_matches m
     where m.status = 'PENDING'
       and m.id <> v_id
       and (m.lost_report_id in (v_lost_id, v_found_id)
            or m.found_report_id in (v_lost_id, v_found_id));

    -- Occupy both reports before the status transition. A conflict means a
    -- live relationship already claims a report; the whole statement,
    -- including this caller's tentative acknowledgement, rolls back.
    begin
      insert into public.report_match_occupancy (report_id, match_id)
      values (least(v_lost_id, v_found_id), v_id),
             (greatest(v_lost_id, v_found_id), v_id);
    exception when unique_violation then
      raise exception 'MATCH_STATUS_CONFLICT' using errcode = 'P0001';
    end;

    if cardinality(v_conflicts) > 0 then
      update public.report_matches m
         set status = 'CANCELLED',
             cancelled_at = clock_timestamp(),
             cancelled_by = null,
             cancel_reason = 'SUPERSEDED_BY_CONFIRMED'
       where m.id = any (v_conflicts);
    end if;

    update public.report_matches
       set status = 'CONFIRMED', confirmed_at = clock_timestamp()
     where id = v_id;
    update public.item_posts
       set status = 'MATCHED', updated_at = v_now
     where id in (v_lost_id, v_found_id);
    return 'MATCHED';
  end if;

  if v_status = 'CONFIRMED' then
    -- A committed retry still has to be a truthful current relationship.
    if v_lost_status = 'MATCHED' and v_found_status = 'MATCHED' then
      if exists (
        select 1 from public.successful_returns r
         where r.lost_post_id in (v_lost_id, v_found_id)
            or r.found_post_id in (v_lost_id, v_found_id)
      ) then
        raise exception 'Match unavailable' using errcode = 'P0002';
      end if;
    elsif v_lost_status = 'RECOVERED' and v_found_status = 'RECOVERED'
          and exists (
            select 1 from public.successful_returns r
             where r.lost_post_id = v_lost_id
               and r.found_post_id = v_found_id) then
      null;
    else
      raise exception 'Match unavailable' using errcode = 'P0002';
    end if;

    if not exists (
      select 1 from public.match_confirmations c
       where c.match_id = v_id
         and c.owner_id_original = v_uid) then
      raise exception 'Match unavailable' using errcode = 'P0002';
    end if;
    select count(distinct c.owner_id_original)
      into v_count
      from public.match_confirmations c
     where c.match_id = v_id
       and c.owner_id_original in (v_lost_owner, v_found_owner);
    if v_count <> 2 then
      raise exception 'Match unavailable' using errcode = 'P0002';
    end if;
    return 'MATCHED';
  end if;

  -- CANCELLED or anything unrecognised: no live consent operation.
  raise exception 'Match unavailable' using errcode = 'P0002';
end;
$$;
revoke all on function public.findback_confirm_match(text) from public, anon;
grant execute on function public.findback_confirm_match(text) to authenticated;

comment on function public.findback_confirm_match(text) is
  'CF-050 confirmation. Locks both reports lexically then the relationship, reapplies current eligibility, records only the caller''s consent, counts the two current owners, occupies both reports, cancels competing pending attempts as SUPERSEDED_BY_CONFIRMED with no fabricated actor, and moves both reports to MATCHED atomically. A committed participant retry returns MATCHED without writes; changed eligibility answers P0002 Match unavailable.';

-- 7. Participant cancellation keeps the reason vocabulary truthful. The
--    occupancy trigger removes the authority rows when a CONFIRMED link is
--    corrected.
create or replace function public.findback_cancel_match(p_match_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_status text;
  v_lost_owner text;
  v_found_owner text;
  v_lost_id text;
  v_found_id text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select m.status, m.lost_report_id, m.found_report_id, lp.user_id, fp.user_id
    into v_status, v_lost_id, v_found_id, v_lost_owner, v_found_owner
    from public.report_matches m
    join public.item_posts lp on lp.id = m.lost_report_id
    join public.item_posts fp on fp.id = m.found_report_id
    where m.id = p_match_id;

  if v_status is null then raise exception 'Match not found' using errcode='P0001'; end if;
  if v_status not in ('PENDING', 'CONFIRMED') then
    raise exception 'Only a pending or confirmed match can be cancelled' using errcode='P0001';
  end if;
  if v_lost_owner is null or v_found_owner is null then
    raise exception 'Match not found' using errcode='P0001';
  end if;
  if v_uid <> v_lost_owner and v_uid <> v_found_owner then
    raise exception 'Only report owners can cancel matches' using errcode='42501';
  end if;

  perform 1
     from public.item_posts p
    where p.id in (v_lost_id, v_found_id)
    order by p.id
      for update;
  perform 1
     from public.report_matches m
    where m.id = p_match_id
      for update;

  -- Re-read under the lock: a concurrent handover may have completed.
  select m.status into v_status
    from public.report_matches m
   where m.id = p_match_id;
  if v_status is null then raise exception 'Match not found' using errcode='P0001'; end if;
  if v_status not in ('PENDING', 'CONFIRMED') then
    raise exception 'Only a pending or confirmed match can be cancelled' using errcode='P0001';
  end if;

  if v_status = 'CONFIRMED' then
    -- A completed recovery is a past event, not a draft: correcting it needs
    -- an audited path that does not exist yet.
    if exists (select 1 from public.successful_returns r
                where r.lost_post_id = v_lost_id) then
      raise exception 'A completed recovery cannot be undone here' using errcode='P0001';
    end if;
    update public.item_posts
       set status = 'OPEN', updated_at = v_now
     where id in (v_lost_id, v_found_id);
  end if;

  update public.report_matches
     set status = 'CANCELLED',
         cancelled_at = clock_timestamp(),
         cancelled_by = v_uid,
         cancel_reason = 'USER_CANCELLED'
   where id = p_match_id;
end;
$$;
revoke all on function public.findback_cancel_match(text) from public, anon;
grant execute on function public.findback_cancel_match(text) to authenticated;

comment on function public.findback_cancel_match(text) is
  'CF-050 cancellation. A PENDING proposal is cancelled with USER_CANCELLED. A CONFIRMED link with no completed recovery is the Wrong match action: both reports reopen to OPEN atomically, the occupancy authority is released by the relationship trigger, and confirmation rows stay as durable history. A completed recovery is refused.';

commit;
