-- Verification for 20261023020000_trust_blocks_feedback_recovery.sql (block /
-- unblock writes, the durable recovery row, participant return ratings, the
-- DERIVED tier / standing / limits, and feedback).
--
-- STATUS, STATED PLAINLY. This migration has NOT been applied to the hosted
-- project. Nothing in this file may be quoted as a passing result until it has
-- been run on a disposable PostgreSQL and its output recorded.
--
-- HOW TO RUN IT.
--
--   PGHOST=127.0.0.1 PGDATABASE=findback_sql_test \
--     node scripts/sql-behavior.mjs --apply-chain \
--       --probe supabase/tests/verify_20261023020000_trust_blocks_feedback_recovery.sql
--
-- Section 1 is read-only catalog/source probes. Section 2 writes scratch rows
-- as `authenticated` and `anon` with a LOCAL JWT subject claim
-- (`set_config(..., true)`), so run it on a DISPOSABLE PostgreSQL only, inside
-- the transaction this file opens and ROLLBACKs.
--
-- EVERY PROBE IS AN ASSERTION. A state probe is a SELECT that returns exactly
-- one row when the property holds and zero rows otherwise (the runner's `\gset`
-- makes zero rows fatal). A must-fail probe is a DO block that calls the
-- operation, CATCHES the expected refusal, and raises a NAMED exception if the
-- operation succeeded or refused with the wrong reason (a refusal raised in a
-- transaction aborts it, so every call is caught in its own block).
--
-- The must-fail half, explicitly:
--   B1  anon → 42501 on every trust surface (block, unblock, my blocks, rate,
--       submit feedback, read feedback)
--   B3  the block DIRECTION is not discoverable: the blocked party's own list is
--       empty, the symmetric reader is caller-scoped, the table is closed
--   B4  a ONE-SIDED unblock leaves the mutual effect in force (D22)
--   R2  a second recovery of the same report → 23505
--   R3  a non-owner marks somebody else's report recovered → 42501
--   T1  a non-participant rates a recovery → 42501
--   T2  a self/private recovery has no counterpart to rate → 22023, and a
--       direct self-rating row violates the CHECK
--   T3  a second rating in the SAME direction → 23505
--   F3  an empty or whitespace-only message → 22023
--   F4  a category outside the closed vocabulary → 22023
--   F5  the author cannot read message / technical_context / admin_note
--   F7  the daily feedback ceiling refuses the next submission
--   S3  a Probation account's second same-day post → POST_LIMIT_REACHED (spent day)
--   S4  a Restricted/Suspended account's FIRST post → POST_NOT_AVAILABLE (standing,
--       not a spent day: the two causes were one word until review R3 F-1)
--   S5  two posts inside the cooldown window → POST_COOLDOWN

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog and source probes.
-- ---------------------------------------------------------------------------

-- P1. The three new tables exist and carry RLS; user_blocks is unchanged.
select 'P1 the four tables exist with RLS' as probe
where 4 = (
  select count(*) from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('successful_returns', 'return_ratings', 'feedback', 'user_blocks')
    and c.relrowsecurity
);

-- P2. No client role holds a table privilege on the participant-only tables,
--     and user_blocks still has NONE (D18's grant rule).
select 'P2 block/recovery/rating tables are ungranted' as probe
where not exists (
  select 1
  from information_schema.role_table_grants g
  where g.table_schema = 'public'
    and g.table_name in ('user_blocks', 'successful_returns', 'return_ratings')
    and g.grantee in ('anon', 'authenticated', 'PUBLIC')
);

-- P3. user_blocks still has ZERO policies: no policy is not access, and no
--     access is not a policy.
select 'P3 user_blocks has zero policies' as probe
where 0 = (
  select count(*) from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'user_blocks'
);

-- P4. feedback grants exactly five columns to authenticated and nothing to
--     anon; message, technical_context, admin_note and user_id are absent.
select 'P4 feedback grants own status columns only' as probe
where (
  select array_agg(g.column_name::text order by g.column_name)
  from information_schema.column_privileges g
  where g.table_schema = 'public' and g.table_name = 'feedback'
    and g.grantee = 'authenticated' and g.privilege_type = 'SELECT'
) = array['category', 'created_at', 'id', 'status', 'updated_at']
and not exists (
  select 1 from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.table_name = 'feedback'
    and g.grantee in ('anon', 'PUBLIC')
)
and not exists (
  select 1 from information_schema.column_privileges g
  where g.table_schema = 'public' and g.table_name = 'feedback'
    and g.grantee in ('anon', 'authenticated', 'PUBLIC')
    and g.column_name in ('message', 'technical_context', 'admin_note', 'user_id')
);

-- P5. Every new function is SECURITY DEFINER (except the immutable base limit,
--     which reads nothing), has a LOCKED search_path, and carries a comment.
select 'P5 functions are definer, path-locked and commented' as probe
where 13 = (
  select count(*)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'findback_base_interaction_limit', 'findback_block_user', 'findback_unblock_user',
      'findback_mark_recovered', 'findback_my_recoveries', 'findback_rate_return',
      'findback_return_ratings', 'findback_active_sanction_kind', 'findback_standing',
      'findback_reputation_tier', 'findback_post_limit',
      'findback_enforce_interaction_limit', 'findback_submit_feedback'
    )
    and (p.prosecdef or p.proname = 'findback_base_interaction_limit')
    and exists (
      select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
      where cfg like 'search_path=%'
    )
    and obj_description(p.oid, 'pg_proc') is not null
);

-- P6. The internal helpers are not executable by any client role, and the
--     public surfaces are not executable by anon.
select 'P6 internal helpers revoked, anon refused' as probe
where not exists (
  select 1
  from information_schema.role_routine_grants g
  where g.routine_schema = 'public'
    and g.routine_name in ('findback_active_sanction_kind', 'findback_enforce_interaction_limit')
    and g.grantee in ('anon', 'authenticated', 'PUBLIC')
)
and not exists (
  select 1
  from information_schema.role_routine_grants g
  where g.routine_schema = 'public'
    and g.routine_name in (
      'findback_base_interaction_limit',
      'findback_block_user', 'findback_unblock_user', 'findback_mark_recovered',
      'findback_my_recoveries', 'findback_rate_return', 'findback_return_ratings',
      'findback_standing', 'findback_reputation_tier', 'findback_post_limit',
      'findback_submit_feedback'
    )
    and g.grantee in ('anon', 'PUBLIC')
);

-- P7. The rating writer takes NO rated-user parameter, and the feedback writer
--     accepts NO jsonb (a client blob is structurally impossible).
select 'P7 rate_return has two args, submit_feedback has no jsonb' as probe
where (
  select p.pronargs
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_rate_return'
) = 2
and (
  select p.pronargs
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_submit_feedback'
) = 7
and not exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join unnest(p.proargtypes) as a(oid)
  join pg_type t on t.oid = a.oid
  where n.nspname = 'public'
    and p.proname in ('findback_rate_return', 'findback_submit_feedback', 'findback_mark_recovered')
    and t.typname = 'jsonb'
);

-- P8. D26's shape: the unique key is per DIRECTION, self is excluded by a
--     CHECK, and the score is bounded.
select 'P8 return_ratings shape (direction uniqueness + self CHECK)' as probe
where exists (
  select 1 from pg_constraint c
  where c.conrelid = 'public.return_ratings'::regclass
    and c.contype = 'u'
    and c.conkey = array[
      (select a.attnum from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'successful_return_id'),
      (select a.attnum from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'rater_user_id'),
      (select a.attnum from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'rated_user_id')
    ]::smallint[]
)
and exists (
  select 1 from pg_constraint c
  where c.conrelid = 'public.return_ratings'::regclass
    and c.conname = 'return_ratings_self_check'
    and pg_get_constraintdef(c.oid) like '%rater_user_id IS DISTINCT FROM rated_user_id%'
);

-- P9. One recovery per lost report (the duplicate-recovery rule).
select 'P9 successful_returns is unique per lost report' as probe
where exists (
  select 1 from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where i.indrelid = 'public.successful_returns'::regclass
    and i.indisunique
    and c.relname = 'ux_successful_returns_lost_post'
);

-- P10. The closed feedback vocabulary and the three statuses are CHECKs on the
--      table itself, not only in the RPC.
select 'P10 feedback vocabulary and status CHECKs' as probe
where (
  select pg_get_constraintdef(c.oid)
  from pg_constraint c
  where c.conrelid = 'public.feedback'::regclass and c.conname = 'feedback_category_check'
) like '%BUG%SUGGESTION%USABILITY%OTHER%'
and (
  select pg_get_constraintdef(c.oid)
  from pg_constraint c
  where c.conrelid = 'public.feedback'::regclass and c.conname = 'feedback_status_check'
) like '%NEW%REVIEWING%RESOLVED%'
and (
  select pg_get_constraintdef(c.oid)
  from pg_constraint c
  where c.conrelid = 'public.feedback'::regclass and c.conname = 'feedback_technical_context_check'
) is not null;

-- P11. There is NO stored reputation: no score/tier/counter column anywhere,
--      and the only admin_note column is feedback's own.
select 'P11 nothing derived was stored' as probe
where not exists (
  select 1 from information_schema.columns c
  where c.table_schema = 'public'
    and c.column_name in ('reputation', 'reputation_tier', 'trust_score', 'trust_tier', 'post_count_today')
)
and 1 = (
  select count(*) from information_schema.columns c
  where c.table_schema = 'public' and c.column_name = 'admin_note'
)
and 0 = (
  select count(*) from information_schema.tables t
  where t.table_schema = 'public' and t.table_name like '%feedback%aggregate%'
);

-- P12. The limit guard is installed on BOTH write tables, BEFORE INSERT, and it
--      reads item_posts/comments directly — never the visibility view (D29's
--      critical detail: a block must not be able to suppress a limit).
select 'P12 limit triggers are installed on both tables' as probe
where 2 = (
  select count(*) from pg_trigger t
  where not t.tgisinternal
    and t.tgrelid in ('public.item_posts'::regclass, 'public.comments'::regclass)
    and t.tgname in ('trg_findback_item_posts_interaction_limit', 'trg_findback_comments_interaction_limit')
    and (t.tgtype & 2) = 2   -- BEFORE
    and (t.tgtype & 4) = 4   -- INSERT
)
and (
  select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_enforce_interaction_limit'
) not like '%findback_visible_posts%';

-- P13. The legacy per-post rating writes are still frozen (D27 landed in
--      20261021162730): the insert policy is absent.
select 'P13 the legacy ratings insert policy is absent' as probe
where not exists (
  select 1 from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'ratings' and p.policyname = 'ratings_insert_own'
);

-- P14. The guard's daily count has a (user_id, created_at) path on BOTH tables
--      (D29): without the comments index every comment insert would scan.
select 'P14 the limit count is indexed on both tables' as probe
where 2 = (
  select count(*) from pg_indexes i
  where i.schemaname = 'public'
    and i.tablename in ('item_posts', 'comments')
    and i.indexdef like '%(user_id, created_at)%'
);

-- ---------------------------------------------------------------------------
-- Fixture: the moderation lane's sanction table.
-- ---------------------------------------------------------------------------
-- public.account_sanctions is B2b's object (WORK-ORDER-CF060-B2b §2.2). This
-- migration CONSUMES it and must sort AFTER it. In a chain where the moderation
-- lane has landed, the table exists and this block is a NO-OP. In a chain
-- without it, the block creates the CONTRACT shape so the derivation probes can
-- execute at all. It is a fixture, not a second owner: it is never created by
-- migration 20261023020000, never modified by it, and the coordinator reconciles
-- the two lanes at integration.
--
-- The fixture MIRRORS the real table's columns and CHECK vocabularies exactly
-- (kind, reason_code), so a probe row written here is legal against BOTH the
-- fixture and the moderation lane's real table: the same file proves the same
-- thing in either chain. The real table also defaults id; the fixture requires
-- it, which no probe depends on.
do $$
begin
  if to_regclass('public.account_sanctions') is null then
    create table public.account_sanctions (
      id             text primary key,
      user_id        text not null references public.users(id) on delete cascade,
      kind           text not null
        constraint account_sanctions_kind_check
        check (kind in ('WARNING', 'PROBATION', 'RESTRICTED', 'SUSPENDED', 'BANNED')),
      starts_at      text not null,
      ends_at        text null,
      reason_code    text not null
        constraint account_sanctions_reason_code_check
        check (reason_code in (
          'SCAM_OR_MISLEADING',
          'SPAM_OR_DUPLICATE',
          'HARASSMENT',
          'INAPPROPRIATE_CONTENT',
          'PRIVATE_INFORMATION',
          'SUSPECTED_STOLEN_OR_ILLEGAL',
          'OTHER'
        )),
      moderator_note text null,
      active         boolean not null default true,
      created_by     text null,
      created_at     text not null,
      revoked_at     text null,
      revoked_by     text null
    );
    raise notice 'fixture: account_sanctions created from MC D28 — the sanction-consumption path below runs against THIS fixture, not against the moderation lane''s real table';
  else
    raise notice 'account_sanctions already present: the moderation lane''s table, or this file''s fixture from an earlier run on this database';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Behavioural probes (DISPOSABLE PostgreSQL only; wrapped in ROLLBACK).
-- ---------------------------------------------------------------------------
begin;

insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, avatar_url, created_at, updated_at)
values
  ('10000000-0000-4000-8000-000000000001', 'trust_owner',    'trust_owner@example.invalid',    '+8801700000001', 'x', 1, 0, null, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('10000000-0000-4000-8000-000000000002', 'trust_helper',   'trust_helper@example.invalid',   '+8801700000002', 'x', 1, 0, null, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('10000000-0000-4000-8000-000000000003', 'trust_stranger', 'trust_stranger@example.invalid', '+8801700000003', 'x', 1, 0, null, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('10000000-0000-4000-8000-000000000004', 'trust_feedback', 'trust_feedback@example.invalid', '+8801700000004', 'x', 1, 0, null, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('10000000-0000-4000-8000-000000000005', 'trust_probe',    'trust_probe@example.invalid',    '+8801700000005', 'x', 1, 0, null, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('10000000-0000-4000-8000-000000000006', 'trust_limited',  'trust_limited@example.invalid',  '+8801700000006', 'x', 1, 0, null, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('10000000-0000-4000-8000-000000000007', 'trust_other',    'trust_other@example.invalid',    '+8801700000007', 'x', 1, 0, null, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
on conflict (id) do nothing;

-- Posts. Fixtures are written with NO JWT subject, so the limit guard is not
-- armed for them (the guard caps a signed-in author's own writes only).
insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'LOST', 'owner lost phone',   'desc', 'Electronics', 'OPEN', '2026-10-01',
   to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'LOST', 'owner lost wallet',  'desc', 'Accessories', 'OPEN', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'LOST', 'stranger item 1',    'desc', 'Other',       'OPEN', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', 'LOST', 'stranger item 2',    'desc', 'Other',       'OPEN', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000003', 'LOST', 'stranger item 3',    'desc', 'Other',       'OPEN', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000003', 'LOST', 'stranger item 4',    'desc', 'Other',       'OPEN', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000003', 'LOST', 'stranger self item', 'desc', 'Other',       'OPEN', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000001', 'LOST', 'owner third item',   'desc', 'Other',       'OPEN', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
on conflict (id) do nothing;

-- The NEW-tier ceiling probe: three posts TODAY by trust_limited.
insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
select
  '20000000-0000-4000-8000-00000000010' || g,
  '10000000-0000-4000-8000-000000000006',
  'LOST', 'limited item ' || g, 'desc', 'Other', 'OPEN', '2026-10-01',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
from generate_series(1, 3) g
on conflict (id) do nothing;

-- ===========================================================================
-- 2A. Block / unblock (D16–D18, D22).
-- ===========================================================================

-- B1. ANON is refused with 42501 by every trust surface.
set local role anon;
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  begin
    perform public.findback_block_user('10000000-0000-4000-8000-000000000002');
    raise exception 'B1a FAILED: anon blocked a user';
  exception when insufficient_privilege then
    raise notice 'B1a ok: anon refused the block with 42501';
  end;

  begin
    perform public.findback_unblock_user('10000000-0000-4000-8000-000000000002');
    raise exception 'B1b FAILED: anon unblocked a user';
  exception when insufficient_privilege then
    raise notice 'B1b ok: anon refused the unblock with 42501';
  end;

  begin
    perform public.findback_my_blocks();
    raise exception 'B1c FAILED: anon read a block list';
  exception when insufficient_privilege then
    raise notice 'B1c ok: anon refused the block list with 42501';
  end;

  begin
    perform public.findback_is_blocked_with_me('10000000-0000-4000-8000-000000000002');
    raise exception 'B1d FAILED: anon read the block bit';
  exception when insufficient_privilege then
    raise notice 'B1d ok: anon refused the block bit with 42501';
  end;

  begin
    perform public.findback_rate_return('any', 5);
    raise exception 'B1e FAILED: anon rated a recovery';
  exception when insufficient_privilege then
    raise notice 'B1e ok: anon refused the rating with 42501';
  end;

  begin
    perform public.findback_submit_feedback('BUG', 'hello', false);
    raise exception 'B1f FAILED: anon submitted feedback';
  exception when insufficient_privilege then
    raise notice 'B1f ok: anon refused the feedback writer with 42501';
  end;

  begin
    perform count(*) from public.feedback;
    raise exception 'B1g FAILED: anon read the feedback table';
  exception when insufficient_privilege then
    raise notice 'B1g ok: anon refused the feedback table with 42501';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- B2. The ACT is one-sided, the EFFECT is mutual. u1 blocks u2.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select public.findback_block_user('10000000-0000-4000-8000-000000000002') as block_call;
select public.findback_block_user('10000000-0000-4000-8000-000000000002') as block_again;   -- idempotent

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'B2a one row, whichever way the tap landed twice' as probe
where 1 = (
  select count(*) from public.user_blocks
  where blocker_user_id = '10000000-0000-4000-8000-000000000001'
    and blocked_user_id = '10000000-0000-4000-8000-000000000002'
);

-- B2b. Both parties see the MUTUAL effect (the same bit, one call each).
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
begin
  if public.findback_is_blocked_with_me('10000000-0000-4000-8000-000000000002') is not true then
    raise exception 'B2b FAILED: the blocker does not see the mutual effect';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
do $$
begin
  if public.findback_is_blocked_with_me('10000000-0000-4000-8000-000000000001') is not true then
    raise exception 'B2c FAILED: the blocked party does not see the mutual effect';
  end if;
end;
$$;

-- B3. The DIRECTION is not discoverable.
do $$
declare
  v_count integer;
begin
  -- The blocked party's OWN outgoing list is empty: B did not block A.
  select count(*) into v_count from public.findback_my_blocks();
  if v_count <> 0 then
    raise exception 'B3a FAILED: the blocked party''s own list is not empty (% rows)', v_count;
  end if;

  -- ... and the table itself is closed to every client role.
  begin
    perform count(*) from public.user_blocks;
    raise exception 'B3b FAILED: a client role read user_blocks directly';
  exception when insufficient_privilege then
    raise notice 'B3b ok: user_blocks refused the client read with 42501';
  end;

  -- The symmetric two-party predicate is internal: a caller cannot ask about
  -- a pair it is not part of, so there is no inverse oracle.
  begin
    perform public.findback_is_blocked_pair('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002');
    raise exception 'B3c FAILED: the internal pair predicate is callable by a client';
  exception when insufficient_privilege then
    raise notice 'B3c ok: the pair predicate is internal (42501)';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'B3 the direction is not in any client-readable surface' as probe
where 1 = (
  select count(*) from public.user_blocks
  where blocker_user_id = '10000000-0000-4000-8000-000000000001'
)
and 0 = (
  select count(*) from public.user_blocks
  where blocker_user_id = '10000000-0000-4000-8000-000000000002'
);

-- B4. D22 — a ONE-SIDED unblock leaves the mutual effect in force.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select public.findback_block_user('10000000-0000-4000-8000-000000000001') as second_direction;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
declare
  v_still boolean;
begin
  v_still := public.findback_unblock_user('10000000-0000-4000-8000-000000000002');
  if v_still is not true then
    raise exception 'B4a FAILED: a one-sided unblock claimed the pair was restored';
  end if;
  if public.findback_is_blocked_with_me('10000000-0000-4000-8000-000000000002') is not true then
    raise exception 'B4b FAILED: a one-sided unblock cleared the mutual effect';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'B4 the other direction survived the caller''s unblock' as probe
where 1 = (
  select count(*) from public.user_blocks
  where blocker_user_id = '10000000-0000-4000-8000-000000000002'
    and blocked_user_id = '10000000-0000-4000-8000-000000000001'
);

-- B5. Both directions gone restores mutual visibility.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
do $$
declare
  v_still boolean;
begin
  v_still := public.findback_unblock_user('10000000-0000-4000-8000-000000000001');
  if v_still is not false then
    raise exception 'B5 FAILED: the second unblock did not report the pair restored';
  end if;
  if public.findback_is_blocked_with_me('10000000-0000-4000-8000-000000000001') is not false then
    raise exception 'B5 FAILED: the pair is still hidden after both directions went';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'B5 both directions gone, no rows left' as probe
where 0 = (select count(*) from public.user_blocks);

-- ===========================================================================
-- 2B. Recovery (D25) and ratings (D26, D23).
-- ===========================================================================

-- R1. The owner marks the lost report recovered with a FindBack helper.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
declare
  v_id text;
begin
  v_id := public.findback_mark_recovered(
    '20000000-0000-4000-8000-000000000001', 'FINDBACK_USER', '10000000-0000-4000-8000-000000000002'
  );
  if v_id is null or v_id = '' then
    raise exception 'R1 FAILED: the recovery returned no row id';
  end if;

  -- R2. A second recovery of the same report is refused.
  begin
    perform public.findback_mark_recovered(
      '20000000-0000-4000-8000-000000000001', 'FINDBACK_USER', '10000000-0000-4000-8000-000000000002'
    );
    raise exception 'R2 FAILED: the same report was recovered twice';
  exception when unique_violation then
    raise notice 'R2 ok: a second recovery of the report was refused with 23505';
  end;

  -- The helper kind vocabulary is closed, and an outside helper carries no id.
  begin
    perform public.findback_mark_recovered('20000000-0000-4000-8000-000000000002', 'SOMEONE', null);
    raise exception 'R4 FAILED: an unknown helper kind was accepted';
  exception when invalid_parameter_value then
    raise notice 'R4 ok: an unknown helper kind was refused with 22023';
  end;

  begin
    perform public.findback_mark_recovered('20000000-0000-4000-8000-000000000002', 'OUTSIDE', '10000000-0000-4000-8000-000000000003');
    raise exception 'R5 FAILED: an outside helper was stored with an account id';
  exception when invalid_parameter_value then
    raise notice 'R5 ok: an outside helper with an account id was refused with 22023';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- R3. A NON-OWNER cannot mark somebody else's report recovered.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
do $$
begin
  begin
    perform public.findback_mark_recovered('20000000-0000-4000-8000-000000000008', 'OUTSIDE', null);
    raise exception 'R3 FAILED: a non-owner marked a report recovered';
  exception when insufficient_privilege then
    raise notice 'R3 ok: a non-owner was refused with 42501';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'R1/R3 exactly one recovery row; the report status moved with it' as probe
where 1 = (select count(*) from public.successful_returns)
and exists (
  select 1 from public.successful_returns s
  where s.lost_post_id = '20000000-0000-4000-8000-000000000001'
    and s.lost_owner_user_id = '10000000-0000-4000-8000-000000000001'
    and s.helper_user_id = '10000000-0000-4000-8000-000000000002'
    and s.external_helper = false
    and s.confirmed_by is null
)
and (select p.status from public.item_posts p where p.id = '20000000-0000-4000-8000-000000000001') = 'RECOVERED'
and (select p.status from public.item_posts p where p.id = '20000000-0000-4000-8000-000000000008') = 'OPEN';

-- The recovery id is NOT client-readable from the table (there is no grant).
-- Capture it here as the owner so the non-participant probe below can attempt
-- a rating of a REAL recovery and be refused on PARTICIPATION, not on a
-- missing row.
select s.id as return_one from public.successful_returns s
 where s.lost_post_id = '20000000-0000-4000-8000-000000000001';
select set_config('trust_test.return_one', :'fb_probe_return_one', true);

-- T1. A NON-PARTICIPANT cannot rate the recovery, nor read its ratings.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
do $$
declare
  v_return text := current_setting('trust_test.return_one');
begin
  begin
    perform public.findback_rate_return(v_return, 5);
    raise exception 'T1a FAILED: an unrelated caller rated a recovery';
  exception when insufficient_privilege then
    raise notice 'T1a ok: an unrelated rater was refused with 42501';
  end;

  begin
    perform public.findback_return_ratings(v_return);
    raise exception 'T1b FAILED: an unrelated caller read the ratings';
  exception when insufficient_privilege then
    raise notice 'T1b ok: an unrelated reader was refused with 42501';
  end;

  -- The table has no client grant at all.
  begin
    perform count(*) from public.return_ratings;
    raise exception 'T1c FAILED: a client role read return_ratings directly';
  exception when insufficient_privilege then
    raise notice 'T1c ok: return_ratings refused the client read with 42501';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- T2. Self rating is refused: a SELF_OR_PRIVATE recovery has no counterpart.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
do $$
declare
  v_self_return text;
begin
  v_self_return := public.findback_mark_recovered('20000000-0000-4000-8000-000000000007', 'SELF_OR_PRIVATE', null);

  begin
    perform public.findback_rate_return(v_self_return, 5);
    raise exception 'T2a FAILED: a self/private recovery was rated';
  exception when invalid_parameter_value then
    raise notice 'T2a ok: a self/private recovery has no counterpart to rate (22023)';
  end;

  begin
    insert into public.return_ratings (id, successful_return_id, rater_user_id, rated_user_id, score, created_at, updated_at)
    values (gen_random_uuid()::text, v_self_return,
            '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 5,
            '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    raise exception 'T2b FAILED: a client wrote a rating row directly';
  exception when insufficient_privilege then
    raise notice 'T2b ok: a direct rating row is refused with 42501';
  end;

  -- R6. The score is bounded before anything is written.
  begin
    perform public.findback_rate_return(v_self_return, 6);
    raise exception 'T6 FAILED: a score of 6 was accepted';
  exception when invalid_parameter_value then
    raise notice 'T6 ok: a score outside 1..5 was refused with 22023';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- The CHECK is the structural second line (as the table owner, so the grant is
-- not what refuses it).
do $$
declare
  v_self_return text;
begin
  -- As the session owner, the self/private recovery id is directly readable.
  select s.id into v_self_return from public.successful_returns s
   where s.lost_post_id = '20000000-0000-4000-8000-000000000007';

  begin
    insert into public.return_ratings (id, successful_return_id, rater_user_id, rated_user_id, score, created_at, updated_at)
    values (gen_random_uuid()::text, v_self_return,
            '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 5,
            '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    raise exception 'T2c FAILED: the self-rating CHECK did not fire';
  exception when check_violation then
    raise notice 'T2c ok: a self-rating row violates the CHECK';
  end;
end;
$$;

-- T3/T4. Once per DIRECTION: the owner rates, the owner again is refused, the
-- helper rates and is accepted.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
declare
  v_return text;
begin
  -- The participant reaches the id through the participant-scoped reader; the
  -- table itself has no grant.
  select successful_return_id into v_return
    from public.findback_my_recoveries()
   where lost_post_id = '20000000-0000-4000-8000-000000000001';

  perform public.findback_rate_return(v_return, 5);

  begin
    perform public.findback_rate_return(v_return, 4);
    raise exception 'T3 FAILED: the same direction rated twice';
  exception when unique_violation then
    raise notice 'T3 ok: the second rating in one direction was refused with 23505';
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
do $$
declare
  v_return text;
begin
  select successful_return_id into v_return
    from public.findback_my_recoveries()
   where lost_post_id = '20000000-0000-4000-8000-000000000001';

  -- T4. The OTHER direction is accepted: one return, two ratings.
  perform public.findback_rate_return(v_return, 4);

  if (select count(*) from public.findback_return_ratings(v_return)) <> 2 then
    raise exception 'T4 FAILED: the recovery does not carry exactly two ratings';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'T4 two directions, two ratings, rated user derived' as probe
where 2 = (select count(*) from public.return_ratings)
and exists (
  select 1 from public.return_ratings r
  where r.rater_user_id = '10000000-0000-4000-8000-000000000001'
    and r.rated_user_id = '10000000-0000-4000-8000-000000000002'
    and r.score = 5
)
and exists (
  select 1 from public.return_ratings r
  where r.rater_user_id = '10000000-0000-4000-8000-000000000002'
    and r.rated_user_id = '10000000-0000-4000-8000-000000000001'
    and r.score = 4
);

-- T5. D23: a block between the two does NOT erase the recovery or the ratings.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select public.findback_block_user('10000000-0000-4000-8000-000000000002') as block_for_d23;
do $$
declare
  v_return text;
begin
  select successful_return_id into v_return
    from public.findback_my_recoveries()
   where lost_post_id = '20000000-0000-4000-8000-000000000001';

  if (select count(*) from public.findback_return_ratings(v_return)) <> 2 then
    raise exception 'T5 FAILED: a block hid the recovery ratings';
  end if;
  if not exists (select 1 from public.findback_my_recoveries() where successful_return_id = v_return) then
    raise exception 'T5 FAILED: a block hid the caller''s own recovery';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
do $$
begin
  if not exists (select 1 from public.findback_my_recoveries()) then
    raise exception 'T5 FAILED: the helper cannot reach the shared recovery record';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'T5 recovery evidence survives a block' as probe
where 1 = (select count(*) from public.successful_returns where lost_post_id = '20000000-0000-4000-8000-000000000001')
and 2 = (select count(*) from public.return_ratings);

-- Clean up the block so the limit probes below are about limits.
delete from public.user_blocks;

-- ===========================================================================
-- 2C. Standing, tier and limits (D28, D29).
-- ===========================================================================

-- S1. The base limit exists and is the NORMAL ceiling; a fresh NEW account is
--     below it, which is what makes the two distinguishable.
select 'S1 base interaction limit is 5' as probe
where public.findback_base_interaction_limit() = 5;

-- S2. Five eligible ratings at >= 4.0 make a TRUSTED tier; fewer stays NEW.
--     Fixture rows (no JWT), four returns by the stranger with the helper as
--     the rated user, so the derivation sees five ratings about trust_helper.
insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
select
  '20000000-0000-4000-8000-00000000020' || g,
  '10000000-0000-4000-8000-000000000003',
  'LOST', 'rating seed ' || g, 'desc', 'Other', 'OPEN', '2026-10-01',
  '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
from generate_series(1, 4) g
on conflict (id) do nothing;

insert into public.successful_returns (id, lost_post_id, found_post_id, lost_owner_user_id, helper_user_id, external_helper, recovered_at, confirmed_by, created_at)
select
  '30000000-0000-4000-8000-00000000020' || g,
  '20000000-0000-4000-8000-00000000020' || g,
  null,
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000002',
  false, '2026-10-02T00:00:00.000Z', null, '2026-10-02T00:00:00.000Z'
from generate_series(1, 4) g
on conflict (id) do nothing;

insert into public.return_ratings (id, successful_return_id, rater_user_id, rated_user_id, score, created_at, updated_at)
select
  '40000000-0000-4000-8000-00000000020' || g,
  '30000000-0000-4000-8000-00000000020' || g,
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000002',
  5, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'
from generate_series(1, 4) g
on conflict (id) do nothing;

select 'S2a fewer than five ratings stays NEW' as probe
where public.findback_reputation_tier('10000000-0000-4000-8000-000000000003') = 'NEW'
  and public.findback_reputation_tier('10000000-0000-4000-8000-000000000001') = 'NEW';

-- trust_helper now has 5 ratings: one 4 from the owner + four 5s.
select 'S2b five good ratings make TRUSTED (derived, not stored)' as probe
where public.findback_reputation_tier('10000000-0000-4000-8000-000000000002') = 'TRUSTED'
and not exists (
  select 1 from information_schema.columns c
  where c.table_schema = 'public' and c.column_name in ('reputation', 'reputation_tier', 'trust_score', 'trust_tier')
);

-- S3. PROBATION keeps the TIER ceiling and is spaced by 30 s (owner amendment
-- 2026-10-24). The superseded 1/day + 120 s branch is replaced, not deleted: the
-- full contract (tier caps, cross-action spacing, no-op/removal exemptions, the
-- private/safety bypass, expiry and revocation) is proven in
-- verify_public_probation.sql, and this suite keeps its own independent check
-- that the probation branch still reaches the daily ceiling.
insert into public.account_sanctions (id, user_id, kind, starts_at, ends_at, reason_code, active, created_at)
values ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005', 'PROBATION',
        '2026-10-01T00:00:00.000Z', null, 'OTHER', true, '2026-10-01T00:00:00.000Z');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', true);

do $$
declare
  v_limit integer;
  v_cooldown integer;
begin
  select l.limit_per_day, l.burst_cooldown_seconds into v_limit, v_cooldown
    from public.findback_post_limit() l;
  if v_limit <> 3 then
    raise exception 'S3a FAILED: a NEW Probation account''s daily limit is %, not the tier ceiling 3', v_limit;
  end if;
  if v_cooldown <> 30 then
    raise exception 'S3a FAILED: a Probation account''s interval is % s, not 30', v_cooldown;
  end if;
  if public.findback_standing() <> 'PROBATION' then
    raise exception 'S3a FAILED: a Probation sanction did not become the standing';
  end if;

  insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
  values ('20000000-0000-4000-8000-000000000030', '10000000-0000-4000-8000-000000000005',
          'LOST', 'probation first', 'desc', 'Other', 'OPEN', '2026-10-01',
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

  begin
    insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
    values ('20000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000005',
            'LOST', 'probation second', 'desc', 'Other', 'OPEN', '2026-10-01',
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    raise exception 'S3b FAILED: a Probation account beat the 30 s public clock';
  exception when raise_exception then
    if sqlerrm not like 'POST_COOLDOWN%' then
      raise exception 'S3b FAILED: the second post was refused with % instead of POST_COOLDOWN', sqlerrm;
    end if;
    raise notice 'S3b ok: the second post was refused with %', sqlerrm;
  end;
end;
$$;

reset role;
-- Privileged test-only rewind of the actor's admission ledger: the tier ceiling
-- has to be reachable inside one transaction to be asserted at all.
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id = '10000000-0000-4000-8000-000000000005';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', true);

do $$
begin
  insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
  values ('20000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000005',
          'LOST', 'probation second', 'desc', 'Other', 'OPEN', '2026-10-01',
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;

reset role;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id = '10000000-0000-4000-8000-000000000005';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', true);

do $$
begin
  insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
  values ('20000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000005',
          'LOST', 'probation third', 'desc', 'Other', 'OPEN', '2026-10-01',
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;

reset role;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id = '10000000-0000-4000-8000-000000000005';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', true);

do $$
begin
  begin
    insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
    values ('20000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000005',
            'LOST', 'probation fourth', 'desc', 'Other', 'OPEN', '2026-10-01',
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    raise exception 'S3c FAILED: a Probation account exceeded the tier ceiling';
  exception when raise_exception then
    if sqlerrm not like 'POST_LIMIT_REACHED%' then
      raise exception 'S3c FAILED: the fourth post was refused with % instead of POST_LIMIT_REACHED', sqlerrm;
    end if;
    raise notice 'S3c ok: the tier ceiling was enforced with %', sqlerrm;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- S4. A SUSPENDED account's FIRST post is refused (limit 0).
insert into public.account_sanctions (id, user_id, kind, starts_at, ends_at, reason_code, active, created_at)
values ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000006', 'SUSPENDED',
        '2026-10-01T00:00:00.000Z', null, 'OTHER', true, '2026-10-01T00:00:00.000Z');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000006', true);

do $$
declare
  v_limit integer;
begin
  select l.limit_per_day into v_limit from public.findback_post_limit() l;
  if v_limit <> 0 then
    raise exception 'S4a FAILED: a Suspended account''s limit is %, not 0', v_limit;
  end if;
  if public.findback_standing() <> 'SUSPENDED' then
    raise exception 'S4a FAILED: the suspension did not become the standing';
  end if;

  begin
    insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
    values ('20000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000006',
            'LOST', 'suspended post', 'desc', 'Other', 'OPEN', '2026-10-01',
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    raise exception 'S4b FAILED: a Suspended account posted at all';
  exception when raise_exception then
    -- A zero limit is a STANDING fact, not a spent day, so it has its own word:
    -- this probe used to assert POST_LIMIT_REACHED, which is what made the device
    -- copy ("that's all your replies for today") a lie for a suspended account
    -- (review R3 F-1). S3c above still pins POST_LIMIT_REACHED for the real
    -- ceiling, so the two causes are provably distinguishable and not merely
    -- asserted to differ.
    if sqlerrm not like 'POST_NOT_AVAILABLE%' then
      raise exception 'S4b FAILED: the post was refused with % instead of POST_NOT_AVAILABLE', sqlerrm;
    end if;
    raise notice 'S4b ok: a Suspended account''s first post was refused with %', sqlerrm;
  end;
end;
$$;

-- S4c. The tier is inside the same derivation: a serious sanction makes the
--      presented tier NEW even though the ratings are TRUSTED-grade.
do $$
begin
  if public.findback_reputation_tier('10000000-0000-4000-8000-000000000006') <> 'NEW' then
    raise exception 'S4c FAILED: a Suspended account still presents a trusted tier';
  end if;
end;
$$;

-- S5. The cooldown refuses two writes inside the window, on the comment table
--     as well (one guard, both tables). trust_owner already has a post from
--     today, so the first comment is the write that starts the clock.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
declare
  v_cooldown integer;
begin
  select l.burst_cooldown_seconds into v_cooldown from public.findback_post_limit() l;
  if v_cooldown <= 0 then
    raise exception 'S5 FAILED: a New account has no cooldown';
  end if;

  insert into public.comments (id, post_id, user_id, body, created_at, updated_at)
  values ('60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000001', 'first comment',
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

  begin
    insert into public.comments (id, post_id, user_id, body, created_at, updated_at)
    values ('60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003',
            '10000000-0000-4000-8000-000000000001', 'too soon',
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    raise exception 'S5 FAILED: a second write landed inside the cooldown window';
  exception when raise_exception then
    if sqlerrm not like 'POST_COOLDOWN%' then
      raise exception 'S5 FAILED: the comment was refused with % instead of POST_COOLDOWN', sqlerrm;
    end if;
    raise notice 'S5 ok: a write inside the cooldown was refused with %', sqlerrm;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- S6. The cooldown applies to POSTS as well (the same guard on item_posts).
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
do $$
begin
  begin
    insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
    values ('20000000-0000-4000-8000-000000000033', '10000000-0000-4000-8000-000000000001',
            'LOST', 'post inside the window', 'desc', 'Other', 'OPEN', '2026-10-01',
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    raise exception 'S6 FAILED: a post landed inside the cooldown window';
  exception when raise_exception then
    if sqlerrm not like 'POST_COOLDOWN%' then
      raise exception 'S6 FAILED: the post was refused with % instead of POST_COOLDOWN', sqlerrm;
    end if;
    raise notice 'S6 ok: a post inside the cooldown was refused with %', sqlerrm;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'S6b one guard, both write tables' as probe
where 2 = (
  select count(*) from pg_trigger t
  where not t.tgisinternal
    and t.tgname in ('trg_findback_item_posts_interaction_limit', 'trg_findback_comments_interaction_limit')
);

-- ===========================================================================
-- 2D. Feedback (D30–D33).
-- ===========================================================================

-- F1. A submission with no technical info stores NO context.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_feedback('bug', '  the feed flickers when I scroll  ', false);
  if v_id is null or v_id = '' then
    raise exception 'F1 FAILED: the submission returned no id';
  end if;

  -- F3. Empty / whitespace-only messages are refused.
  begin
    perform public.findback_submit_feedback('BUG', '   ', false);
    raise exception 'F3a FAILED: a whitespace-only message was accepted';
  exception when invalid_parameter_value then
    raise notice 'F3a ok: a whitespace-only message was refused with 22023';
  end;

  begin
    perform public.findback_submit_feedback('BUG', '', false);
    raise exception 'F3b FAILED: an empty message was accepted';
  exception when invalid_parameter_value then
    raise notice 'F3b ok: an empty message was refused with 22023';
  end;

  -- F4. The category vocabulary is closed.
  begin
    perform public.findback_submit_feedback('PRAISE', 'nice app', false);
    raise exception 'F4 FAILED: a category outside the vocabulary was accepted';
  exception when invalid_parameter_value then
    raise notice 'F4 ok: an unknown category was refused with 22023';
  end;

  -- A second, technical submission: the context is assembled from named
  -- scalars and captured on the SERVER clock.
  perform public.findback_submit_feedback(
    'USABILITY', 'hard to find the block button', true,
    '2.0.0-beta.1', 'android', 'settings/privacy', 'phone'
  );
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'F1 a plain submission stores no technical context' as probe
where 2 = (select count(*) from public.feedback)
and exists (
  select 1 from public.feedback f
  where f.category = 'BUG'
    and f.status = 'NEW'
    and f.include_technical_info = false
    and f.technical_context is null
    and f.admin_note is null
    and f.message = 'the feed flickers when I scroll'
);

select 'F2 the context is the named scalars plus the server capture instant' as probe
where exists (
  select 1 from public.feedback f
  where f.category = 'USABILITY'
    and f.include_technical_info = true
    and f.technical_context ? 'captured_at'
    and f.technical_context ?& array['app_version', 'platform', 'screen', 'device_class']
    and f.technical_context->>'app_version' = '2.0.0-beta.1'
    and f.technical_context->>'platform' = 'android'
    and f.technical_context->>'screen' = 'settings/privacy'
    and f.technical_context->>'device_class' = 'phone'
    -- no free text, no blob: the message is not copied into the context
    and f.technical_context::text not like '%block button%'
    and (select array_agg(k order by k) from jsonb_object_keys(f.technical_context) k)
        = array['app_version', 'captured_at', 'device_class', 'platform', 'screen']
);

-- F5. The author sees the STATUS columns only: message, context and admin_note
--     are outside the grant.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
do $$
declare
  v_rows integer;
begin
  select count(*) into v_rows from public.feedback;
  if v_rows <> 2 then
    raise exception 'F6a FAILED: the author sees % of their own rows, not 2', v_rows;
  end if;

  begin
    perform admin_note from public.feedback;
    raise exception 'F5a FAILED: the author read admin_note';
  exception when insufficient_privilege then
    raise notice 'F5a ok: admin_note is outside the grant (42501)';
  end;

  begin
    perform message from public.feedback;
    raise exception 'F5b FAILED: the author re-read their own message';
  exception when insufficient_privilege then
    raise notice 'F5b ok: message is outside the grant (42501)';
  end;

  begin
    perform technical_context from public.feedback;
    raise exception 'F5c FAILED: the author read the technical context';
  exception when insufficient_privilege then
    raise notice 'F5c ok: technical_context is outside the grant (42501)';
  end;
end;
$$;

-- F6. Another account sees none of it.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
do $$
declare
  v_rows integer;
begin
  select count(*) into v_rows from public.feedback;
  if v_rows <> 0 then
    raise exception 'F6b FAILED: another account can read % feedback rows', v_rows;
  end if;
end;
$$;

-- F7. The daily ceiling (2 x base = 10) refuses the eleventh submission.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
do $$
declare
  v_i integer;
  v_limit integer := 2 * public.findback_base_interaction_limit();
begin
  for v_i in 3..v_limit loop
    perform public.findback_submit_feedback('OTHER', 'filler ' || v_i, false);
  end loop;

  if (select count(*) from public.feedback) <> v_limit then
    raise exception 'F7 FAILED: the author does not have % rows before the ceiling', v_limit;
  end if;

  begin
    perform public.findback_submit_feedback('OTHER', 'one too many', false);
    raise exception 'F7 FAILED: the submission over the daily ceiling was accepted';
  exception when raise_exception then
    if sqlerrm not like 'FEEDBACK_LIMIT_REACHED%' then
      raise exception 'F7 FAILED: the ceiling refusal said % instead of FEEDBACK_LIMIT_REACHED', sqlerrm;
    end if;
    raise notice 'F7 ok: the daily ceiling was refused with %', sqlerrm;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- F9. Account deletion removes the row and leaves no aggregate.
select 'F9a the rows belong to their author' as probe
where 10 = (select count(*) from public.feedback where user_id = '10000000-0000-4000-8000-000000000004');

delete from public.users where id = '10000000-0000-4000-8000-000000000004';

select 'F9b deletion removes every feedback row and keeps no aggregate' as probe
where 0 = (select count(*) from public.feedback)
and not exists (
  select 1 from information_schema.tables t
  where t.table_schema = 'public' and (t.table_name like '%feedback%' or t.table_name like '%feedback_aggregate%')
    and t.table_name <> 'feedback'
);

-- F8. Anon cannot read feedback: covered as B1g above (the grant, not the
--     policy, is the boundary), asserted here once more after rows existed.
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role anon;
do $$
begin
  begin
    perform count(*) from public.feedback;
    raise exception 'F8 FAILED: anon read the feedback table';
  exception when insufficient_privilege then
    raise notice 'F8 ok: anon refused the feedback table with 42501';
  end;
end;
$$;
reset role;

rollback;
