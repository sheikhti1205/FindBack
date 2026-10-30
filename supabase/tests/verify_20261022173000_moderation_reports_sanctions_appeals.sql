-- Verification for 20261022173000_moderation_reports_sanctions_appeals.sql
-- (CF-060 B2a reports + B2b moderation + B2c appeals).
--
-- STATUS, STATED PLAINLY. This migration has NOT been applied to the hosted
-- project. Nothing in this file may be quoted as a passing result until it has
-- been run and its output recorded. The static guards
-- (supabase/tests/migration_sql_syntax.test.mjs, supabase/tests/migration_parity.test.mjs)
-- check the TEXT of the migration; they prove nothing about behaviour.
--
-- HOW TO RUN IT. Section 1 is read-only catalog probes. Section 2 is
-- behavioural: it switches to `anon` / `authenticated` with a JWT subject claim
-- (`set_config('request.jwt.claim.sub', <uid>, true)` — LOCAL, so the claim
-- cannot outlive the transaction) and writes scratch rows, so run it on a
-- DISPOSABLE PostgreSQL 17 with the whole migration chain applied — never on
-- production — and wrap it in the transaction that this file ends with ROLLBACK.
--
-- The disposable instance needs the same platform objects the chain harness
-- bootstraps: roles `anon` / `authenticated` / `service_role`, schema `auth`
-- with `auth.uid()`, and the Supabase-only extension/schema stubs. The
-- canonical runner is the local chain harness:
--
--   FB_SRC=<repo>/supabase FB_CLUSTER_ROOT=<dir> FB_PG_PORT=<port> \
--     node <harness>/chain.mjs --probe supabase/tests/verify_20261022173000_moderation_reports_sanctions_appeals.sql
--
-- EVERY PROBE IS AN ASSERTION. A SELECT probe returns a row only when its
-- invariant holds, so an empty result means FAILED (the harness reports it as
-- EMPTY and exits non-zero). Every privilege refusal is CAUGHT inside its own
-- block, because a refusal raised in a transaction aborts it.
--
-- The properties under test:
--   1. content_reports / account_sanctions / appeals are ungranted to every
--      client role, carry RLS and zero policies (D36);
--   2. the nine client-callable definers are SECURITY DEFINER with a pinned
--      search_path and are authenticated-only; the internal definers (guards,
--      evidence capture, policy seam, outcome copy) are closed, and the 90-day
--      sweep is service_role only;
--   3. an ANONYMOUS caller is refused with 42501 by every RPC; an ordinary
--      authenticated caller is refused the tables, the queue, the target reader
--      and the writer with 42501 and can read only their own receipts;
--   4. a moderator WITHOUT a capability is refused with 42501, and a moderator
--      WITH it succeeds; an admin passes every action (A2.2);
--   5. the last active admin still cannot be revoked (D1's guard is untouched);
--   6. the report writer is idempotent for one (reporter, target), never an
--      existence oracle (one neutral P0002), and refuses inside the burst
--      cooldown with the stable REPORT_LIMIT_REACHED;
--   7. one action writes one state change, closes the report group, appends
--      exactly one audit row and emits one NULL-actor outcome notification
--      (D37/D13) — and a dismissal notifies nobody;
--   8. the evidence snapshot is server-built, bounded, immutable before expiry,
--      physically erased at expiry, and unreadable to moderators afterwards
--      (§13.11);
--   9. the appeal writer demands ownership, refuses a duplicate with the stable
--      APPEAL_ALREADY_OPEN, and the appeal survives deletion of its subject;
--  10. deleting a reported target keeps the receipt (the measured D3 defect is
--      gone): this is the probe a reverted `content_reports_target_shape_check`
--      must break with 23514.
--
-- Probe B21 is the must-fail half of the static proof: on a tree where the
-- replacement CHECK was reverted to D3's exact one-live-pointer form, deleting
-- a reported post raises 23514 and B21 fails by name.

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes.
-- ---------------------------------------------------------------------------

-- P1. The three moderation tables exist with RLS enabled.
select 'P1 moderation tables exist with RLS' as probe
where 3 = (
  select count(*)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('content_reports','account_sanctions','appeals')
    and c.relrowsecurity
);

-- P2. No client role (and no PUBLIC grant) holds ANY table privilege on them.
select 'P2 no client table privilege on the moderation tables' as probe
where not exists (
  select 1
  from unnest(array['anon','authenticated']) r(role_name)
  cross join unnest(array['content_reports','account_sanctions','appeals']) t(table_name)
  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
  where has_table_privilege(r.role_name, 'public.' || t.table_name, p.priv)
)
and not exists (
  select 1
  from information_schema.role_table_grants g
  where g.table_schema = 'public'
    and g.table_name in ('content_reports','account_sanctions','appeals')
    and g.grantee = 'PUBLIC'
);

-- P3. Each of them carries zero policies: the definer RPCs are the only way in.
select 'P3 the moderation tables carry zero policies' as probe
where not exists (
  select 1
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('content_reports','account_sanctions','appeals')
);

-- P4. The audit log stays append-only for clients (D37).
select 'P4 the audit log is append-only for clients' as probe
where not exists (
  select 1
  from unnest(array['anon','authenticated']) r(role_name)
  cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
  where has_table_privilege(r.role_name, 'public.admin_audit_log', p.priv)
);

-- P5. Every client-callable definer is SECURITY DEFINER, has a pinned
--     search_path, is executable by authenticated and by nobody anonymous.
--     findback_report_reasons is the one deliberate exception: it is a pure
--     immutable vocabulary read, security INVOKER, so it is asserted separately.
select 'P5 client definers are definer + pinned + authenticated-only' as probe
where 8 = (
  select count(*)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'findback_submit_report','findback_my_reports',
      'findback_apply_moderation','findback_moderation_queue','findback_moderation_target',
      'findback_my_moderation_outcomes','findback_my_post_moderation','findback_submit_appeal'
    )
    and p.prosecdef
    and p.proconfig::text like '%search_path=public, pg_temp%'
)
and exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'findback_report_reasons'
    and p.proconfig::text like '%search_path=public, pg_temp%'
    and not p.prosecdef
)
and not exists (
  select 1
  from information_schema.role_routine_grants g
  where g.routine_schema = 'public'
    and g.grantee in ('anon','PUBLIC')
    and g.routine_name in (
      'findback_report_reasons','findback_submit_report','findback_my_reports',
      'findback_apply_moderation','findback_moderation_queue','findback_moderation_target',
      'findback_my_moderation_outcomes','findback_my_post_moderation','findback_submit_appeal'
    )
)
and 9 = (
  select count(distinct g.routine_name)
  from information_schema.role_routine_grants g
  where g.routine_schema = 'public'
    and g.grantee = 'authenticated'
    and g.routine_name in (
      'findback_report_reasons','findback_submit_report','findback_my_reports',
      'findback_apply_moderation','findback_moderation_queue','findback_moderation_target',
      'findback_my_moderation_outcomes','findback_my_post_moderation','findback_submit_appeal'
    )
);

-- P6. The internal definers are closed to every client role, and the 90-day
--     sweep is granted to service_role alone.
select 'P6 internal definers are closed and the sweep is service_role only' as probe
where 8 = (
  select count(*)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'findback_capture_report_evidence','findback_report_limit',
      'findback_expire_report_evidence','findback_moderation_outcome_copy',
      'findback_appeal_outcome_copy','findback_guard_report_evidence_immutable',
      'findback_guard_report_identity','findback_guard_appeal_identity'
    )
    and p.prosecdef
    and p.proconfig::text like '%search_path=public, pg_temp%'
)
and not exists (
  select 1
  from information_schema.role_routine_grants g
  where g.routine_schema = 'public'
    and g.grantee in ('anon','authenticated','PUBLIC')
    and g.routine_name in (
      'findback_capture_report_evidence','findback_report_limit',
      'findback_expire_report_evidence','findback_moderation_outcome_copy',
      'findback_appeal_outcome_copy','findback_guard_report_evidence_immutable',
      'findback_guard_report_identity','findback_guard_appeal_identity'
    )
)
and exists (
  select 1
  from information_schema.role_routine_grants g
  where g.routine_schema = 'public'
    and g.grantee = 'service_role'
    and g.routine_name = 'findback_expire_report_evidence'
);

-- P7. The reason vocabulary is the closed seven-value list, in one place.
select 'P7 the reason vocabulary is the closed seven-value list' as probe
where public.findback_report_reasons() = array[
  'SCAM_OR_MISLEADING','SPAM_OR_DUPLICATE','HARASSMENT','INAPPROPRIATE_CONTENT',
  'PRIVATE_INFORMATION','SUSPECTED_STOLEN_OR_ILLEGAL','OTHER'
]::text[];

-- P8. The replacement shape CHECK is present AND relaxed: every pointer column
--     carries an "is null" escape and no pointer is forced non-null. B22 proves
--     the same property behaviourally.
select 'P8 the replacement target shape CHECK is the relaxed one' as probe
where exists (
  select 1
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'content_reports'
    and c.conname = 'content_reports_target_shape_check'
    and c.contype = 'c'
    and lower(pg_get_constraintdef(c.oid)) similar to '%target_post_id is null%'
    and lower(pg_get_constraintdef(c.oid)) similar to '%target_comment_id is null%'
    and lower(pg_get_constraintdef(c.oid)) similar to '%target_user_id is null%'
    and lower(pg_get_constraintdef(c.oid)) not similar to '%is not null%'
);

-- P9. The dedupe key is the plain three-column key with NO predicate, so it
--     still governs after a target is unlinked (the measured D6 defect).
select 'P9 the dedupe key survives target unlinkage' as probe
where exists (
  select 1
  from pg_indexes i
  where i.schemaname = 'public'
    and i.indexname = 'content_reports_dedupe_key'
    and i.indexdef like '%(reporter_user_id, target_type, target_id)%'
    and i.indexdef not like '%WHERE%'
);

-- P10. The notification vocabulary gained MODERATION, and the outcome copy is
--      consumer-safe (no reason code, no reporter, no moderator).
select 'P10 the moderation notification path exists' as probe
where exists (
  select 1
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'notifications'
    and c.conname = 'notifications_type_check'
    and pg_get_constraintdef(c.oid) like '%MODERATION%'
)
and public.findback_moderation_outcome_copy('HIDE', 'HARASSMENT') = 'We hid this content after a review of our community rules.'
and public.findback_moderation_outcome_copy('HIDE', 'SCAM_OR_MISLEADING') = public.findback_moderation_outcome_copy('HIDE', 'HARASSMENT');

-- ---------------------------------------------------------------------------
-- 2. Behavioural probes (DISPOSABLE PostgreSQL only; this transaction ROLLBACKs).
-- ---------------------------------------------------------------------------

begin;

-- B0. Scratch accounts and targets.
--
--     u_rep1..u_rep5 exist because the burst cooldown (120 s) means ONE report
--     per reporter inside this transaction: each writer path gets its own
--     reporter rather than a disabled limit.
insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, avatar_url, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000e001', 'mod_owner',  'mod_owner@example.invalid',  '+8801700000001', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e002', 'mod_rep1',   'mod_rep1@example.invalid',   '+8801700000002', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e003', 'mod_rep2',   'mod_rep2@example.invalid',   '+8801700000003', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e004', 'mod_rep3',   'mod_rep3@example.invalid',   '+8801700000004', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e005', 'mod_rep4',   'mod_rep4@example.invalid',   '+8801700000005', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e006', 'mod_rep5',   'mod_rep5@example.invalid',   '+8801700000006', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e007', 'mod_limited','mod_limited@example.invalid','+8801700000007', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e008', 'mod_admin',  'mod_admin@example.invalid',  '+8801700000008', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e009', 'mod_target', 'mod_target@example.invalid', '+8801700000009', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
on conflict (id) do nothing;

insert into public.user_roles (user_id, role, granted_by, granted_at)
values
  ('00000000-0000-4000-8000-00000000e007', 'MODERATOR', '00000000-0000-4000-8000-00000000e008', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e008', 'ADMIN',     '00000000-0000-4000-8000-00000000e008', '2026-10-22T00:00:00.000Z')
on conflict do nothing;

-- The limited moderator holds reports_review + content_hide and NOTHING else:
-- the capability gate must refuse REMOVE / WARN / BAN.
insert into public.user_role_capabilities (user_id, capability, granted_by, granted_at)
values
  ('00000000-0000-4000-8000-00000000e007', 'reports_review', '00000000-0000-4000-8000-00000000e008', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000e007', 'content_hide',   '00000000-0000-4000-8000-00000000e008', '2026-10-22T00:00:00.000Z')
on conflict do nothing;

insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
values
  ('p-report-hide',    '00000000-0000-4000-8000-00000000e001', 'LOST',  'Hide me',        'A wallet reported for review', 'Electronics', 'OPEN', '2020-01-01', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('p-report-hidden',  '00000000-0000-4000-8000-00000000e001', 'FOUND',  'Already hidden', 'A hidden post',                'Electronics', 'OPEN', '2020-01-01', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('p-report-burst',   '00000000-0000-4000-8000-00000000e001', 'LOST',  'Burst first',    'The first report',             'Electronics', 'OPEN', '2020-01-01', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('p-report-comment', '00000000-0000-4000-8000-00000000e009', 'FOUND',  'Carries a comment', 'The comment lives here',    'Electronics', 'OPEN', '2020-01-01', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('p-report-delete',  '00000000-0000-4000-8000-00000000e001', 'LOST',  'Delete me',      'The target that disappears',   'Electronics', 'OPEN', '2020-01-01', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('p-report-unused',  '00000000-0000-4000-8000-00000000e001', 'LOST',  'Burst second',   'The target the cooldown refuses', 'Electronics', 'OPEN', '2020-01-01', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
on conflict (id) do nothing;

-- The second report would be on this target if the cooldown were absent.
update public.item_posts
   set moderation_visibility = 'HIDDEN'
 where id = 'p-report-hidden';

insert into public.attachments (id, post_id, file_url, mime_type, file_name, file_size, created_at)
values ('att-report-1', 'p-report-hide', 'https://example.invalid/a.jpg', 'image/jpeg', 'a.jpg', 1234, '2026-10-22T00:00:00.000Z')
on conflict (id) do nothing;

insert into public.comments (id, post_id, user_id, body, created_at, updated_at)
values ('c-report-1', 'p-report-comment', '00000000-0000-4000-8000-00000000e009', 'A comment someone reported', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
on conflict (id) do nothing;

-- B1. ANON is refused by every RPC with 42501 (A2.6 / CONTRACT §5).
set local role anon;
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  begin
    perform public.findback_submit_report('POST','p-report-hide','SPAM_OR_DUPLICATE',null);
    raise exception 'B1a FAILED: anon filed a report' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B1a ok: anon was refused the report writer with 42501';
  end;

  begin
    perform public.findback_my_reports();
    raise exception 'B1b FAILED: anon read report receipts' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B1b ok: anon was refused the receipt reader with 42501';
  end;

  begin
    perform public.findback_moderation_queue(10);
    raise exception 'B1c FAILED: anon read the moderation queue' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B1c ok: anon was refused the queue with 42501';
  end;

  begin
    perform public.findback_moderation_target('POST','p-report-hide');
    raise exception 'B1d FAILED: anon read a moderation target' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B1d ok: anon was refused the target reader with 42501';
  end;

  begin
    perform public.findback_apply_moderation('POST','p-report-hide','HIDE','HARASSMENT',null,null,null);
    raise exception 'B1e FAILED: anon applied a moderation action' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B1e ok: anon was refused the writer with 42501';
  end;

  begin
    perform public.findback_my_moderation_outcomes();
    raise exception 'B1f FAILED: anon read moderation outcomes' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B1f ok: anon was refused the outcome reader with 42501';
  end;

  begin
    perform public.findback_my_post_moderation();
    raise exception 'B1g FAILED: anon read post moderation state' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B1g ok: anon was refused the post-state reader with 42501';
  end;

  begin
    perform public.findback_submit_appeal('SANCTION','anything','please');
    raise exception 'B1h FAILED: anon filed an appeal' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B1h ok: anon was refused the appeal writer with 42501';
  end;

  raise notice 'B1 ok: anon holds no path into any moderation object';
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- B2. An ordinary authenticated caller cannot enumerate the moderation state.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e002', true);

do $$
begin
  begin
    perform count(*) from public.content_reports;
    raise exception 'B2a FAILED: an ordinary user read content_reports' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2a ok: content_reports is unreadable with 42501';
  end;

  begin
    perform count(*) from public.account_sanctions;
    raise exception 'B2b FAILED: an ordinary user read account_sanctions' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2b ok: account_sanctions is unreadable with 42501';
  end;

  begin
    perform count(*) from public.appeals;
    raise exception 'B2c FAILED: an ordinary user read appeals' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2c ok: appeals is unreadable with 42501';
  end;

  begin
    perform count(*) from public.admin_audit_log;
    raise exception 'B2d FAILED: an ordinary user read the audit log' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2d ok: the audit log is unreadable with 42501';
  end;

  begin
    perform public.findback_moderation_queue(10);
    raise exception 'B2e FAILED: an ordinary user read the moderation queue' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2e ok: the queue is refused with 42501';
  end;

  begin
    perform public.findback_moderation_target('POST','p-report-hide');
    raise exception 'B2f FAILED: an ordinary user read a moderation target' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2f ok: the target reader is refused with 42501';
  end;

  begin
    perform public.findback_apply_moderation('POST','p-report-hide','HIDE','HARASSMENT',null,null,null);
    raise exception 'B2g FAILED: an ordinary user moderated content' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2g ok: the writer is refused with 42501';
  end;

  raise notice 'B2 ok: an ordinary user has no moderation read and no moderation write';
end;
$$;

-- B3. The report writer: one receipt, five columns, idempotent retry.
do $$
declare
  v_first  text;
  v_second text;
  v_n      integer;
begin
  v_first := public.findback_submit_report('POST', 'p-report-hide', 'HARASSMENT', '  A threatening listing.  ');
  if v_first is null or v_first = '' then
    raise exception 'B3 FAILED: the report writer returned no receipt id';
  end if;
  perform set_config('probe.report_p1', v_first, true);

  -- A duplicate retry is the SAME receipt, never 23505 and never a new row.
  v_second := public.findback_submit_report('POST', 'p-report-hide', 'SPAM_OR_DUPLICATE', null);
  if v_second is distinct from v_first then
    raise exception 'B3 FAILED: a duplicate retry returned % instead of %', v_second, v_first;
  end if;

  select count(*) into v_n from public.findback_my_reports();
  if v_n <> 1 then
    raise exception 'B3 FAILED: the reporter holds % receipts, expected 1', v_n;
  end if;

  raise notice 'B3 ok: one receipt, and a duplicate retry returned the same id';
end;
$$;

select 'B3 the receipt is five columns and only the caller''s' as probe
from public.findback_my_reports() r
where (select count(*) from jsonb_object_keys(to_jsonb(r))) = 5
  and r.target_type = 'POST'
  and r.reason = 'HARASSMENT'
  and r.status = 'OPEN'
  and r.created_at is not null
limit 1;

select 'B3 a duplicate retry created no second receipt' as probe
where 1 = (select count(*) from public.findback_my_reports() where target_type = 'POST');

-- B4. A comment report from a different reporter.
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e003', true);

do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('COMMENT', 'c-report-1', 'INAPPROPRIATE_CONTENT', 'Off topic and hostile');
  if v_id is null then
    raise exception 'B4 FAILED: the comment report returned no receipt id';
  end if;
  perform set_config('probe.report_c1', v_id, true);
  raise notice 'B4 ok: the comment report was stored';
end;
$$;

select 'B4 a second reporter sees only their own receipt' as probe
where 1 = (select count(*) from public.findback_my_reports());

-- B5. A USER report from a third reporter.
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e004', true);

do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('USER', '00000000-0000-4000-8000-00000000e009', 'PRIVATE_INFORMATION', null);
  if v_id is null then
    raise exception 'B5 FAILED: the user report returned no receipt id';
  end if;
  perform set_config('probe.report_user', v_id, true);
  raise notice 'B5 ok: the user report was stored';
end;
$$;

-- B6. The writer is not an existence oracle: an unknown id and a HIDDEN
--     non-owned row fail with the SAME P0002 and the SAME message.
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e005', true);

do $$
declare
  v_state_unknown text;
  v_msg_unknown   text;
  v_state_hidden  text;
  v_msg_hidden    text;
begin
  begin
    perform public.findback_submit_report('POST', 'no-such-post-at-all', 'SPAM_OR_DUPLICATE', null);
    raise exception 'B6a FAILED: a report on an unknown target was accepted' using errcode = '0A000';
  exception when sqlstate 'P0002' then
    v_state_unknown := sqlstate;
    v_msg_unknown := sqlerrm;
  end;

  begin
    perform public.findback_submit_report('POST', 'p-report-hidden', 'SPAM_OR_DUPLICATE', null);
    raise exception 'B6b FAILED: a report on a hidden, non-owned target was accepted' using errcode = '0A000';
  exception when sqlstate 'P0002' then
    v_state_hidden := sqlstate;
    v_msg_hidden := sqlerrm;
  end;

  if v_state_unknown is null or v_state_hidden is null then
    raise exception 'B6 FAILED: one of the refusals did not use P0002';
  end if;
  if v_msg_unknown <> v_msg_hidden then
    raise exception 'B6 FAILED: the refusals differ (%) vs (%)', v_msg_unknown, v_msg_hidden;
  end if;

  perform set_config('probe.neutral_unknown', v_msg_unknown, true);
  perform set_config('probe.neutral_state', v_state_unknown, true);
  raise notice 'B6 ok: unknown and hidden targets are the same neutral P0002';
end;
$$;

select 'B6 the refusal is one neutral P0002' as probe
where current_setting('probe.neutral_state', true) = 'P0002'
  and current_setting('probe.neutral_unknown', true) = 'Report target unavailable';

-- B7. The burst cooldown refuses the second report within 120 s, with the
--     stable REPORT_LIMIT_REACHED token.
do $$
begin
  perform public.findback_submit_report('POST', 'p-report-burst', 'SCAM_OR_MISLEADING', null);

  begin
    perform public.findback_submit_report('POST', 'p-report-unused', 'SCAM_OR_MISLEADING', null);
    raise exception 'B7a FAILED: a second report inside the cooldown was accepted' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'REPORT_LIMIT_REACHED' then
      raise exception 'B7a FAILED: wrong refusal token (%)', sqlerrm;
    end if;
    perform set_config('probe.burst', sqlerrm, true);
  end;

  raise notice 'B7 ok: the second report was refused with REPORT_LIMIT_REACHED';
end;
$$;

select 'B7 the burst refusal is the stable REPORT_LIMIT_REACHED' as probe
where current_setting('probe.burst', true) = 'REPORT_LIMIT_REACHED';

-- B8. The vocabulary and detail guards.
do $$
begin
  begin
    perform public.findback_submit_report('POST', 'p-report-unused', 'NOT_A_REASON', null);
    raise exception 'B8a FAILED: an unknown reason was accepted' using errcode = '0A000';
  exception when sqlstate '22023' then
    raise notice 'B8a ok: an unknown reason is refused with 22023';
  end;

  begin
    perform public.findback_submit_report('VIDEO', 'p-report-unused', 'OTHER', null);
    raise exception 'B8b FAILED: an unknown target type was accepted' using errcode = '0A000';
  exception when sqlstate '22023' then
    raise notice 'B8b ok: an unknown target type is refused with 22023';
  end;

  raise notice 'B8 ok: the writer validates its closed vocabulary';
end;
$$;

-- B9. A fifth reporter files the report whose target will be deleted (B21).
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e006', true);

do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('POST', 'p-report-delete', 'SUSPECTED_STOLEN_OR_ILLEGAL', null);
  if v_id is null then
    raise exception 'B9 FAILED: the delete-target report returned no id';
  end if;
  perform set_config('probe.report_delete', v_id, true);
  raise notice 'B9 ok: the report on the soon-deleted target was stored';
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- B10. Server-side evidence: built from live rows, bounded, no PII, 90 days.
select 'B10 the snapshot is server-built and bounded' as probe
where exists (
  select 1
  from public.content_reports r
  where r.id = current_setting('probe.report_p1', true)
    and r.evidence_snapshot->>'target_type' = 'POST'
    and r.evidence_snapshot->>'lifecycle_status' = 'OPEN'
    and r.evidence_snapshot->>'moderation_visibility' = 'PUBLISHED'
    and r.evidence_snapshot->>'author_user_id' = '00000000-0000-4000-8000-00000000e001'
    and r.evidence_snapshot->'attachment_ids' @> '["att-report-1"]'::jsonb
    and char_length(r.evidence_snapshot->>'description_excerpt') <= 500
    and not (r.evidence_snapshot ? 'email')
    and not (r.evidence_snapshot ? 'phone')
    and not (r.evidence_snapshot ? 'password_hash')
    and r.detail = 'A threatening listing.'
    and r.evidence_captured_at < r.evidence_expires_at
    and r.evidence_erased_at is null
);

select 'B10 the comment and user snapshots are shaped' as probe
where exists (
  select 1 from public.content_reports r
  where r.id = current_setting('probe.report_c1', true)
    and r.evidence_snapshot->>'target_type' = 'COMMENT'
    and r.evidence_snapshot->>'post_id' = 'p-report-comment'
    and r.evidence_snapshot->>'author_user_id' = '00000000-0000-4000-8000-00000000e009'
)
and exists (
  select 1 from public.content_reports r
  where r.id = current_setting('probe.report_user', true)
    and r.evidence_snapshot->>'target_type' = 'USER'
    and r.evidence_snapshot->>'username' = 'mod_target'
    and not (r.evidence_snapshot ? 'email')
);

-- B11. The limited moderator: queue and target read ARE allowed (reports_review),
--      the actions outside the capability set are refused with 42501.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e007', true);

select 'B11 the queue is derived per logical target' as probe
where 5 = (select count(*) from public.findback_moderation_queue(50));

select 'B11 the queue row carries no reporter identity' as probe
from public.findback_moderation_queue(5) q
where (select count(*) from jsonb_object_keys(to_jsonb(q))) = 9
  and q.report_count >= 1
  and q.first_reported_at is not null
limit 1;

select 'B11 the target reader returns the live row and its evidence' as probe
where (public.findback_moderation_target('POST', 'p-report-hide')->>'target_exists') = 'true'
  and (public.findback_moderation_target('POST', 'p-report-hide')->'target'->>'id') = 'p-report-hide'
  and jsonb_array_length(public.findback_moderation_target('POST', 'p-report-hide')->'reports') = 1
  and (public.findback_moderation_target('POST', 'p-report-hide')->'reports'->0->'evidence') <> 'null'::jsonb
  and not (public.findback_moderation_target('POST', 'p-report-hide') ? 'reporter_user_id');

do $$
begin
  begin
    perform public.findback_apply_moderation('POST', 'p-report-hide', 'REMOVE', 'HARASSMENT', null, null, null);
    raise exception 'B11a FAILED: a moderator removed content without content_remove' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B11a ok: REMOVE was refused with 42501 without content_remove';
  end;

  begin
    perform public.findback_apply_moderation('USER', '00000000-0000-4000-8000-00000000e009', 'WARN', 'HARASSMENT', null, null, null);
    raise exception 'B11b FAILED: a moderator warned without members_warn' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B11b ok: WARN was refused with 42501 without members_warn';
  end;

  begin
    perform public.findback_apply_moderation('USER', '00000000-0000-4000-8000-00000000e009', 'BAN', 'HARASSMENT', null, null, null);
    raise exception 'B11c FAILED: a moderator banned without members_suspend' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B11c ok: BAN was refused with 42501 without members_suspend';
  end;

  raise notice 'B11 ok: the capability gate is per action, not per role';
end;
$$;

--      RE-ANCHORED by the CF-060 B2a moderation-privacy precondition
--      (20261022172000). The precondition revokes
--      `select (moderation_visibility) on public.item_posts` from
--      `authenticated`, so this probe can no longer read the atom from the base
--      table — that read IS the oracle the precondition closes. The assertion
--      is unchanged in meaning and now reads the atom through the privileged
--      moderator surface (`findback_moderation_target`, a definer gated on
--      `reports_review`), which is the surface this probe's caller already
--      uses one line above.
select 'B11 the refused actions changed nothing' as probe
where (public.findback_moderation_target('POST', 'p-report-hide')->'target'->>'moderation_visibility') = 'PUBLISHED';

-- B12. HIDE with content_hide, and NO_ACTION with reports_review.
do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation(
    'POST', 'p-report-hide', 'HIDE', 'HARASSMENT', 'Reviewed and hidden', null, null
  );
  if v_audit is null then
    raise exception 'B12 FAILED: HIDE returned no audit id';
  end if;
  perform set_config('probe.hide_audit', v_audit, true);
  raise notice 'B12 ok: HIDE was applied by a moderator holding content_hide';
end;
$$;

do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation(
    'COMMENT', 'c-report-1', 'NO_ACTION', 'OTHER', 'No rule broken', null, null
  );
  if v_audit is null then
    raise exception 'B13 FAILED: NO_ACTION returned no audit id';
  end if;
  perform set_config('probe.dismiss_audit', v_audit, true);
  raise notice 'B13 ok: a dismissal needs only reports_review';
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- B14. One action = one state change, one closed group, ONE audit row, one
--      NULL-actor notification. A dismissal notifies nobody.
select 'B14 HIDE changed the one visibility atom' as probe
where (select moderation_visibility from public.item_posts where id = 'p-report-hide') = 'HIDDEN'
  and (select updated_at from public.item_posts where id = 'p-report-hide') > '2026-10-22T00:00:00.000Z';

select 'B14 exactly one audit row per applied action' as probe
where 2 = (
  select count(*) from public.admin_audit_log
   where (target_type = 'POST' and target_id = 'p-report-hide')
      or (target_type = 'COMMENT' and target_id = 'c-report-1')
);

select 'B14 the audit row replaces a recorded state' as probe
where exists (
  select 1 from public.admin_audit_log l
   where l.target_type = 'POST' and l.target_id = 'p-report-hide' and l.action = 'HIDE'
     and l.reason = 'HARASSMENT'
     and l.actor_user_id = '00000000-0000-4000-8000-00000000e007'
     and l.previous_state->>'moderation_visibility' = 'PUBLISHED'
     and l.new_state->>'moderation_visibility' = 'HIDDEN'
     and l.id = current_setting('probe.hide_audit', true)
);

select 'B14 the report groups closed in the right direction' as probe
where exists (
  select 1 from public.content_reports
   where target_id = 'p-report-hide' and status = 'ACTIONED'
     and reviewed_by = '00000000-0000-4000-8000-00000000e007'
     and reviewed_at is not null
)
and exists (
  select 1 from public.content_reports
   where target_id = 'c-report-1' and status = 'DISMISSED'
)
and not exists (
  select 1 from public.content_reports
   where target_id in ('p-report-hide','c-report-1') and status = 'OPEN'
)
and exists (
  select 1 from public.content_reports
   where target_id = 'p-report-hide' and internal_note = 'Reviewed and hidden'
);

select 'B14 the outcome notification names no moderator' as probe
where 1 = (select count(*) from public.notifications where type = 'MODERATION')
  and 1 = (select count(*) from public.notifications where type = 'MODERATION' and actor_id is null)
  and exists (
    select 1 from public.notifications n
     where n.type = 'MODERATION'
       and n.user_id = '00000000-0000-4000-8000-00000000e001'
       and n.post_id = 'p-report-hide'
       and n.preview = public.findback_moderation_outcome_copy('HIDE', 'HARASSMENT')
  );

select 'B14 a dismissal notified nobody' as probe
where not exists (
  select 1 from public.notifications n
   where n.type = 'MODERATION' and n.post_id = 'p-report-comment'
);

-- B15. The admin passes every action, and the closed vocabulary plus the
--      sanction mapping still refuse the malformed calls.
--
--      Owner policy 2026-10-23 (20261023120000): the HIDE by e007 is FINAL.
--      The admin cannot reverse it. The AUTHOR asks for re-evaluation first,
--      which reopens the case; only then may another moderator decide again.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e001', true);

do $$
begin
  if public.findback_submit_appeal(
       'MODERATION_ACTION', current_setting('probe.hide_audit', true), 'Please reconsider the hide.'
     ) is null then
    raise exception 'B15p FAILED: the author could not ask for re-evaluation';
  end if;
  raise notice 'B15p ok: the author reopened the decided case';
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e008', true);

do $$
declare
  v_ban     text;
  v_publish text;
begin
  v_ban := public.findback_apply_moderation(
    'USER', '00000000-0000-4000-8000-00000000e009', 'BAN', 'SCAM_OR_MISLEADING', 'Repeated fraud', null, null
  );
  if v_ban is null then
    raise exception 'B15 FAILED: the admin ban returned no audit id';
  end if;
  perform set_config('probe.ban_audit', v_ban, true);

  v_publish := public.findback_apply_moderation(
    'POST', 'p-report-hide', 'PUBLISH', 'HARASSMENT', 'Restored after re-evaluation', null, null
  );
  if v_publish is null then
    raise exception 'B15 FAILED: the admin publish returned no audit id';
  end if;
  perform set_config('probe.publish_audit', v_publish, true);

  raise notice 'B15 ok: the admin ban and publish were applied';
end;
$$;

do $$
begin
  begin
    perform public.findback_apply_moderation('USER', '00000000-0000-4000-8000-00000000e009', 'WARN', 'OTHER', null, 'BANNED', null);
    raise exception 'B15a FAILED: a mismatched sanction kind was accepted' using errcode = '0A000';
  exception when sqlstate '22023' then
    raise notice 'B15a ok: a mismatched sanction kind is refused with 22023';
  end;

  begin
    perform public.findback_apply_moderation('POST', 'p-report-hide', 'DELETE_EVERYTHING', 'OTHER', null, null, null);
    raise exception 'B15b FAILED: an action outside the closed vocabulary was accepted' using errcode = '0A000';
  exception when sqlstate '22023' then
    raise notice 'B15b ok: an unknown action is refused with 22023';
  end;

  begin
    perform public.findback_apply_moderation('USER', '00000000-0000-4000-8000-00000000e009', 'HIDE', 'OTHER', null, null, null);
    raise exception 'B15c FAILED: a content action on a USER target was accepted' using errcode = '0A000';
  exception when sqlstate '22023' then
    raise notice 'B15c ok: a content action on a USER target is refused with 22023';
  end;

  begin
    perform public.findback_apply_moderation('POST', 'p-report-hide', 'BAN', 'OTHER', null, null, null);
    raise exception 'B15d FAILED: a member sanction on a POST target was accepted' using errcode = '0A000';
  exception when sqlstate '22023' then
    raise notice 'B15d ok: a member sanction on a POST target is refused with 22023';
  end;

  raise notice 'B15 ok: the action vocabulary and its target pairing are closed';
end;
$$;

-- D1's last-admin guard is untouched by this migration.
do $$
begin
  begin
    perform public.findback_role_revoke('mod_admin@example.invalid');
    raise exception 'B16 FAILED: the last admin was revoked' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B16 ok: the last admin still cannot be revoked';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- B17. The admin sanction is a history row, not a flag; the vocabulary is
--      recorded as the closed reason code.
select 'B17 the ban is a sanction row, not a user flag' as probe
where 1 = (
  select count(*) from public.account_sanctions
   where user_id = '00000000-0000-4000-8000-00000000e009'
     and kind = 'BANNED'
     and active
     and reason_code = 'SCAM_OR_MISLEADING'
     and created_by = '00000000-0000-4000-8000-00000000e008'
)
and not exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'users'
     and column_name in ('is_banned','banned','sanction','sanctioned')
);

do $$
declare
  v_id text;
begin
  select s.id into v_id
    from public.account_sanctions s
   where s.user_id = '00000000-0000-4000-8000-00000000e009'
     and s.kind = 'BANNED';
  perform set_config('probe.ban_sanction', v_id, true);
  raise notice 'B17 ok: the ban sanction id was captured for the appeal probes';
end;
$$;

select 'B17 the four audit rows exist and the ban is one of them' as probe
where 4 = (
  select count(*) from public.admin_audit_log
   where actor_user_id in ('00000000-0000-4000-8000-00000000e007','00000000-0000-4000-8000-00000000e008')
)
and 1 = (
  select count(*) from public.admin_audit_log
   where target_type = 'USER' and target_id = '00000000-0000-4000-8000-00000000e009' and action = 'BAN'
);

-- M3 outcomes are per action, not lifetime-deduplicated. HIDE, BAN and
-- PUBLISH each notify once; the dismissal still notified nobody (B14).
select 'B17 PUBLISH restored the atom and each action notified exactly once' as probe
where (select moderation_visibility from public.item_posts where id = 'p-report-hide') = 'PUBLISHED'
  and 3 = (select count(*) from public.notifications where type = 'MODERATION')
  and 3 = (select count(*) from public.notifications where type = 'MODERATION' and actor_id is null)
  and 1 = (select count(*) from public.notifications where type = 'MODERATION'
    and user_id = '00000000-0000-4000-8000-00000000e001'
    and preview = public.findback_moderation_outcome_copy('HIDE', 'HARASSMENT'))
  and 1 = (select count(*) from public.notifications where type = 'MODERATION'
    and user_id = '00000000-0000-4000-8000-00000000e001'
    and preview = public.findback_moderation_outcome_copy('PUBLISH', 'HARASSMENT'))
  and 1 = (select count(*) from public.notifications where type = 'MODERATION'
    and user_id = '00000000-0000-4000-8000-00000000e009'
    and preview = public.findback_moderation_outcome_copy('BAN', 'SCAM_OR_MISLEADING'));

-- B18. The consumer state readers, per caller.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e001', true);

select 'B18 the author sees their own outcomes, five columns' as probe
from public.findback_my_moderation_outcomes() o
where (select count(*) from jsonb_object_keys(to_jsonb(o))) = 5
  and o.target_type = 'POST'
  and o.target_id = 'p-report-hide'
limit 1;

select 'B18 the author sees the state of their own rows' as probe
where 5 = (select count(*) from public.findback_my_post_moderation())
  and exists (
    select 1 from public.findback_my_post_moderation() m
     where m.post_id = 'p-report-hide' and m.moderation_visibility = 'PUBLISHED'
  );

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e002', true);

select 'B18 another user sees no outcome and no post state' as probe
where 0 = (select count(*) from public.findback_my_moderation_outcomes())
  and 0 = (select count(*) from public.findback_my_post_moderation());

-- B19. Appeals: ownership, duplicate, and the neutral refusal.
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e009', true);

do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_appeal(
    'SANCTION', current_setting('probe.ban_sanction', true), 'I believe this was a mistake.'
  );
  if v_id is null then
    raise exception 'B19 FAILED: the sanctioned user could not appeal';
  end if;
  perform set_config('probe.appeal_sanction', v_id, true);
  raise notice 'B19 ok: the sanctioned user appealed their own sanction';
end;
$$;

do $$
begin
  begin
    perform public.findback_submit_appeal(
      'SANCTION', current_setting('probe.ban_sanction', true), 'Again, please.'
    );
    raise exception 'B19b FAILED: a second open appeal was accepted' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'APPEAL_ALREADY_OPEN' then
      raise exception 'B19b FAILED: wrong duplicate token (%)', sqlerrm;
    end if;
    raise notice 'B19b ok: a duplicate appeal is refused with APPEAL_ALREADY_OPEN';
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e002', true);

do $$
begin
  begin
    perform public.findback_submit_appeal('SANCTION', current_setting('probe.ban_sanction', true), 'Not mine.');
    raise exception 'B19c FAILED: someone else''s sanction was appealable' using errcode = '0A000';
  exception when sqlstate 'P0002' then
    raise notice 'B19c ok: another user''s sanction is one neutral P0002';
  end;

  begin
    perform public.findback_submit_appeal('MODERATION_ACTION', current_setting('probe.hide_audit', true), 'Not mine either.');
    raise exception 'B19d FAILED: someone else''s moderation action was appealable' using errcode = '0A000';
  exception when sqlstate 'P0002' then
    raise notice 'B19d ok: another user''s moderation action is one neutral P0002';
  end;

  raise notice 'B19 ok: the appeal writer demands ownership';
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e001', true);

do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_appeal(
    'MODERATION_ACTION', current_setting('probe.publish_audit', true), 'My post met the rules.'
  );
  if v_id is null then
    raise exception 'B19e FAILED: the post author could not appeal the action on their post';
  end if;
  perform set_config('probe.appeal_action', v_id, true);
  raise notice 'B19e ok: the post author appealed the action on their own post';
end;
$$;

-- B20. The evidence expiry: refused to clients, inert before expiry, erasing at
--      expiry, immutable afterwards, and invisible to moderators once erased.
do $$
begin
  begin
    perform public.findback_expire_report_evidence(500, null);
    raise exception 'B20a FAILED: an authenticated caller ran the expiry sweep' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B20a ok: the sweep is refused with 42501';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'B20 nothing is erased before expiry' as probe
where public.findback_expire_report_evidence(500, null) = 0
  and 0 = (select count(*) from public.content_reports where evidence_erased_at is not null);

do $$
declare
  v_id text := current_setting('probe.report_p1', true);
begin
  begin
    update public.content_reports
       set evidence_snapshot = '{}'::jsonb,
           detail = null,
           internal_note = null,
           evidence_erased_at = '2026-10-22T00:00:00.000Z'
     where id = v_id;
    raise exception 'B20b FAILED: evidence was erased before its expiry instant' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B20b ok: a pre-expiry erasure is refused with 42501';
  end;

  begin
    update public.content_reports set evidence_snapshot = '{"forged": true}'::jsonb where id = v_id;
    raise exception 'B20c FAILED: the evidence snapshot was rewritten' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B20c ok: the snapshot is immutable with 42501';
  end;
end;
$$;

select 'B20 the sweep ran over the stored reports' as probe,
       public.findback_expire_report_evidence(
         500,
         to_char((now() + interval '91 days') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ) as erased,
       (select count(*) from public.content_reports) as reports
where (select count(*) from public.content_reports) >= 5;

select 'B20 the sweep erased every expired snapshot' as probe
where 0 = (
  select count(*) from public.content_reports
   where evidence_erased_at is null
      or evidence_erased_at < evidence_expires_at
      or evidence_snapshot <> '{}'::jsonb
      or detail is not null
      or internal_note is not null
)
and 1 = (
  select count(*) from public.content_reports
   where id = current_setting('probe.report_p1', true)
     and evidence_erased_at is not null
);

do $$
declare
  v_id text := current_setting('probe.report_p1', true);
begin
  begin
    update public.content_reports set evidence_snapshot = '{"forged": true}'::jsonb where id = v_id;
    raise exception 'B20d FAILED: an erased snapshot was rewritten' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B20d ok: an erased snapshot stays erased with 42501';
  end;

  begin
    update public.content_reports set evidence_erased_at = null where id = v_id;
    raise exception 'B20e FAILED: an erasure was undone' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B20e ok: an erasure cannot be undone (42501)';
  end;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e007', true);

select 'B20 an erased snapshot is hidden from the moderator too' as probe
where (public.findback_moderation_target('POST', 'p-report-hide')->'reports'->0->'evidence') = 'null'::jsonb;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- B21. The identity guards, exercised by direct writes (there is no client path).
do $$
begin
  begin
    update public.content_reports
       set target_id = 'p-report-unused'
     where id = current_setting('probe.report_p1', true);
    raise exception 'B21a FAILED: a report target identity was rewritten' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B21a ok: the target identity is immutable with 42501';
  end;

  begin
    update public.content_reports
       set target_user_id = '00000000-0000-4000-8000-00000000e001'
     where id = current_setting('probe.report_user', true);
    raise exception 'B21b FAILED: a report pointer was repointed' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B21b ok: a pointer cannot be repointed with 42501';
  end;

  begin
    insert into public.content_reports (
      id, reporter_user_id, target_type, target_id,
      target_post_id, target_comment_id, target_user_id,
      reason, detail, evidence_snapshot, evidence_captured_at, evidence_expires_at,
      status, created_at, updated_at
    ) values (
      'guard-probe-post', '00000000-0000-4000-8000-00000000e002', 'POST', 'p-report-unused',
      null, null, null, 'OTHER', null, '{}'::jsonb,
      '2026-10-22T00:00:00.000Z', '2027-01-20T00:00:00.000Z', 'OPEN',
      '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'
    );
    raise exception 'B21c FAILED: a POST report with no live pointer was stored' using errcode = '0A000';
  exception when check_violation then
    raise notice 'B21c ok: a POST report needs its live pointer (23514)';
  end;
end;
$$;

select 'B21 the guard probes wrote nothing' as probe
where not exists (select 1 from public.content_reports where id = 'guard-probe-post');

-- B22. THE DELETION-RETENTION PROBE (the measured D3 defect).
--
--      This is deliberately the LAST probe before ROLLBACK: with D3's exact
--      one-live-pointer CHECK still in place the delete below raises 23514 and
--      aborts the transaction, so the failure is named here and nothing
--      downstream is misreported.
do $$
begin
  begin
    delete from public.item_posts where id = 'p-report-delete';
  exception when check_violation then
    raise exception 'B22 FAILED: deleting a reported target re-evaluated the shape CHECK (23514) — the D3 defect is back';
  end;

  raise notice 'B22 ok: the reported target was deleted without a CHECK violation';
end;
$$;

select 'B22 the receipt survives its deleted target' as probe
where exists (
  select 1 from public.content_reports r
   where r.target_id = 'p-report-delete'
     and r.target_type = 'POST'
     and r.target_post_id is null
     and r.reporter_user_id = '00000000-0000-4000-8000-00000000e006'
     and r.id = current_setting('probe.report_delete', true)
);

select 'B22 the dedupe key still holds one receipt for the deleted target' as probe
where 1 = (
  select count(*) from public.content_reports
   where reporter_user_id = '00000000-0000-4000-8000-00000000e006'
     and target_type = 'POST' and target_id = 'p-report-delete'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e007', true);

select 'B22 the target reader reports the deletion honestly' as probe
where (public.findback_moderation_target('POST', 'p-report-delete')->>'target_exists') = 'false'
  and (public.findback_moderation_target('POST', 'p-report-delete')->'target') = 'null'::jsonb
  and jsonb_array_length(public.findback_moderation_target('POST', 'p-report-delete')->'reports') = 1;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e006', true);

do $$
begin
  begin
    perform public.findback_submit_report('POST', 'p-report-delete', 'SUSPECTED_STOLEN_OR_ILLEGAL', null);
    raise exception 'B22d FAILED: a deleted target was accepted as a report target' using errcode = '0A000';
  exception when sqlstate 'P0002' then
    raise notice 'B22d ok: a retry against a deleted target is the neutral P0002';
  end;
end;
$$;

-- B23. The appeal survives deletion of the sanction it names (the measured B2c
--      defect: the historical claim that SET NULL does not re-evaluate the CHECK
--      was false).
reset role;
select set_config('request.jwt.claim.sub', '', true);

delete from public.account_sanctions
 where user_id = '00000000-0000-4000-8000-00000000e009'
   and kind = 'BANNED';

select 'B23 the appeal survives the sanction it names' as probe
where exists (
  select 1 from public.appeals a
   where a.subject_kind = 'SANCTION'
     and a.subject_id = current_setting('probe.ban_sanction', true)
     and a.sanction_id is null
     and a.appellant_user_id = '00000000-0000-4000-8000-00000000e009'
     and a.id = current_setting('probe.appeal_sanction', true)
);

select 'B23 the three appeals are the three subjects asked for' as probe
where 3 = (select count(*) from public.appeals)
  and exists (
    select 1 from public.appeals a
     where a.subject_kind = 'MODERATION_ACTION'
       and a.subject_id = current_setting('probe.hide_audit', true)
       and a.moderation_action_id = a.subject_id
       and a.appellant_user_id = '00000000-0000-4000-8000-00000000e001'
       and a.status = 'SUBMITTED'
  )
  and exists (
    select 1 from public.appeals a
     where a.subject_kind = 'MODERATION_ACTION'
       and a.subject_id = current_setting('probe.publish_audit', true)
       and a.moderation_action_id = a.subject_id
       and a.appellant_user_id = '00000000-0000-4000-8000-00000000e001'
       and a.status = 'SUBMITTED'
  );

rollback;
