-- FindBack — the trust writes: block/unblock, the durable recovery record,
-- participant return ratings, the DERIVED reputation tier / standing / posting
-- limits, and feedback.
--
-- WHY THIS FILE EXISTS. The consumer safety and recovery surfaces need writes
-- the chain does not have yet: blocking has a table and READ predicates but no
-- writer at all; "recovered" is a report status and nothing else; there is no
-- user rating model, no derived trust presentation, no derived interaction
-- limit and no feedback channel.
--
-- The accepted moderation decision (MC §4 C3, §5 C4, §6 C5) fixes the model:
--
--   D16/D17  user_blocks stays DIRECTIONAL (one row per act) and its EFFECT is
--            MUTUAL. The existing read predicates are already the symmetric
--            disjunction; this file adds the write side only.
--   D18      Nobody may discover who blocked whom, or in which direction. The
--            table keeps "no grant, RLS enabled, zero policies"; the writer is
--            a definer RPC, the reader stays findback_my_blocks().
--   D22      Unblock restores mutual visibility ONLY when both directions are
--            gone. An unblock clears the caller's own row and nothing else.
--   D25      Recovery is a durable successful_returns ROW, not
--            item_posts.status = 'RECOVERED'. The status moves with it (it is
--            the report's own lifecycle) but the relationship is the row.
--   D26      Return ratings are participant-only, once per DIRECTION, self
--            denied, unrelated denied. The rated user is DERIVED from the
--            recovery row, so there is no parameter a client could lie with.
--   D28      Reputation tier and standing are DERIVED from existing rows —
--            never a stored score, never a boolean column.
--   D29      Posting/commenting limits are derived SERVER-side from standing
--            and tier, and enforced on the write itself.
--   D30–D33  public.feedback: closed category vocabulary, server-assembled
--            technical context from NAMED scalars (no client blob), own-status
--            reads only, admin_note never in the grant, account deletion
--            removes the row and keeps no aggregate.
--
-- OWNER DECISION O3 (§13.5): the report and feedback ceilings are 2× the normal
-- interaction limit, expressed as a multiple of ONE base function so the
-- numbers cannot drift apart. This file introduces
-- findback_base_interaction_limit(); the report lane (B2a) consumes it.
--
-- CROSS-LANE DEPENDENCY, STATED PLAINLY. Standing and the post limit read
-- public.account_sanctions, which the moderation lane (B2b) owns:
--
--   account_sanctions(id, user_id, kind in ('WARNING','PROBATION','RESTRICTED',
--   'SUSPENDED','BANNED'), starts_at, ends_at, reason_code, moderator_note,
--   active, created_by, created_at, revoked_at, revoked_by)
--
-- This migration CONSUMES that table and must sort AFTER it. It does not
-- create it, does not modify it and does not duplicate a sanction writer: the
-- sanction IS the standing, and one writer owns it. The plpgsql bodies below
-- therefore reference the table without a catalog-time dependency; the
-- verification file models the contract shape when the moderation lane is not
-- present in the chain it runs against.
--
-- NO `now_text()` HELPER EXISTS in this chain: the UTC text expression is
-- inlined everywhere, exactly as the rest of the chain does.
--
-- FORWARD-ONLY. This file only ADDS objects. It re-creates no shipped function
-- and drops no shipped policy.
--
-- Verification pointer: supabase/tests/verify_20261023020000_trust_blocks_feedback_recovery.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. The base interaction limit (D29, owner decision O3).
-- ---------------------------------------------------------------------------
--
-- ONE number, read by the standing-derived limit below and by the report and
-- feedback ceilings as a MULTIPLE. The owner's ruling is "double the normal
-- interaction limits"; a literal in three places would drift, so the normal
-- interaction limit is the base and everything else is expressed against it:
--
--   normal posting / commenting      base            (5 per UTC day)
--   a TRUSTED account                2 × base        (10)
--   a NEW account                    3               (below base, on purpose)
--   a PROBATION account              1
--   a restricted/suspended/banned    0
--   report ceiling (B2a)             2 × base
--   feedback ceiling (this file)     2 × base
--
-- It is a starting operational policy (10:181), not a constant of nature: the
-- next value change is a one-row update to THIS function.
create or replace function public.findback_base_interaction_limit()
returns integer
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select 5;
$$;

revoke all on function public.findback_base_interaction_limit() from public, anon;
grant execute on function public.findback_base_interaction_limit() to authenticated;

comment on function public.findback_base_interaction_limit() is
  'FindBack base interaction limit (owner decision O3): the normal per-UTC-day posting/commenting ceiling. TRUSTED is 2x it, report and feedback ceilings are 2x it, so the numbers cannot drift apart.';


-- ===========================================================================
-- 2. BLOCK WRITES (D16–D18, D22).
-- ===========================================================================
--
-- public.user_blocks already exists (20261017070000_visibility_kernel_and_blocks
-- .sql) with its grant rule: `revoke all ... from public, anon, authenticated`,
-- RLS enabled, ZERO policies, and the two read predicates
-- (findback_is_blocked_pair internal, findback_is_blocked_with_me caller-
-- scoped). Nothing here changes that table: the writes go through the two
-- definer RPCs below, so the direction never becomes readable and no policy has
-- to exist on the table.
--
-- The predicate the EFFECT relies on is already symmetric, so a single row in
-- either direction already hides the pair from each other in feeds, search,
-- comments, report-card resolution and notifications (D17). What this file adds
-- is (a) the act, (b) the per-direction undo, and (c) the D22 return value.

-- Block a user. The act is one-sided; the effect is mutual.
--
-- Idempotent on purpose: tapping Block twice is one row, and the ORIGINAL
-- created_at is kept (a second tap must not look like a newer act).
create or replace function public.findback_block_user(p_user_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_target text := btrim(coalesce(p_user_id, ''));
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_target = '' then
    raise exception 'A user is required' using errcode = '22023';
  end if;

  -- The table's own CHECK is the second line; this is the answerable refusal.
  if v_target = v_uid then
    raise exception 'You cannot block yourself' using errcode = '22023';
  end if;

  if not exists (select 1 from public.users u where u.id = v_target) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;

  insert into public.user_blocks (blocker_user_id, blocked_user_id, created_at)
  values (
    v_uid,
    v_target,
    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  on conflict (blocker_user_id, blocked_user_id) do nothing;
end;
$$;

revoke all on function public.findback_block_user(text) from public, anon;
grant execute on function public.findback_block_user(text) to authenticated;

comment on function public.findback_block_user(text) is
  'FindBack block (definer): writes the caller''s OWN directional block row; the existing symmetric read predicate makes the EFFECT mutual. Idempotent, self blocked with 22023, unknown target P0002. Nothing but the caller''s own row is ever written (D16/D17).';

-- Unblock a user. D22: the mutual effect clears ONLY when no direction remains.
--
-- The return value is DIRECTION-FREE and is exactly the bit the sanctioned
-- caller-scoped reader already answers (findback_is_blocked_with_me):
--
--   true  — a block row still exists in EITHER direction, so the pair stays
--           hidden from each other (the caller's own unblock did not, and
--           cannot, clear the other party's protection);
--   false — no row remains in either direction: mutual visibility is restored.
--
-- It never says who blocked whom, and it is not new information: after the
-- delete the caller could ask findback_is_blocked_with_me(SAME USER) and get
-- the same bit (MC §13.8).
create or replace function public.findback_unblock_user(p_user_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_target text := btrim(coalesce(p_user_id, ''));
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_target = '' then
    raise exception 'A user is required' using errcode = '22023';
  end if;

  if v_target = v_uid then
    raise exception 'You cannot unblock yourself' using errcode = '22023';
  end if;

  -- D22: ONLY the caller's own outgoing row. Clearing both directions would
  -- let one party strip the other's protection with one tap.
  delete from public.user_blocks b
   where b.blocker_user_id = v_uid
     and b.blocked_user_id = v_target;

  return exists (
    select 1
      from public.user_blocks b
     where (b.blocker_user_id = v_uid and b.blocked_user_id = v_target)
        or (b.blocker_user_id = v_target and b.blocked_user_id = v_uid)
  );
end;
$$;

revoke all on function public.findback_unblock_user(text) from public, anon;
grant execute on function public.findback_unblock_user(text) to authenticated;

comment on function public.findback_unblock_user(text) is
  'FindBack unblock (definer): deletes the caller''s OWN outgoing block row only. Returns TRUE while a block row still exists in either direction (the pair remains hidden) and FALSE once both directions are gone (D22). The bit is direction-free and equals findback_is_blocked_with_me() for the same user.';


-- ===========================================================================
-- 3. RECOVERY (D25) — the durable relationship row.
-- ===========================================================================
--
-- A recovery is NOT item_posts.status = 'RECOVERED'. The status is the report's
-- own lifecycle; the RELATIONSHIP is this row, because it names the two people
-- (when there are two), whether the helper was outside FindBack, and when.
--
-- The lost report's owner is the only writer today, and one lost report can be
-- recovered ONCE: the unique index is the duplicate-recovery rule (15:355),
-- regardless of who confirmed it.
--
-- external_helper/two nullable user columns exist so "do not force public
-- disclosure of who returned an item" is structural (06:357): an outside or
-- self/private helper leaves both user columns empty and only the boolean.
--
-- match_id is deliberately ABSENT: report_matches is CF-050's, and adding the
-- nullable column later is additive with no rewrite (MC C4/C7).
create table if not exists public.successful_returns (
  id                 text primary key,
  lost_post_id       text not null references public.item_posts(id) on delete cascade,
  found_post_id      text null references public.item_posts(id) on delete cascade,
  lost_owner_user_id text null references public.users(id) on delete set null,
  helper_user_id     text null references public.users(id) on delete set null,
  external_helper    boolean not null default false,
  recovered_at       text not null,
  confirmed_by       text null references public.users(id) on delete set null,
  created_at         text not null
);

-- One recovery per lost report (15:355). A second mark_recovered fails.
create unique index if not exists ux_successful_returns_lost_post
  on public.successful_returns (lost_post_id);

-- The two participant lookups (their recoveries, rating eligibility).
create index if not exists ix_successful_returns_lost_owner
  on public.successful_returns (lost_owner_user_id);
create index if not exists ix_successful_returns_helper
  on public.successful_returns (helper_user_id);

alter table public.successful_returns enable row level security;

revoke all on table public.successful_returns from public, anon, authenticated;

comment on table public.successful_returns is
  'FindBack recoveries (MC D25): the durable recovery RELATIONSHIP, not item_posts.status. One row per recovered lost report. Participant-scoped reads go through findback_my_recoveries(); there is no table grant and no policy.';

-- Mark a lost report recovered. D25.
--
-- p_helper_kind is the closed vocabulary from 10:66-69:
--   FINDBACK_USER   — a FindBack account returned it: p_helper_user_id required,
--                     must exist and must not be the caller.
--   OUTSIDE         — returned by somebody outside the app: no account id.
--   SELF_OR_PRIVATE — the owner recovered it themselves / no public helper: no
--                     account id.
--
-- The report's status moves to RECOVERED in the SAME transaction, but the
-- returned id is the successful_returns row: that is the relationship the
-- recovery screens and the rating eligibility read.
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
  'FindBack recovery writer (definer, D25): the report owner marks a LOST report recovered with a closed helper kind (FINDBACK_USER / OUTSIDE / SELF_OR_PRIVATE). Returns the successful_returns row id — the relationship — and moves item_posts.status to RECOVERED in the same transaction. One recovery per report (23505 on a second).';

-- The caller's own recoveries, participant-scoped (D23 ii: a block suppresses
-- discovery, never the shared record).
--
-- An account reaches a recovery only when it is the lost owner or the helper.
-- counterpart_user_id is NULL for an outside/private helper — the recovery
-- exists, the person is not named.
create or replace function public.findback_my_recoveries()
returns table (
  successful_return_id text,
  lost_post_id text,
  counterpart_user_id text,
  external_helper boolean,
  recovered_at text,
  my_rating integer,
  counterpart_rating integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  return query
  select
    s.id,
    s.lost_post_id,
    case
      when s.lost_owner_user_id = v_uid then s.helper_user_id
      when s.helper_user_id = v_uid then s.lost_owner_user_id
      else null
    end,
    s.external_helper,
    s.recovered_at,
    (select r.score from public.return_ratings r
      where r.successful_return_id = s.id and r.rater_user_id = v_uid limit 1),
    (select r.score from public.return_ratings r
      where r.successful_return_id = s.id and r.rated_user_id = v_uid limit 1)
    from public.successful_returns s
   where s.lost_owner_user_id = v_uid
      or s.helper_user_id = v_uid
   order by s.recovered_at desc, s.id asc;
end;
$$;

revoke all on function public.findback_my_recoveries() from public, anon;
grant execute on function public.findback_my_recoveries() to authenticated;

comment on function public.findback_my_recoveries() is
  'FindBack recoveries (definer, participant-only): the caller''s own recovery rows with the counterpart (NULL for an outside/private helper), the caller''s own rating and the rating about the caller. A block never hides this record (D23).';


-- ===========================================================================
-- 4. RETURN RATINGS (D26) — participant-only, once per direction.
-- ===========================================================================
--
-- The unique key is (successful_return_id, rater_user_id, rated_user_id), so a
-- completed return yields at most TWO ratings — one each way. The CHECK is the
-- cheap second line against a self rating; the RPC is the guarantee.
--
-- rated_user_id is DERIVED in the writer: the RPC takes no rated-user
-- parameter, so "do not let the client submit an arbitrary rated user"
-- (12:375) is structural, not a validation branch.
create table if not exists public.return_ratings (
  id                  text primary key,
  successful_return_id text not null references public.successful_returns(id) on delete cascade,
  rater_user_id       text null references public.users(id) on delete cascade,
  rated_user_id       text null references public.users(id) on delete cascade,
  score               integer not null check (score between 1 and 5),
  created_at          text not null,
  updated_at          text not null,
  unique (successful_return_id, rater_user_id, rated_user_id),
  constraint return_ratings_self_check check (rater_user_id is distinct from rated_user_id)
);

create index if not exists ix_return_ratings_rated
  on public.return_ratings (rated_user_id);

alter table public.return_ratings enable row level security;

-- The brief's blanket rule (D18's pattern): NO client grant on the table. Reads
-- go through findback_return_ratings(); writes through findback_rate_return().
revoke all on table public.return_ratings from public, anon, authenticated;

-- The row rule, stated once. It is INERT today because no client role holds a
-- SELECT grant (a policy without a grant is not access), and it is kept so that
-- a future grant cannot silently widen the row set beyond the participants.
drop policy if exists return_ratings_select_participants on public.return_ratings;
create policy return_ratings_select_participants
  on public.return_ratings
  for select
  to authenticated
  using (rater_user_id = (select auth.uid())::text or rated_user_id = (select auth.uid())::text);

comment on table public.return_ratings is
  'FindBack return ratings (MC D26): one rating per DIRECTION per recovery, participants only, self impossible (derived counterpart + CHECK). No client table grant: reads via findback_return_ratings(), writes via findback_rate_return().';

-- Rate the OTHER participant of a recovery. D26.
--
--   * participant only — a caller who is neither the lost owner nor the helper
--     gets 42501;
--   * once per direction — the unique key refuses a second rating by the same
--     rater (23505), while the other participant may still rate;
--   * self denied twice over — the counterpart is derived, and an
--     OUTSIDE/SELF_OR_PRIVATE recovery has no FindBack counterpart at all
--     (22023), so there is nothing to rate;
--   * a block is irrelevant here (D23): the two people of a completed return
--     keep their rating eligibility.
create or replace function public.findback_rate_return(p_return_id text, p_score integer)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_return_id text := btrim(coalesce(p_return_id, ''));
  v_return record;
  v_rated text;
  v_id text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'A rating must be between 1 and 5' using errcode = '22023';
  end if;

  select s.id, s.lost_owner_user_id, s.helper_user_id
    into v_return
    from public.successful_returns s
   where s.id = v_return_id;

  if not found then
    raise exception 'Recovery not found' using errcode = 'P0002';
  end if;

  -- Both participants, or nobody. A missing participant column (a deleted
  -- account) never matches, so a removed counterpart leaves nothing to rate.
  if v_return.lost_owner_user_id is distinct from v_uid
     and v_return.helper_user_id is distinct from v_uid then
    raise exception 'Only the people in this recovery can rate it' using errcode = '42501';
  end if;

  if v_return.helper_user_id is null
     or v_return.lost_owner_user_id is null
     or v_return.helper_user_id = v_return.lost_owner_user_id then
    raise exception 'This recovery has no FindBack counterpart to rate' using errcode = '22023';
  end if;

  -- The OTHER participant. There is no parameter that could name anybody else.
  v_rated := case
    when v_uid = v_return.lost_owner_user_id then v_return.helper_user_id
    else v_return.lost_owner_user_id
  end;

  if v_rated = v_uid then
    raise exception 'You cannot rate yourself' using errcode = '22023';
  end if;

  insert into public.return_ratings (
    id, successful_return_id, rater_user_id, rated_user_id, score, created_at, updated_at
  ) values (
    gen_random_uuid()::text, v_return.id, v_uid, v_rated, p_score, v_now, v_now
  )
  returning id into v_id;

  return v_id;
exception
  when unique_violation then
    raise exception 'You have already rated this recovery' using errcode = '23505';
end;
$$;

revoke all on function public.findback_rate_return(text, integer) from public, anon;
grant execute on function public.findback_rate_return(text, integer) to authenticated;

comment on function public.findback_rate_return(text, integer) is
  'FindBack rating writer (definer, D26): participant-only, once per direction. The rated user is DERIVED as the other participant — there is no rated-user parameter — so a client cannot name an arbitrary target. Self rating is impossible (22023 on an outside/private recovery), and a duplicate direction is 23505.';

-- The participants' view of one recovery's ratings.
create or replace function public.findback_return_ratings(p_return_id text)
returns table (
  rater_user_id text,
  rated_user_id text,
  score integer,
  created_at text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_return_id text := btrim(coalesce(p_return_id, ''));
  v_return record;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select s.id, s.lost_owner_user_id, s.helper_user_id
    into v_return
    from public.successful_returns s
   where s.id = v_return_id;

  if not found then
    raise exception 'Recovery not found' using errcode = 'P0002';
  end if;

  if v_return.lost_owner_user_id is distinct from v_uid
     and v_return.helper_user_id is distinct from v_uid then
    raise exception 'Only the people in this recovery can read its ratings' using errcode = '42501';
  end if;

  return query
  select r.rater_user_id, r.rated_user_id, r.score, r.created_at
    from public.return_ratings r
   where r.successful_return_id = v_return.id
   order by r.created_at asc, r.id asc;
end;
$$;

revoke all on function public.findback_return_ratings(text) from public, anon;
grant execute on function public.findback_return_ratings(text) to authenticated;

comment on function public.findback_return_ratings(text) is
  'FindBack recovery ratings (definer, participant-only): both directions for one recovery, for its two participants. An unrelated caller gets 42501, exactly as the writer does.';


-- ===========================================================================
-- 5. DERIVED STANDING, TIER AND LIMITS (D28, D29) — never stored.
-- ===========================================================================
--
-- There is NO reputation column, NO tier column, NO counters table. Every
-- value below is computed from rows that already exist:
--
--   standing  <- account_sanctions (the history table the moderation lane owns)
--   tier      <- return_ratings (about the user) + the serious part of standing
--   limits    <- standing + tier, counted from item_posts / comments
--
-- Deriving all three in ONE place is what keeps "an active sanction overrides
-- trust presentation" a rule instead of a view-layer patch: the tier function
-- asks the same sanction helper the standing function asks.

-- The effective sanction kind, internal. One query, one precedence.
--
-- An active row is one that is not revoked, has started, and has not ended.
-- `active` is the writer's flag; revoked_at and ends_at are checked as well so
-- a writer that forgot to flip `active` cannot keep a sanction alive.
create or replace function public.findback_active_sanction_kind(p_user text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
begin
  select s.kind
    into v_kind
    from public.account_sanctions s
   where s.user_id = p_user
     and s.active
     and s.revoked_at is null
     and (nullif(btrim(s.starts_at), '') is null
          or nullif(btrim(s.starts_at), '')::timestamptz <= now())
     and (nullif(btrim(s.ends_at), '') is null
          or nullif(btrim(s.ends_at), '')::timestamptz > now())
   order by case s.kind
              when 'BANNED' then 4
              when 'SUSPENDED' then 3
              when 'RESTRICTED' then 2
              when 'PROBATION' then 1
              else 0
            end desc,
            s.created_at desc
   limit 1;

  return v_kind;
end;
$$;

revoke all on function public.findback_active_sanction_kind(text) from public, anon, authenticated;

comment on function public.findback_active_sanction_kind(text) is
  'FindBack effective sanction (definer, internal): the most serious ACTIVE sanction kind for a user, or NULL. Consumes the moderation lane''s account_sanctions history table; it never writes one.';

-- The effective standing (10:156-162), subject-only.
--
--   GOOD / PROBATION / RESTRICTED / SUSPENDED / BANNED
--
-- A WARNING is a note, not a standing. The parameter defaults to the caller so
-- the client can ask "my standing" with no argument; naming somebody ELSE is
-- refused with 42501, because standing is shown to its subject only
-- (10:163-167) — never as an internal flag to others.
create or replace function public.findback_standing(p_user text default null)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_subject text := btrim(coalesce(p_user, ''));
  v_kind text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_subject = '' then
    v_subject := v_uid;
  end if;

  if v_subject <> v_uid then
    raise exception 'Standing is visible only to the account it describes' using errcode = '42501';
  end if;

  v_kind := public.findback_active_sanction_kind(v_subject);

  return case v_kind
    when 'BANNED' then 'BANNED'
    when 'SUSPENDED' then 'SUSPENDED'
    when 'RESTRICTED' then 'RESTRICTED'
    when 'PROBATION' then 'PROBATION'
    else 'GOOD'
  end;
end;
$$;

revoke all on function public.findback_standing(text) from public, anon;
grant execute on function public.findback_standing(text) to authenticated;

comment on function public.findback_standing(text) is
  'FindBack effective standing (definer, stable, subject-only): GOOD / PROBATION / RESTRICTED / SUSPENDED / BANNED, derived from account_sanctions at call time. Naming another account is 42501. A WARNING is a note, not a standing.';

-- The reputation tier (10:133-138), DERIVED.
--
--   TRUSTED — at least 5 ratings, average >= 4.0, and no active serious
--             sanction (RESTRICTED / SUSPENDED / BANNED);
--   NORMAL  — at least 5 ratings, any average;
--   NEW     — fewer than 5 ratings, or a serious sanction is active.
--
-- Only a LABEL is returned: there is no numeric score to display anywhere
-- (10:145-148). PROBATION and WARNING do not erase trust here — they already
-- cap the interaction limit, which is where their cost belongs.
create or replace function public.findback_reputation_tier(p_user text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user text := btrim(coalesce(p_user, ''));
  v_kind text;
  v_count integer;
  v_avg numeric;
begin
  if v_user = '' then
    raise exception 'A user is required' using errcode = '22023';
  end if;

  v_kind := public.findback_active_sanction_kind(v_user);

  if v_kind in ('RESTRICTED', 'SUSPENDED', 'BANNED') then
    return 'NEW';
  end if;

  select count(*), coalesce(avg(r.score), 0)
    into v_count, v_avg
    from public.return_ratings r
   where r.rated_user_id = v_user;

  if v_count >= 5 and v_avg >= 4.0 then
    return 'TRUSTED';
  end if;

  if v_count >= 5 then
    return 'NORMAL';
  end if;

  return 'NEW';
end;
$$;

revoke all on function public.findback_reputation_tier(text) from public, anon;
grant execute on function public.findback_reputation_tier(text) to authenticated;

comment on function public.findback_reputation_tier(text) is
  'FindBack reputation tier (definer, stable, DERIVED): NEW / NORMAL / TRUSTED from return_ratings plus the serious part of standing. No stored score and no tier column exist; an active serious sanction returns NEW in the same derivation.';

-- The posting/commenting limit (D29), DERIVED from standing + tier.
--
--   NEW      3 per UTC day, 120 s cooldown
--   NORMAL   base (5),       90 s
--   TRUSTED  2 x base (10),  60 s
--   PROBATION 1,            120 s
--   RESTRICTED / SUSPENDED / BANNED: 0 (every write refused)
--
-- The count is a QUERY over the authoritative rows — one indexed aggregate per
-- write — never a counter table that can drift or need a reset job.
create or replace function public.findback_post_limit()
returns table (limit_per_day integer, burst_cooldown_seconds integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_base integer := public.findback_base_interaction_limit();
  v_standing text;
  v_tier text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  v_standing := public.findback_standing(v_uid);

  if v_standing in ('RESTRICTED', 'SUSPENDED', 'BANNED') then
    return query select 0, 0;
    return;
  end if;

  if v_standing = 'PROBATION' then
    return query select 1, 120;
    return;
  end if;

  v_tier := public.findback_reputation_tier(v_uid);

  if v_tier = 'TRUSTED' then
    return query select v_base * 2, 60;
    return;
  end if;

  if v_tier = 'NORMAL' then
    return query select v_base, 90;
    return;
  end if;

  return query select 3, 120;
end;
$$;

revoke all on function public.findback_post_limit() from public, anon;
grant execute on function public.findback_post_limit() to authenticated;

comment on function public.findback_post_limit() is
  'FindBack interaction limit (definer, stable, DERIVED): (limit_per_day, burst_cooldown_seconds) from the caller''s standing and tier. 0 means every write is refused. Enforced by the BEFORE INSERT guard on item_posts and comments.';

-- The enforcement itself (D29).
--
-- A BEFORE INSERT guard on the two tables where a post and a comment actually
-- land, rather than a copy of the limit branch inside every caller: the
-- create-post RPCs, the comment RPCs and any future writer are covered by ONE
-- implementation, and none of them can forget it. The guard reads item_posts
-- and comments DIRECTLY, never the visibility view, so the caller's own history
-- counts regardless of blocks and regardless of moderation (D29's critical
-- detail): a block must never be able to suppress a limit, and a hidden post
-- still counts.
--
-- Only a signed-in author's OWN row is capped. Migrations, seeds, service-role
-- repair and moderation writes run without auth.uid() (or write somebody
-- else's row) and are never blocked.

-- The daily count runs once per own write, so it needs a (user_id, created_at)
-- path on BOTH tables (D29). Additive, no rewrite; `item_posts` already has a
-- bare (user_id) index, `comments` has none, so without the second one every
-- comment insert would scan the table.
create index if not exists ix_item_posts_user_created
  on public.item_posts (user_id, created_at);
create index if not exists ix_comments_user_created
  on public.comments (user_id, created_at);
create or replace function public.findback_enforce_interaction_limit()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_limit integer;
  v_cooldown integer;
  v_count integer;
  v_last text;
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
begin
  if v_uid is null or new.user_id is distinct from v_uid then
    return new;
  end if;

  select l.limit_per_day, l.burst_cooldown_seconds
    into v_limit, v_cooldown
    from public.findback_post_limit() l;

  if v_limit <= 0 then
    raise exception 'POST_LIMIT_REACHED: your account cannot post or comment right now' using errcode = 'P0001';
  end if;

  if tg_table_name = 'item_posts' then
    select count(*), max(p.created_at)
      into v_count, v_last
      from public.item_posts p
     where p.user_id = v_uid
       and nullif(btrim(p.created_at), '')::timestamptz >= v_day_start;
  else
    select count(*), max(c.created_at)
      into v_count, v_last
      from public.comments c
     where c.user_id = v_uid
       and nullif(btrim(c.created_at), '')::timestamptz >= v_day_start;
  end if;

  if v_count >= v_limit then
    raise exception 'POST_LIMIT_REACHED: you have reached today''s limit of %', v_limit using errcode = 'P0001';
  end if;

  if v_cooldown > 0 and v_last is not null
     and nullif(btrim(v_last), '')::timestamptz > now() - make_interval(secs => v_cooldown) then
    raise exception 'POST_COOLDOWN: wait % seconds before posting again', v_cooldown using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.findback_enforce_interaction_limit() from public, anon, authenticated;

comment on function public.findback_enforce_interaction_limit() is
  'FindBack interaction limit guard (definer, internal trigger): refuses an author''s own INSERT into item_posts/comments when the self-derived limit is spent (P0001 POST_LIMIT_REACHED) or the cooldown is live (P0001 POST_COOLDOWN). Reads the base tables directly, never the visibility view.';

drop trigger if exists trg_findback_item_posts_interaction_limit on public.item_posts;
create trigger trg_findback_item_posts_interaction_limit
  before insert on public.item_posts
  for each row execute function public.findback_enforce_interaction_limit();

drop trigger if exists trg_findback_comments_interaction_limit on public.comments;
create trigger trg_findback_comments_interaction_limit
  before insert on public.comments
  for each row execute function public.findback_enforce_interaction_limit();


-- ===========================================================================
-- 6. FEEDBACK (D30–D33).
-- ===========================================================================
--
-- Constraints on the FEEDBACK channel:
--   * the category is a CLOSED vocabulary (four values, 10:384-387);
--   * the message is 1–2000 characters;
--   * the technical context is assembled SERVER-side from named scalars — there
--     is no jsonb parameter anywhere, so a client cannot smuggle a log, a token
--     or a free-text blob into a support queue (10:401-406);
--   * the user sees their own STATUS only; message, technical_context and
--     admin_note are outside the grant (D32);
--   * account deletion deletes the row: ON DELETE CASCADE, and nothing else is
--     derived from it, so there is no aggregate to retain (D33).
create table if not exists public.feedback (
  id                     text primary key,
  user_id                text not null references public.users(id) on delete cascade,
  category               text not null,
  message                text not null,
  include_technical_info boolean not null default false,
  technical_context      jsonb null,
  status                 text not null default 'NEW',
  admin_note             text null,
  created_at             text not null,
  updated_at             text not null,
  constraint feedback_category_check
    check (category in ('BUG', 'SUGGESTION', 'USABILITY', 'OTHER')),
  constraint feedback_message_check
    check (char_length(btrim(message)) between 1 and 2000),
  constraint feedback_status_check
    check (status in ('NEW', 'REVIEWING', 'RESOLVED')),
  -- Structural second line for D31: no context unless the user asked for it.
  constraint feedback_technical_context_check
    check (include_technical_info or technical_context is null)
);

create index if not exists ix_feedback_user_created
  on public.feedback (user_id, created_at);

alter table public.feedback enable row level security;

revoke all on table public.feedback from public, anon, authenticated;

-- D32: exactly five columns. `message` and `technical_context` are deliberately
-- NOT granted — the user's own submitted text is already in their local state,
-- and a support queue is not a second copy for the client to re-read. admin_note
-- is excluded by absence of grant, which is what "never visible through
-- ordinary user select" means in PostgreSQL.
grant select (id, category, status, created_at, updated_at)
  on public.feedback to authenticated;

drop policy if exists feedback_select_own on public.feedback;
create policy feedback_select_own
  on public.feedback
  for select
  to authenticated
  using (user_id = (select auth.uid())::text);

comment on table public.feedback is
  'FindBack feedback (MC D30–D33): one row per submission, closed category vocabulary, server-assembled technical context, own-status reads only. Deleted with the account; no aggregate is retained.';

-- Submit feedback. D31.
--
-- The four optional scalars are BOUNDED here and assembled here. The RPC has no
-- jsonb parameter; a must-fail fixture asserts the argument list.
--
-- The rate limit is 2 x the base interaction limit (owner decision O3), counted
-- from this table for the UTC day. It is a product throttle, not a security
-- boundary: two concurrent submissions inside one transaction window can both
-- pass, which is accepted and recorded in the handoff.
create or replace function public.findback_submit_feedback(
  p_category text,
  p_message text,
  p_include_technical_info boolean,
  p_app_version text default null,
  p_platform text default null,
  p_screen text default null,
  p_device_class text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_category text := upper(btrim(coalesce(p_category, '')));
  v_message text := btrim(coalesce(p_message, ''));
  v_app_version text := nullif(btrim(coalesce(p_app_version, '')), '');
  v_platform text := nullif(btrim(coalesce(p_platform, '')), '');
  v_screen text := nullif(btrim(coalesce(p_screen, '')), '');
  v_device_class text := nullif(btrim(coalesce(p_device_class, '')), '');
  v_technical boolean := coalesce(p_include_technical_info, false);
  v_context jsonb;
  v_limit integer;
  v_count integer;
  v_id text := gen_random_uuid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
begin
  -- The entry point is behind auth in v1 (10:377-380) and user_id is NOT NULL,
  -- so an anonymous submission has no row to belong to: refused, not stored
  -- against nobody.
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_category not in ('BUG', 'SUGGESTION', 'USABILITY', 'OTHER') then
    raise exception 'Unknown feedback category' using errcode = '22023';
  end if;

  if char_length(v_message) < 1 or char_length(v_message) > 2000 then
    raise exception 'Feedback must be between 1 and 2000 characters' using errcode = '22023';
  end if;

  -- Every named scalar has an explicit bound. An unbounded string is a blob
  -- with a friendlier name.
  if char_length(coalesce(v_app_version, '')) > 40 then
    raise exception 'App version is too long' using errcode = '22023';
  end if;
  if char_length(coalesce(v_platform, '')) > 30 then
    raise exception 'Platform is too long' using errcode = '22023';
  end if;
  if char_length(coalesce(v_screen, '')) > 80 then
    raise exception 'Screen is too long' using errcode = '22023';
  end if;
  if char_length(coalesce(v_device_class, '')) > 40 then
    raise exception 'Device class is too long' using errcode = '22023';
  end if;

  -- 2 x base (owner decision O3).
  v_limit := 2 * public.findback_base_interaction_limit();

  select count(*)
    into v_count
    from public.feedback f
   where f.user_id = v_uid
     and nullif(btrim(f.created_at), '')::timestamptz >= v_day_start;

  if v_count >= v_limit then
    raise exception 'FEEDBACK_LIMIT_REACHED: you have reached today''s feedback limit' using errcode = 'P0001';
  end if;

  -- Server-assembled. captured_at is the server's instant, never the client's;
  -- a null scalar is omitted rather than stored as an empty string.
  if v_technical then
    v_context := jsonb_strip_nulls(jsonb_build_object(
      'captured_at', v_now,
      'app_version', v_app_version,
      'platform', v_platform,
      'screen', v_screen,
      'device_class', v_device_class
    ));
  else
    v_context := null;
  end if;

  insert into public.feedback (
    id, user_id, category, message, include_technical_info, technical_context,
    status, admin_note, created_at, updated_at
  ) values (
    v_id, v_uid, v_category, v_message, v_technical, v_context,
    'NEW', null, v_now, v_now
  );

  return v_id;
end;
$$;

revoke all on function public.findback_submit_feedback(text, text, boolean, text, text, text, text) from public, anon;
grant execute on function public.findback_submit_feedback(text, text, boolean, text, text, text, text) to authenticated;

comment on function public.findback_submit_feedback(text, text, boolean, text, text, text, text) is
  'FindBack feedback writer (definer, D31): stores one feedback row with a closed category, a 1–2000 character message and a SERVER-assembled technical_context from four bounded named scalars (there is no jsonb parameter). Captured at the server clock. Limited to 2 x the base interaction limit per UTC day (P0001 FEEDBACK_LIMIT_REACHED).';

comment on table public.return_ratings is
  'FindBack return ratings (MC D26): one rating per DIRECTION per recovery, participants only, self impossible (derived counterpart + CHECK). No client table grant: reads via findback_return_ratings(), writes via findback_rate_return().';

-- ---------------------------------------------------------------------------
-- 7. Ownership notes for the reviewer.
-- ---------------------------------------------------------------------------
-- Nothing here re-creates a shipped object: the block table and its readers are
-- untouched, the legacy ratings freeze already landed (20261021162730), and no
-- counter table, no reputation column and no case-management table was added.

commit;
