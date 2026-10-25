-- CF-050 linked recovery: make RECOVERED a durable relationship write, keep
-- consent/handover history durable, and stop the generic writers from
-- fabricating a linked lifecycle.
--
-- WHY THIS FILE EXISTS. Four evidenced defects, all reproduced by
-- supabase/tests/verify_cf050_linked_recovery.sql:
--
--   1. `findback_handover_match` set `item_posts.status = 'RECOVERED'` and
--      returned 'RECOVERED' without writing `public.successful_returns` — the
--      row the same schema calls the durable recovery relationship
--      (20261023020000_trust_blocks_feedback_recovery.sql:21,242-269). A status
--      write is not a recovery: the recovery screens, the rating eligibility
--      read and any later history all key off the relationship row.
--   2. `match_confirmations` and `match_handovers` cascaded from both
--      `report_matches` and `users` (20261024120000:9-10,95-96), so deleting a
--      match or an account erased the consent/handover evidence the owner
--      contract requires to stay durable.
--   3. `findback_change_post_status_client` (20260914190000:274-305) accepted
--      `MATCHED`/`RECOVERED` for any owned report, so one authenticated call
--      still produced a status-only RECOVERED beside a MATCHED peer with no
--      relationship row — the exact symptom defect 1 is about — and walked
--      straight past the new D25 guard.
--   4. `findback_cancel_match` refused anything but `PENDING`. With the new
--      D25 guard that left a CONFIRMED link with an unresponsive counterpart as
--      a permanent dead end, where before the owner could at least recover
--      unilaterally.
--
-- Owner contract (OWNER-APPROVED-CONTRACT-2026-10-24.md:10,11,16,23,26-27):
--   * "RECOVERED follows actual handover"; linked recovery is separate from
--     D25's unilateral declared-helper recovery, which is preserved.
--   * Either participant may correct an erroneous confirmed link before
--     recovery: cancel the link, reopen both reports atomically, keep the
--     history. A completed recovery needs an audited correction instead.
--   * History keeps "nullable live references plus explicit retained original
--     identifiers", so participant deletion cannot erase it and cannot make a
--     retained third-party identity public.
--   * Lock order is report rows (lexical), then relationship rows, then
--     recovery rows — for every competing writer, not only new RPCs.
--
-- STILL OPEN, deliberately not closed here: per-report CONFIRMED/RECOVERED
-- occupancy (two confirmed links can still share a report); `wrong_match` as a
-- distinct audited operation and any correction of a completed recovery; direct
-- client `type` edits on a linked report (`findback_update_post_client` still
-- accepts LOST<->FOUND, which can desync the public meaning of a link even
-- though the relationship orientation itself is stored separately); MATCHED is
-- still accepted by the status seam for an *unlinked* report (the client picker
-- offers it), so a report can still claim a match with no relationship — making
-- MATCHED relationship-only is a separate server+client change with a visible
-- product effect;
-- `successful_returns` still cascades away with a participant's reports, so the
-- recovery relationship itself does not outlive account deletion (deletion
-- strategy gate); `findback_cancel_match` reopens a confirmed pair without
-- asserting the reports are MATCHED, relying on the status guard for that;
-- concurrency and deadlock probes; `report_matches.status` has no terminal
-- RECOVERED value, so a recovered pair still reads CONFIRMED to a future
-- projection; and all client integration of propose/confirm/handover (none of
-- the three is called from apps/mobile). The hosted legacy state is untouched.
--
-- This migration is single-apply: `add constraint` has no `if not exists` form,
-- so it relies on Supabase's migration version tracking rather than re-running.
begin;

-- 1. Durable history: nullable live references + retained original identifiers.
--
-- Both foreign keys are `deferrable initially deferred` on purpose. Deleting a
-- user fires the `owner_id` set-null action as an UPDATE on the same row, and
-- that UPDATE re-validates `match_id` while the match row is already gone but
-- its own set-null is still queued. Checked immediately that is a 23503 that
-- aborts account deletion; checked at commit both columns are NULL and the
-- delete succeeds with the history intact.
do $$
declare
  v_rec record;
begin
  for v_rec in
    select c.conrelid::regclass::text as tbl, c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and c.conrelid in ('public.match_confirmations'::regclass,
                          'public.match_handovers'::regclass)
       and a.attname in ('match_id', 'owner_id')
  loop
    execute format('alter table %s drop constraint %I', v_rec.tbl, v_rec.conname);
  end loop;
end $$;

alter table public.match_confirmations
  add column if not exists match_id_original text,
  add column if not exists owner_id_original text;
alter table public.match_handovers
  add column if not exists match_id_original text,
  add column if not exists owner_id_original text;

update public.match_confirmations set match_id_original = match_id where match_id_original is null;
update public.match_confirmations set owner_id_original = owner_id where owner_id_original is null;
update public.match_handovers set match_id_original = match_id where match_id_original is null;
update public.match_handovers set owner_id_original = owner_id where owner_id_original is null;

alter table public.match_confirmations
  alter column match_id_original set not null,
  alter column owner_id_original set not null,
  alter column match_id drop not null,
  alter column owner_id drop not null;
alter table public.match_handovers
  alter column match_id_original set not null,
  alter column owner_id_original set not null,
  alter column match_id drop not null,
  alter column owner_id drop not null;

alter table public.match_confirmations
  add constraint match_confirmations_match_fk foreign key (match_id)
    references public.report_matches(id) on delete set null
    deferrable initially deferred,
  add constraint match_confirmations_owner_fk foreign key (owner_id)
    references public.users(id) on delete set null
    deferrable initially deferred;
alter table public.match_handovers
  add constraint match_handovers_match_fk foreign key (match_id)
    references public.report_matches(id) on delete set null
    deferrable initially deferred,
  add constraint match_handovers_owner_fk foreign key (owner_id)
    references public.users(id) on delete set null
    deferrable initially deferred;

create index if not exists ix_match_confirmations_match_original
  on public.match_confirmations (match_id_original);
create index if not exists ix_match_handovers_match_original
  on public.match_handovers (match_id_original);

comment on column public.match_confirmations.match_id_original is
  'Retained relationship identifier. Survives deletion of report_matches; never a public identifier.';
comment on column public.match_confirmations.owner_id_original is
  'Retained participant identifier. Survives account deletion; never exposed through a policy or projection.';
comment on column public.match_handovers.match_id_original is
  'Retained relationship identifier. Survives deletion of report_matches; never a public identifier.';
comment on column public.match_handovers.owner_id_original is
  'Retained participant identifier. Survives account deletion; never exposed through a policy or projection.';

-- 1b. report_matches must not block an account deletion either.
--
-- `proposed_by` and `cancelled_by` were plain NO ACTION references, so any
-- account that had ever proposed or cancelled a match could not be deleted at
-- all (23503 from the after-trigger check, which fires before the item_posts
-- cascade removes the row). `report_matches` is the live relationship row, not
-- a retention table: the durable history is the confirmation/handover rows
-- above, which keep their retained identifiers. A proposer always owns one of
-- the two linked reports, so the row is removed by the same cascade in every
-- reachable case.
do $$
declare
  v_rec record;
begin
  for v_rec in
    select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and c.conrelid = 'public.report_matches'::regclass
       and a.attname in ('proposed_by', 'cancelled_by')
  loop
    execute format('alter table public.report_matches drop constraint %I', v_rec.conname);
  end loop;
end $$;

alter table public.report_matches
  add constraint report_matches_proposed_by_fkey foreign key (proposed_by)
    references public.users(id) on delete cascade,
  add constraint report_matches_cancelled_by_fkey foreign key (cancelled_by)
    references public.users(id) on delete set null;

-- 2. Confirmation writes both the live and the retained identifiers and takes
--    the same lock order as handover (report rows lexically, then the match).
create or replace function public.findback_confirm_match(p_match_id text)
returns text  -- returns 'PARTIAL' or 'MATCHED'
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_locked_lost text;
  v_locked_found text;
  v_lost_owner text;
  v_found_owner text;
  v_lost_status text;
  v_found_status text;
  v_status text;
  v_confirmation_count integer;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select m.lost_report_id, m.found_report_id into v_locked_lost, v_locked_found
    from public.report_matches m
   where m.id = p_match_id;
  if not found then raise exception 'Match not found' using errcode='P0001'; end if;

  -- Contract lock order. Without this, a second confirmation holds the match
  -- row while a concurrent handover holds the report rows: 40P01.
  perform 1
     from public.item_posts p
    where p.id in (v_locked_lost, v_locked_found)
    order by p.id
      for update;

  select m.status, lp.user_id, fp.user_id, lp.status, fp.status
    into v_status, v_lost_owner, v_found_owner, v_lost_status, v_found_status
    from public.report_matches m
    join public.item_posts lp on lp.id = m.lost_report_id
    join public.item_posts fp on fp.id = m.found_report_id
    where m.id = p_match_id
      for update of m;

  if v_status is null then raise exception 'Match not found' using errcode='P0001'; end if;
  if v_status <> 'PENDING' then raise exception 'Match is not pending' using errcode='P0001'; end if;
  if v_lost_owner is null or v_found_owner is null then
    raise exception 'Match not found' using errcode='P0001';
  end if;
  if v_uid <> v_lost_owner and v_uid <> v_found_owner then
    raise exception 'Only report owners can confirm matches' using errcode='42501';
  end if;
  if v_lost_status <> 'OPEN' or v_found_status <> 'OPEN' then
    raise exception 'Both reports must be OPEN to confirm' using errcode='P0001';
  end if;

  -- Record this owner's confirmation (idempotent). The retained identifier is
  -- written in the same statement so history survives a later match deletion.
  insert into public.match_confirmations (match_id, match_id_original, owner_id, owner_id_original)
  values (p_match_id, p_match_id, v_uid, v_uid)
  on conflict (match_id, owner_id) do nothing;

  select count(*) into v_confirmation_count
    from public.match_confirmations
   where match_id = p_match_id;

  if v_confirmation_count >= 2 then
    update public.report_matches
      set status = 'CONFIRMED', confirmed_at = clock_timestamp()
      where id = p_match_id;
    update public.item_posts set status = 'MATCHED'
      where id in (v_locked_lost, v_locked_found);
    return 'MATCHED';
  end if;

  return 'PARTIAL';
end;
$$;
revoke all on function public.findback_confirm_match(text) from public, anon;
grant execute on function public.findback_confirm_match(text) to authenticated;

-- 3. Handover writes the canonical recovery relationship.
create or replace function public.findback_handover_match(p_match_id text)
returns text  -- 'PARTIAL' until both owners handed over, then 'RECOVERED'
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_locked_lost text;
  v_locked_found text;
  v_lost_id text;
  v_found_id text;
  v_status text;
  v_lost_owner text;
  v_found_owner text;
  v_lost_status text;
  v_found_status text;
  v_handover_count integer;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select m.lost_report_id, m.found_report_id into v_locked_lost, v_locked_found
    from public.report_matches m
   where m.id = p_match_id;
  if not found then raise exception 'Match not found' using errcode='P0001'; end if;

  perform 1
     from public.item_posts p
    where p.id in (v_locked_lost, v_locked_found)
    order by p.id
      for update;

  select m.status, m.lost_report_id, m.found_report_id
    into v_status, v_lost_id, v_found_id
    from public.report_matches m
   where m.id = p_match_id
     for update;
  if not found then raise exception 'Match not found' using errcode='P0001'; end if;
  -- Defensive: no shipped writer updates these columns and the unique pair
  -- constraint forbids a replacement row, but if one ever did, the rows locked
  -- above would be the wrong ones.
  if v_lost_id <> v_locked_lost or v_found_id <> v_locked_found then
    raise exception 'Match changed during handover; retry' using errcode='40001';
  end if;

  select p.user_id, p.status into v_lost_owner, v_lost_status
    from public.item_posts p where p.id = v_lost_id;
  select p.user_id, p.status into v_found_owner, v_found_status
    from public.item_posts p where p.id = v_found_id;

  if v_lost_owner is null or v_found_owner is null then
    raise exception 'Match not found' using errcode='P0001';
  end if;
  if v_status <> 'CONFIRMED' then
    raise exception 'Match must be CONFIRMED before handover' using errcode='P0001';
  end if;
  if v_lost_status not in ('MATCHED', 'RECOVERED') or v_found_status not in ('MATCHED', 'RECOVERED') then
    raise exception 'Both reports must be MATCHED before handover' using errcode='P0001';
  end if;
  if v_uid <> v_lost_owner and v_uid <> v_found_owner then
    raise exception 'Only report owners can hand over matches' using errcode='42501';
  end if;

  insert into public.match_handovers (match_id, match_id_original, owner_id, owner_id_original)
  values (p_match_id, p_match_id, v_uid, v_uid)
  on conflict (match_id, owner_id) do nothing;

  select count(*) into v_handover_count
    from public.match_handovers
   where match_id = p_match_id;

  if v_handover_count >= 2 then
    -- A retry of a committed handover returns the same result and must not add
    -- a second recovery row.
    if exists (select 1 from public.successful_returns r
                where r.lost_post_id = v_lost_id
                  and r.found_post_id = v_found_id) then
      return 'RECOVERED';
    end if;

    -- Scoped handler: only the recovery insert can raise this, so the message
    -- cannot mislabel an unrelated unique violation from elsewhere in the body.
    begin
      insert into public.successful_returns (
        id, lost_post_id, found_post_id, lost_owner_user_id, helper_user_id,
        external_helper, recovered_at, confirmed_by, created_at
      ) values (
        gen_random_uuid()::text,
        v_lost_id,
        v_found_id,
        v_lost_owner,
        v_found_owner,
        false,
        v_now,
        v_uid,
        v_now
      );
    exception when unique_violation then
      raise exception 'This lost report already has a recorded recovery' using errcode='23505';
    end;

    update public.item_posts
       set status = 'RECOVERED',
           updated_at = v_now
     where id in (v_lost_id, v_found_id);
    return 'RECOVERED';
  end if;

  return 'PARTIAL';
end;
$$;
revoke all on function public.findback_handover_match(text) from public, anon;
grant execute on function public.findback_handover_match(text) to authenticated;

comment on function public.findback_handover_match(text) is
  'CF-050 linked handover. Locks both reports lexically then the relationship row, records this owner''s handover, and once both have handed over writes the canonical successful_returns relationship and moves both reports to RECOVERED in the same transaction. A retry returns the same result without a second recovery row.';

-- 4. D25 must not desynchronize a report that is inside a confirmed link.
create or replace function public.findback_mark_recovered(
  p_post_id text,
  p_helper_kind text,
  p_helper_user_id text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_post_id text := btrim(coalesce(p_post_id, ''));
  v_kind text := upper(btrim(coalesce(p_helper_kind, '')));
  v_helper text := nullif(btrim(coalesce(p_helper_user_id, '')), '');
  v_post record;
  v_id text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_post_id = '' then
    raise exception 'A report is required' using errcode = '22023';
  end if;

  -- Lock the report: two concurrent confirmations of the same post must
  -- serialize, so the unique index sees the first row before the second
  -- caller inserts.
  select p.id, p.user_id, p.type, p.status
    into v_post
    from public.item_posts p
   where p.id = v_post_id
     for update;

  if not found then
    raise exception 'Report not found' using errcode = 'P0002';
  end if;

  if v_post.user_id <> v_uid then
    raise exception 'Only the owner of a report can mark it recovered' using errcode = '42501';
  end if;

  if v_post.type <> 'LOST' then
    raise exception 'Only a lost-item report can be marked recovered' using errcode = '22023';
  end if;

  -- Lock every live relationship involving this report. The report row is
  -- already held, so this follows the contract order: reports, then
  -- relationship rows.
  perform 1
     from public.report_matches m
    where m.status in ('PENDING', 'CONFIRMED')
      and (m.lost_report_id = v_post.id or m.found_report_id = v_post.id)
    order by m.id
      for update;

  -- A confirmed link has its own recovery path. Letting the unilateral path
  -- write here would leave the other report MATCHED and the relationship
  -- half-recorded. Legacy MATCHED reports with no report_matches row keep
  -- working, so the declared-helper path D25 approved is preserved.
  if exists (
    select 1 from public.report_matches m
     where m.status = 'CONFIRMED'
       and (m.lost_report_id = v_post.id or m.found_report_id = v_post.id)
  ) then
    raise exception 'This report is linked to a confirmed match; complete the handover instead'
      using errcode = 'P0001';
  end if;

  -- A proposal can never be confirmed once this report is recovered, so it is
  -- closed here rather than left as dead state that blocks the pair and makes
  -- confirm fail with a confusing reason. The acknowledgement itself stays as
  -- durable history.
  update public.report_matches
     set status = 'CANCELLED', cancelled_at = clock_timestamp(), cancelled_by = v_uid
   where status = 'PENDING'
     and (lost_report_id = v_post.id or found_report_id = v_post.id);

  if v_kind not in ('FINDBACK_USER', 'OUTSIDE', 'SELF_OR_PRIVATE') then
    raise exception 'Unknown helper kind' using errcode = '22023';
  end if;

  if v_kind = 'FINDBACK_USER' then
    if v_helper is null then
      raise exception 'A FindBack helper is required' using errcode = '22023';
    end if;
    if v_helper = v_uid then
      raise exception 'A FindBack helper must be another account; mark a self-recovery as self or private' using errcode = '22023';
    end if;
    if not exists (select 1 from public.users u where u.id = v_helper) then
      raise exception 'Helper not found' using errcode = 'P0002';
    end if;
  elsif v_helper is not null then
    -- An OUTSIDE or SELF_OR_PRIVATE helper is NOT an account: accepting an id
    -- here would publish a name the owner asked not to disclose.
    raise exception 'An outside or private helper has no account' using errcode = '22023';
  end if;

  insert into public.successful_returns (
    id, lost_post_id, found_post_id, lost_owner_user_id, helper_user_id,
    external_helper, recovered_at, confirmed_by, created_at
  ) values (
    gen_random_uuid()::text,
    v_post.id,
    null,
    v_uid,
    v_helper,
    v_kind <> 'FINDBACK_USER',
    v_now,
    null,
    v_now
  )
  returning id into v_id;

  update public.item_posts p
     set status = 'RECOVERED',
         updated_at = v_now
   where p.id = v_post.id;

  return v_id;
exception
  when unique_violation then
    raise exception 'This report has already been marked recovered' using errcode = '23505';
end;
$$;

revoke all on function public.findback_mark_recovered(text, text, text) from public, anon;
grant execute on function public.findback_mark_recovered(text, text, text) to authenticated;

comment on function public.findback_mark_recovered(text, text, text) is
  'FindBack recovery writer (definer, D25): the report owner marks a LOST report recovered with a closed helper kind (FINDBACK_USER / OUTSIDE / SELF_OR_PRIVATE). Returns the successful_returns row id — the relationship — and moves item_posts.status to RECOVERED in the same transaction. One recovery per report (23505 on a second). Refuses a report inside a CONFIRMED link (that recovery goes through findback_handover_match) and cancels any PENDING proposal on the report, which could never be confirmed afterwards.';

-- 5. The generic status writer must not fabricate a linked lifecycle, and the
--    status column must not be writable behind its back.
--
-- `report_matches` has RLS enabled with no policy and no grant, so an invoker
-- function cannot read it. This definer helper answers one question for the
-- post's own owner only, which is what the guard needs.
create or replace function public.findback_post_is_match_linked(p_post_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.item_posts p
      join public.report_matches m
        on m.lost_report_id = p.id or m.found_report_id = p.id
     where p.id = p_post_id
       and p.user_id = auth.uid()::text
       and m.status = 'CONFIRMED'
  );
$$;
revoke all on function public.findback_post_is_match_linked(text) from public, anon;
grant execute on function public.findback_post_is_match_linked(text) to authenticated;

comment on function public.findback_post_is_match_linked(text) is
  'True only when the caller owns the report and it is part of a CONFIRMED match. A PENDING proposal deliberately does not freeze the report lifecycle. Used by the generic status writer to refuse a lifecycle change that belongs to the relationship seam.';

-- The column grant was the real bypass: `authenticated` could PATCH
-- item_posts.status directly and reproduce a status-only RECOVERED without
-- calling any RPC. The status RPC below is the single seam, so it runs as its
-- owner and enforces ownership in its WHERE clause. `type` stays granted
-- because the invoker edit RPC needs it (still open: a type edit on a linked
-- report can desync the public meaning of a link).
revoke update (status) on public.item_posts from authenticated;

create or replace function public.findback_change_post_status_client(
  p_post_id text,
  p_status text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_count integer;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_status is null or p_status not in ('OPEN', 'MATCHED', 'RECOVERED', 'CLOSED') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;

  -- A recorded recovery is terminal for this seam. Reopening it would leave
  -- the recovery relationship describing a report that reads OPEN, and
  -- RECOVERED could not be re-asserted afterwards, so the mislabel would be
  -- permanent. Correcting a recovery needs the audited path, which does not
  -- exist yet.
  -- Both sides of a recovery count, and only for the caller's own report: the
  -- found side keeps its guard even if the match row is later removed, and a
  -- foreign report answers exactly like any other foreign report (42501 from
  -- the ownership WHERE below) instead of confirming that it was recovered.
  if exists (
    select 1
      from public.item_posts p
      join public.successful_returns r
        on r.lost_post_id = p.id or r.found_post_id = p.id
     where p.id = p_post_id
       and p.user_id = v_uid
  ) then
    raise exception 'This report is already recorded as recovered, so its status cannot be changed here'
      using errcode = 'P0001';
  end if;

  -- RECOVERED is never a status write: it is the durable recovery
  -- relationship, written by findback_mark_recovered or the linked handover.
  -- The client routes it through the recovery sheet, so refusing costs no flow.
  if p_status = 'RECOVERED' then
    raise exception 'Use Mark recovered on the report to record a recovery'
      using errcode = 'P0001';
  end if;

  -- Ordinary unlinked close/reopen stays available. A confirmed report's
  -- lifecycle belongs to the match.
  if public.findback_post_is_match_linked(p_post_id) then
    raise exception 'This report is part of a match, so its status cannot be changed here'
      using errcode = 'P0001';
  end if;

  update public.item_posts
     set status = p_status, updated_at = v_now
   where id = p_post_id and user_id = v_uid;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Post not found or you do not own it' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke all on function public.findback_change_post_status_client(text, text)
  from public, anon;
grant execute on function public.findback_change_post_status_client(text, text)
  to authenticated;

comment on function public.findback_change_post_status_client(text, text) is
  'The single authenticated seam for an ordinary report status change. Definer because the status column grant is revoked from authenticated; ownership is enforced by the WHERE clause. Refuses RECOVERED (a relationship write), any change to a report that already has a recorded recovery, and any change to a report inside a CONFIRMED match.';

-- 6. Either participant can correct a confirmed link before recovery.
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
    -- A completed recovery is a past event, not a draft: correcting it needs an
    -- audited path that does not exist yet.
    if exists (select 1 from public.successful_returns r
                where r.lost_post_id = v_lost_id) then
      raise exception 'A completed recovery cannot be undone here' using errcode='P0001';
    end if;
    update public.item_posts
       set status = 'OPEN', updated_at = v_now
     where id in (v_lost_id, v_found_id);
  end if;

  update public.report_matches
     set status = 'CANCELLED', cancelled_at = clock_timestamp(), cancelled_by = v_uid
   where id = p_match_id;
end;
$$;
revoke all on function public.findback_cancel_match(text) from public, anon;
grant execute on function public.findback_cancel_match(text) to authenticated;

comment on function public.findback_cancel_match(text) is
  'CF-050 cancellation. A PENDING proposal is cancelled as before. A CONFIRMED link with no completed recovery is the Wrong match action: both reports reopen to OPEN atomically and the confirmation rows stay as durable history. A completed recovery is refused.';

-- 7. A report cannot be born matched or recovered.
--
-- `authenticated` holds a table-wide INSERT on item_posts with an RLS policy
-- that only checks `user_id`, so a caller could create a report already
-- MATCHED or RECOVERED with no relationship behind it. The trigger constrains
-- API roles only: definer RPCs, migrations, fixtures and the service role are
-- unaffected. It runs as the invoker, so `current_user` is the API role.
create or replace function public.findback_guard_post_lifecycle()
returns trigger
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') and new.status not in ('OPEN', 'CLOSED') then
    raise exception 'A report cannot be created already matched or recovered' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_item_posts_lifecycle_guard on public.item_posts;
create trigger trg_item_posts_lifecycle_guard
  before insert on public.item_posts
  for each row execute function public.findback_guard_post_lifecycle();

comment on function public.findback_guard_post_lifecycle() is
  'Rejects an API-created report that starts MATCHED or RECOVERED. MATCHED and RECOVERED are relationship states, not an initial lifecycle a caller may assert.';

-- 8. A cancelled pair must be able to be proposed again.
--
-- The table-level unique pair constraint made a deliberate re-proposal of a
-- cancelled link fail with 23505 forever, contradicting the contract's "a
-- deliberate new proposal gets a new identity". Only an active proposal may be
-- unique per pair; cancelled attempts stay as history.
do $$
declare
  v_name text;
begin
  select c.conname
    into v_name
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.contype = 'u'
     and c.conrelid = 'public.report_matches'::regclass
     and a.attname in ('lost_report_id', 'found_report_id')
   group by c.conname
  having count(*) = 2;

  if v_name is not null then
    execute format('alter table public.report_matches drop constraint %I', v_name);
  end if;
end $$;

create unique index if not exists ux_report_matches_active_pair
  on public.report_matches (lost_report_id, found_report_id)
  where status <> 'CANCELLED';

commit;
