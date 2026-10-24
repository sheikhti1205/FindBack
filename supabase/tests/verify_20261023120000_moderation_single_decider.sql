-- Verification for 20261023120000_moderation_single_decider.sql
--
-- STATUS. NOTHING HERE MAY BE QUOTED AS PASSING until this file has been run
-- on a disposable PostgreSQL 17 chain and the output recorded. The static
-- guards prove text only.
--
-- Run with the local chain harness (never a hosted project):
--
--   FB_SRC=<repo>/supabase FB_CLUSTER_ROOT=<dir> FB_PG_PORT=<port> \
--     node <harness>/chain.mjs \
--     --probe supabase/tests/verify_20261023120000_moderation_single_decider.sql
--
-- EVERY SELECT PROBE IS AN ASSERTION: it returns a row only when the invariant
-- holds, so EMPTY means FAILED. Refusals are caught inside their own block
-- because a raised error aborts the enclosing block.
--
-- The owner policy under test (2026-10-23):
--   1. one moderator decides; that decision is final and attributed to them;
--   2. another moderator is refused while the decision stands;
--   3. the SAME decider may revise, which increments the generation;
--   4. a consumer re-evaluation request reopens the case into the queue;
--   5. an appeal against an OLDER decision does not reopen the current one;
--   6. a new report also opens a new case;
--   7. no second-moderator approval exists anywhere in the path.

begin;

-- ---------------------------------------------------------------------------
-- S0. Scratch accounts, capabilities, one reportable post.
-- ---------------------------------------------------------------------------

insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, avatar_url, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000f101', 'sd_owner',    'sd_owner@example.invalid',    '+8801700000101', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f102', 'sd_mod_a',    'sd_mod_a@example.invalid',    '+8801700000102', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f103', 'sd_mod_b',    'sd_mod_b@example.invalid',    '+8801700000103', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f104', 'sd_rep_1',    'sd_rep_1@example.invalid',    '+8801700000104', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f105', 'sd_rep_2',    'sd_rep_2@example.invalid',    '+8801700000105', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f106', 'sd_rep_3',    'sd_rep_3@example.invalid',    '+8801700000106', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f107', 'sd_sanctioned', 'sd_sanctioned@example.invalid', '+8801700000107', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f108', 'sd_rep_4',    'sd_rep_4@example.invalid',    '+8801700000108', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f109', 'sd_rep_5',    'sd_rep_5@example.invalid',    '+8801700000109', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f110', 'sd_rep_6',    'sd_rep_6@example.invalid',    '+8801700000110', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f111', 'sd_rep_7',    'sd_rep_7@example.invalid',    '+8801700000111', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f112', 'sd_rep_8',    'sd_rep_8@example.invalid',    '+8801700000112', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f113', 'sd_rep_9',    'sd_rep_9@example.invalid',    '+8801700000113', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f114', 'sd_rep_10',   'sd_rep_10@example.invalid',   '+8801700000114', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f115', 'sd_rep_11',   'sd_rep_11@example.invalid',   '+8801700000115', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f116', 'sd_rep_12',   'sd_rep_12@example.invalid',   '+8801700000116', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f117', 'sd_rep_13',   'sd_rep_13@example.invalid',   '+8801700000117', null, 1, 0, null, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z')
on conflict (id) do nothing;

insert into public.user_roles (user_id, role, granted_by, granted_at)
values
  ('00000000-0000-4000-8000-00000000f102', 'MODERATOR', '00000000-0000-4000-8000-00000000f102', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f103', 'MODERATOR', '00000000-0000-4000-8000-00000000f102', '2026-10-23T00:00:00.000Z')
on conflict do nothing;

insert into public.user_role_capabilities (user_id, capability, granted_by, granted_at)
values
  ('00000000-0000-4000-8000-00000000f102', 'reports_review', '00000000-0000-4000-8000-00000000f102', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f102', 'content_hide',   '00000000-0000-4000-8000-00000000f102', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f102', 'members_warn',   '00000000-0000-4000-8000-00000000f102', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f103', 'reports_review', '00000000-0000-4000-8000-00000000f102', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f103', 'content_hide',   '00000000-0000-4000-8000-00000000f102', '2026-10-23T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f103', 'members_warn',   '00000000-0000-4000-8000-00000000f102', '2026-10-23T00:00:00.000Z')
on conflict do nothing;

insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
values
  ('p-sd-case', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Single decider case',
   'A post one moderator decides about', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-comment', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Comment carrier',
   'The comment case shares this post atom', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-stale', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Stale report carrier',
   'An older open report is not a reopen', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-dismiss', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Dismissal carrier',
   'A dismissal and a content action are one case', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-reopen', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Reopened comment carrier',
   'A comment-only report reopened for review', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-mixed', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Mixed report carrier',
   'Direct and comment reports of one atom', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-deleted', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Deleted comment carrier',
   'Evidence survives comment deletion', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-erased', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Erased evidence carrier',
   'Case membership survives erasure', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-erased-2', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Proactive deletion carrier',
   'A proactive comment action survives deletion', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-erased-3', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Erased appeal carrier',
   'A reported comment, an appeal and erasure', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
  ('p-sd-legacy', '00000000-0000-4000-8000-00000000f101', 'LOST', 'Legacy audit carrier',
   'A pre-migration audit with a live comment parent', 'Electronics', 'OPEN', '2020-01-01',
   '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z')
on conflict (id) do nothing;

insert into public.comments (id, post_id, user_id, body, created_at, updated_at)
values ('c-sd-1', 'p-sd-comment', '00000000-0000-4000-8000-00000000f101', 'A reported comment',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-2', 'p-sd-stale', '00000000-0000-4000-8000-00000000f101', 'A proactive comment decision',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-3', 'p-sd-dismiss', '00000000-0000-4000-8000-00000000f101', 'First dismissed comment',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-4', 'p-sd-dismiss', '00000000-0000-4000-8000-00000000f101', 'Second comment on the atom',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-5', 'p-sd-reopen', '00000000-0000-4000-8000-00000000f101', 'The only reported comment',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-6', 'p-sd-mixed', '00000000-0000-4000-8000-00000000f101', 'A comment on the mixed post',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-7', 'p-sd-deleted', '00000000-0000-4000-8000-00000000f101', 'A comment deleted before the decision',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-8', 'p-sd-deleted', '00000000-0000-4000-8000-00000000f101', 'A comment deleted after the decision',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-9', 'p-sd-erased', '00000000-0000-4000-8000-00000000f101', 'An open receipt after erasure',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-10', 'p-sd-erased-2', '00000000-0000-4000-8000-00000000f101', 'A proactive comment action',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-11', 'p-sd-erased-3', '00000000-0000-4000-8000-00000000f101', 'A reported comment before erasure',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
       ('c-sd-legacy', 'p-sd-legacy', '00000000-0000-4000-8000-00000000f101', 'A legacy proactive comment',
        '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z')
on conflict (id) do nothing;

-- S1. The decision store is internal: no client grant, no policy.
select 'S1 the decision store is not client-readable' as probe
where has_table_privilege('authenticated', 'public.moderation_case_decisions', 'SELECT') = false
  and has_table_privilege('anon', 'public.moderation_case_decisions', 'SELECT') = false
  and (select relrowsecurity from pg_class where oid = 'public.moderation_case_decisions'::regclass) = true
  and 0 = (select count(*) from pg_policy where polrelid = 'public.moderation_case_decisions'::regclass);

-- ---------------------------------------------------------------------------
-- S2. A reporter files the first report; A decides; B is refused.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f104', true);

do $$
begin
  if public.findback_submit_report('POST', 'p-sd-case', 'HARASSMENT', 'First report') is null then
    raise exception 'S2 FAILED: the first report was not accepted';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation('POST', 'p-sd-case', 'HIDE', 'HARASSMENT', 'A decides', null, null);
  if v_audit is null then
    raise exception 'S2 FAILED: moderator A could not decide';
  end if;
  perform set_config('probe.sd_audit_a', v_audit, true);
  raise notice 'S2 ok: moderator A hid the post';
end;
$$;

reset role;

select 'S2 the decision is attributed to A, generation 1' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'POST' and d.target_id = 'p-sd-case'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
     and d.decision_action = 'HIDE'
     and d.generation = 1
     and d.audit_id = current_setting('probe.sd_audit_a', true)
     and d.reopened_at is null
)
and (select moderation_visibility from public.item_posts where id = 'p-sd-case') = 'HIDDEN';

-- B holds the same capability and a sheet that is now stale: refused.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  begin
    perform public.findback_apply_moderation('POST', 'p-sd-case', 'HIDE', 'SPAM_OR_DUPLICATE', 'B tries', null, null);
    raise exception 'S2b FAILED: a second moderator reversed a final decision' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'MODERATION_DECISION_FINAL' then
      raise exception 'S2b FAILED: wrong refusal token (%)', sqlerrm;
    end if;
    raise notice 'S2b ok: a second moderator is refused with MODERATION_DECISION_FINAL';
  end;
end;
$$;

reset role;

select 'S2b the post stays hidden, the decision still belongs to A' as probe
where (select moderation_visibility from public.item_posts where id = 'p-sd-case') = 'HIDDEN'
  and (select decider_user_id from public.moderation_case_decisions
        where target_type = 'POST' and target_id = 'p-sd-case') = '00000000-0000-4000-8000-00000000f102'
  and (select generation from public.moderation_case_decisions
        where target_type = 'POST' and target_id = 'p-sd-case') = 1;

-- ---------------------------------------------------------------------------
-- S3. The same decider may revise; the generation increments.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation('POST', 'p-sd-case', 'PUBLISH', 'HARASSMENT', 'A reconsiders', null, null);
  if v_audit is null then
    raise exception 'S3 FAILED: the original decider could not revise';
  end if;
  perform set_config('probe.sd_audit_a2', v_audit, true);
  raise notice 'S3 ok: moderator A revised their own decision';
end;
$$;

reset role;

select 'S3 the revision is generation 2 and published' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'POST' and d.target_id = 'p-sd-case'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
     and d.decision_action = 'PUBLISH'
     and d.generation = 2
     and d.audit_id = current_setting('probe.sd_audit_a2', true)
)
and (select moderation_visibility from public.item_posts where id = 'p-sd-case') = 'PUBLISHED'
and exists (
  select 1 from public.admin_audit_log l
   where l.id = current_setting('probe.sd_audit_a2', true)
     and l.new_state->>'decision_generation' = '2'
);

-- B is still refused after the revision.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  begin
    perform public.findback_apply_moderation('POST', 'p-sd-case', 'HIDE', 'OTHER', 'B again', null, null);
    raise exception 'S3b FAILED: a second moderator acted after a revision' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    raise notice 'S3b ok: the revised decision is still A''s';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- S4. A consumer re-evaluation request against the CURRENT decision reopens.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f101', true);

do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_appeal(
    'MODERATION_ACTION', current_setting('probe.sd_audit_a2', true), 'Please look at this again.'
  );
  if v_id is null then
    raise exception 'S4 FAILED: the author could not ask for re-evaluation';
  end if;
  perform set_config('probe.sd_appeal', v_id, true);
  raise notice 'S4 ok: the author asked for re-evaluation';
end;
$$;

reset role;

select 'S4 the current decision is reopened by the consumer request' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'POST' and d.target_id = 'p-sd-case'
     and d.reopened_at is not null
     and d.reopened_by_appeal_id = current_setting('probe.sd_appeal', true)
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
);

-- The moderator queue sees it again, as an actionable OPEN case.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

select 'S4 the reopened case re-enters the moderation queue' as probe
from public.findback_moderation_queue(200) q
where q.target_type = 'POST' and q.target_id = 'p-sd-case' and q.status = 'OPEN';

select 'S4 the target reader exposes the request without the decider id' as probe
where (public.findback_moderation_target('POST', 'p-sd-case')->'reopen'->>'message') = 'Please look at this again.'
  and (public.findback_moderation_target('POST', 'p-sd-case')->'reopen'->>'appeal_id') = current_setting('probe.sd_appeal', true)
  and (public.findback_moderation_target('POST', 'p-sd-case')->'decision'->>'generation') = '2'
  and not (public.findback_moderation_target('POST', 'p-sd-case') ? 'decider_user_id');

-- Any capability holder may now decide, as a NEW generation.
do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation('POST', 'p-sd-case', 'HIDE', 'HARASSMENT', 'B after re-evaluation', null, null);
  if v_audit is null then
    raise exception 'S4b FAILED: another moderator could not decide a reopened case';
  end if;
  perform set_config('probe.sd_audit_b', v_audit, true);
  raise notice 'S4b ok: moderator B decided the reopened case';
end;
$$;

reset role;

select 'S4b the reopened decision belongs to B, generation 3, reopen cleared' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'POST' and d.target_id = 'p-sd-case'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f103'
     and d.decision_action = 'HIDE'
     and d.generation = 3
     and d.reopened_at is null
     and d.reopened_by_appeal_id is null
)
and (select moderation_visibility from public.item_posts where id = 'p-sd-case') = 'HIDDEN';

select 'S4b the queue no longer lists the decided case' as probe
where not exists (
  select 1 from public.findback_moderation_queue(200) q
   where q.target_type = 'POST' and q.target_id = 'p-sd-case'
);

-- A is now the "other" moderator and is refused.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
begin
  begin
    perform public.findback_apply_moderation('POST', 'p-sd-case', 'PUBLISH', 'OTHER', 'A tries again', null, null);
    raise exception 'S4c FAILED: the previous decider reversed the new decision' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    raise notice 'S4c ok: ownership moved to the new decider';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- S5. An appeal against an OLDER decision does not reopen the current case.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f101', true);

do $$
begin
  if public.findback_submit_appeal(
       'MODERATION_ACTION', current_setting('probe.sd_audit_a', true), 'The first decision was wrong too.'
     ) is null then
    raise exception 'S5 FAILED: the older decision could not be appealed';
  end if;
end;
$$;

reset role;

select 'S5 the older appeal was recorded but did not reopen the current decision' as probe
where (select reopened_at from public.moderation_case_decisions
        where target_type = 'POST' and target_id = 'p-sd-case') is null
  and 1 = (select count(*) from public.appeals
            where moderation_action_id = current_setting('probe.sd_audit_a', true)
              and status = 'SUBMITTED');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

select 'S5 the decided case is still absent from the queue' as probe
where not exists (
  select 1 from public.findback_moderation_queue(200) q
   where q.target_type = 'POST' and q.target_id = 'p-sd-case'
);

-- ---------------------------------------------------------------------------
-- S6. A new report also opens a new case; no second-reviewer approval exists.
-- ---------------------------------------------------------------------------

-- The current decider restores visibility first: a reporter cannot report a
-- hidden post, so the new-report path is exercised on a visible one.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  if public.findback_apply_moderation('POST', 'p-sd-case', 'PUBLISH', 'OTHER', 'B restores it', null, null) is null then
    raise exception 'S6 FAILED: the current decider could not restore visibility';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f105', true);

do $$
begin
  if public.findback_submit_report('POST', 'p-sd-case', 'SPAM_OR_DUPLICATE', 'A new problem') is null then
    raise exception 'S6 FAILED: a new report against the decided post was not accepted';
  end if;
end;
$$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

select 'S6 a new report reopens the case for any moderator' as probe
from public.findback_moderation_queue(200) q
where q.target_type = 'POST' and q.target_id = 'p-sd-case' and q.status = 'OPEN';

-- A DIFFERENT moderator may act on that new report without any approval step.
do $$
begin
  if public.findback_apply_moderation('POST', 'p-sd-case', 'HIDE', 'SPAM_OR_DUPLICATE', 'A handles the new report', null, null) is null then
    raise exception 'S6b FAILED: the new case could not be decided';
  end if;
end;
$$;

reset role;

select 'S6b no second-moderator approval is required or recorded' as probe
where (select decider_user_id from public.moderation_case_decisions
        where target_type = 'POST' and target_id = 'p-sd-case') = '00000000-0000-4000-8000-00000000f102'
  and (select generation from public.moderation_case_decisions
        where target_type = 'POST' and target_id = 'p-sd-case') = 5
  and (select moderation_visibility from public.item_posts where id = 'p-sd-case') = 'HIDDEN'
  and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'moderation_case_decisions'
       and column_name in ('second_reviewer_id', 'approved_by', 'quorum')
  );

-- ---------------------------------------------------------------------------
-- S7. A COMMENT content action owns ONLY the comment atom.
--
--     OWNER AMENDMENT 2026-10-24 supersedes the earlier comment->post coupling:
--     a report or decision about a comment must never hide, publish or own its
--     parent post, and an independent post case can neither reverse nor inherit
--     the comment verdict. The two atoms are decided separately.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f106', true);

do $$
begin
  if public.findback_submit_report('COMMENT', 'c-sd-1', 'HARASSMENT', 'Reported comment') is null then
    raise exception 'S7 FAILED: the comment report was not accepted';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation('COMMENT', 'c-sd-1', 'HIDE', 'HARASSMENT', 'A hides the comment', null, null);
  if v_audit is null then
    raise exception 'S7 FAILED: the comment decision was not recorded';
  end if;
  perform set_config('probe.sd_comment_audit', v_audit, true);
end;
$$;

reset role;

select 'S7 a comment decision is stored on the comment atom' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'COMMENT' and d.target_id = 'c-sd-1'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
     and d.audit_id = current_setting('probe.sd_comment_audit', true)
     and d.generation = 1
)
and (select moderation_visibility from public.comments where id = 'c-sd-1') = 'HIDDEN'
and (select moderation_visibility from public.item_posts where id = 'p-sd-comment') = 'PUBLISHED'
and exists (
  select 1 from public.admin_audit_log l where l.id=current_setting('probe.sd_comment_audit',true)
    and (l.new_state->>'decision_generation')::integer=1
    and l.previous_state->>'moderation_visibility'='PUBLISHED'
    and l.new_state->>'moderation_visibility'='HIDDEN'
)
and exists (
  select 1 from public.content_reports r where r.target_type='COMMENT' and r.target_id='c-sd-1'
    and r.status='ACTIONED' and r.internal_note='A hides the comment'
)
and not exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'POST' and d.target_id = 'p-sd-comment'
);

-- S7b: a post decision is independent; it cannot reverse the comment verdict.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  if public.findback_apply_moderation('POST', 'p-sd-comment', 'HIDE', 'OTHER', 'B hides the carrier post', null, null) is null then
    raise exception 'S7b FAILED: an independent post decision was refused';
  end if;
end;
$$;

reset role;

select 'S7b a post decision does not own the comment atom' as probe
where (select moderation_visibility from public.item_posts where id = 'p-sd-comment') = 'HIDDEN'
  and (select moderation_visibility from public.comments where id = 'c-sd-1') = 'HIDDEN'
  and (select decider_user_id from public.moderation_case_decisions
        where target_type = 'COMMENT' and target_id = 'c-sd-1') = '00000000-0000-4000-8000-00000000f102'
  and (select generation from public.moderation_case_decisions
        where target_type = 'COMMENT' and target_id = 'c-sd-1') = 1;

-- S7c: the comment decider revises only the comment.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
begin
  if public.findback_apply_moderation('COMMENT', 'c-sd-1', 'PUBLISH', 'OTHER', 'A restores the comment', null, null) is null then
    raise exception 'S7c FAILED: the comment decider could not revise the comment';
  end if;
end;
$$;

reset role;

select 'S7c the comment decider revises only the comment' as probe
where (select moderation_visibility from public.comments where id = 'c-sd-1') = 'PUBLISHED'
  and (select generation from public.moderation_case_decisions
        where target_type = 'COMMENT' and target_id = 'c-sd-1') = 2
  and (select moderation_visibility from public.item_posts where id = 'p-sd-comment') = 'HIDDEN'
  and exists (
    select 1 from public.admin_audit_log l where l.target_type='COMMENT' and l.target_id='c-sd-1'
      and (l.new_state->>'decision_generation')::integer=2
      and l.previous_state->>'moderation_visibility'='HIDDEN'
      and l.new_state->>'moderation_visibility'='PUBLISHED'
  );

-- S7d: the post decider restores the post independently.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  if public.findback_apply_moderation('POST', 'p-sd-comment', 'PUBLISH', 'OTHER', 'B restores the carrier post', null, null) is null then
    raise exception 'S7d FAILED: the post decider could not restore the post';
  end if;
end;
$$;

reset role;

select 'S7d the post decider restores only the post' as probe
where (select moderation_visibility from public.item_posts where id = 'p-sd-comment') = 'PUBLISHED'
  and (select moderation_visibility from public.comments where id = 'c-sd-1') = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- S8. A deleted decider is still the owner: no takeover.
-- ---------------------------------------------------------------------------

-- The column is intentionally text without a foreign key, and never nullable.
select 'S8 the decider id is immutable and non-null' as probe
where (select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'moderation_case_decisions'
          and column_name = 'decider_user_id') = 'NO'
  and not exists (
    select 1 from information_schema.table_constraints tc
     join information_schema.key_column_usage k
       on k.constraint_name = tc.constraint_name and k.constraint_schema = tc.constraint_schema
    where tc.table_schema = 'public' and tc.table_name = 'moderation_case_decisions'
      and tc.constraint_type = 'FOREIGN KEY' and k.column_name = 'decider_user_id'
  );

update public.moderation_case_decisions
   set decider_user_id = '00000000-0000-4000-8000-00000000dead'
 where target_type = 'POST' and target_id = 'p-sd-case';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  begin
    perform public.findback_apply_moderation('POST', 'p-sd-case', 'PUBLISH', 'OTHER', 'B takes over', null, null);
    raise exception 'S8 FAILED: a deleted decider''s case was taken over' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    raise notice 'S8 ok: a deleted decider still owns the decision';
  end;
end;
$$;

reset role;

select 'S8 the decision and visibility are untouched' as probe
where (select decider_user_id from public.moderation_case_decisions
        where target_type = 'POST' and target_id = 'p-sd-case') = '00000000-0000-4000-8000-00000000dead'
  and (select moderation_visibility from public.item_posts where id = 'p-sd-case') = 'HIDDEN';

-- ---------------------------------------------------------------------------
-- S9. A SANCTION appeal reopens the case that produced the sanction.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
begin
  if public.findback_apply_moderation(
       'USER', '00000000-0000-4000-8000-00000000f107', 'WARN', 'HARASSMENT', 'First warning', null, null
     ) is null then
    raise exception 'S9 FAILED: the warning was not recorded';
  end if;
end;
$$;

reset role;

select 'S9 the USER decision records the sanction it created' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'USER' and d.target_id = '00000000-0000-4000-8000-00000000f107'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
     and d.decision_action = 'WARN'
     and d.sanction_id is not null
     and d.generation = 1
);

select set_config('probe.sd_sanction', (
  select sanction_id from public.moderation_case_decisions
   where target_type = 'USER' and target_id = '00000000-0000-4000-8000-00000000f107'
), true);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f107', true);

do $$
begin
  if public.findback_submit_appeal(
       'SANCTION', current_setting('probe.sd_sanction', true), 'This warning is a mistake.'
     ) is null then
    raise exception 'S9 FAILED: the sanctioned user could not ask for re-evaluation';
  end if;
end;
$$;

reset role;

select 'S9 the sanction appeal reopens the USER case' as probe
where (select reopened_at from public.moderation_case_decisions
        where target_type = 'USER' and target_id = '00000000-0000-4000-8000-00000000f107') is not null;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

select 'S9 the reopened sanction case re-enters the queue' as probe
from public.findback_moderation_queue(200) q
where q.target_type = 'USER' and q.target_id = '00000000-0000-4000-8000-00000000f107' and q.status = 'OPEN';

do $$
begin
  if public.findback_apply_moderation(
       'USER', '00000000-0000-4000-8000-00000000f107', 'WARN', 'HARASSMENT', 'B after re-evaluation', null, null
     ) is null then
    raise exception 'S9b FAILED: another moderator could not decide the reopened sanction case';
  end if;
end;
$$;

reset role;

select 'S9b the reopened sanction decision belongs to B, generation 2' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'USER' and d.target_id = '00000000-0000-4000-8000-00000000f107'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f103'
     and d.generation = 2
     and d.reopened_at is null
     and d.sanction_id is not null
);

-- ---------------------------------------------------------------------------
-- S10. Comment and post atoms are independent (owner amendment 2026-10-24).
--
--      A COMMENT decision closes only the comment's own reports. A POST report
--      that predates it stays OPEN, the post stays PUBLISHED and no POST
--      decision is created. A moderator may then decide the POST on its own
--      merits; that independent decision closes the older POST report and does
--      not revise, inherit or reopen A's comment decision.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f108', true);

do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('POST', 'p-sd-stale', 'SPAM_OR_DUPLICATE', 'Older post report');
  if v_id is null then
    raise exception 'S10 FAILED: the post report was not accepted';
  end if;
  perform set_config('probe.sd_stale_report', v_id, true);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
begin
  if public.findback_apply_moderation('COMMENT', 'c-sd-2', 'HIDE', 'OTHER', 'A hides the comment', null, null) is null then
    raise exception 'S10 FAILED: the comment decision was not recorded';
  end if;
end;
$$;

reset role;

select 'S10 a comment decision leaves the post report and the post alone' as probe
where exists (
  select 1 from public.content_reports r
   where r.target_type = 'POST' and r.target_id = 'p-sd-stale' and r.status = 'OPEN'
)
and (select moderation_visibility from public.item_posts where id = 'p-sd-stale') = 'PUBLISHED'
and exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'COMMENT' and d.target_id = 'c-sd-2'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
     and d.generation = 1
)
and not exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'POST' and d.target_id = 'p-sd-stale'
);

-- S10b: an independent POST decision is allowed and closes only the POST report.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  if public.findback_apply_moderation('POST', 'p-sd-stale', 'HIDE', 'SPAM_OR_DUPLICATE', 'B decides the older post report', null, null) is null then
    raise exception 'S10b FAILED: the independent post decision was refused';
  end if;
end;
$$;

reset role;

select 'S10b the post decision closes only the post report' as probe
where (select moderation_visibility from public.item_posts where id = 'p-sd-stale') = 'HIDDEN'
  and exists (
    select 1 from public.content_reports r
     where r.target_type = 'POST' and r.target_id = 'p-sd-stale' and r.status = 'ACTIONED'
  )
  and exists (
    select 1 from public.moderation_case_decisions d
     where d.target_type = 'POST' and d.target_id = 'p-sd-stale'
       and d.decider_user_id = '00000000-0000-4000-8000-00000000f103'
       and d.generation = 1
       and current_setting('probe.sd_stale_report', true) = any(d.closed_report_ids)
       and current_setting('probe.sd_stale_report', true) = any(d.known_report_ids)
  )
  and exists (
    select 1 from public.moderation_case_decisions d
     where d.target_type = 'COMMENT' and d.target_id = 'c-sd-2'
       and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
       and d.generation = 1
  );

-- S10c: the comment owner cannot rewrite the independent post decision.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
begin
  begin
    perform public.findback_apply_moderation('POST', 'p-sd-stale', 'PUBLISH', 'OTHER', 'A tries the post atom', null, null);
    raise exception 'S10c FAILED: the comment owner rewrote the post decision' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'MODERATION_DECISION_FINAL' then
      raise exception 'S10c FAILED: wrong refusal token (%)', sqlerrm;
    end if;
    raise notice 'S10c ok: the post decision belongs to its own decider';
  end;
end;
$$;

reset role;

select 'S10c the post verdict and generation are unchanged' as probe
where (select moderation_visibility from public.item_posts where id = 'p-sd-stale') = 'HIDDEN'
  and (select generation from public.moderation_case_decisions
        where target_type = 'POST' and target_id = 'p-sd-stale') = 1;


-- ---------------------------------------------------------------------------
-- S11. Dismissal and content action on the SAME COMMENT are one comment case.
--
--      OWNER AMENDMENT 2026-10-24: the case is the comment, not its parent
--      post. A dismissal and a hide of the same comment share one decision and
--      one generation; another moderator cannot reverse either. A different
--      comment, and the parent post, are independent cases. The parent post
--      action is therefore allowed and does not touch the comment verdict.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f109', true);
do $$
begin
  if public.findback_submit_report('COMMENT', 'c-sd-3', 'HARASSMENT', 'First comment report') is null then
    raise exception 'S11 FAILED: the first comment report was not accepted';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f110', true);
do $$
begin
  if public.findback_submit_report('COMMENT', 'c-sd-4', 'SPAM_OR_DUPLICATE', 'Second comment report') is null then
    raise exception 'S11 FAILED: the second comment report was not accepted';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
begin
  if public.findback_apply_moderation('COMMENT', 'c-sd-3', 'NO_ACTION', 'OTHER', 'A dismisses the comment', null, null) is null then
    raise exception 'S11 FAILED: A could not dismiss the comment';
  end if;
end;
$$;

reset role;

select 'S11 a dismissal is stored on the same comment atom' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'COMMENT' and d.target_id = 'c-sd-3'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
     and d.decision_action = 'NO_ACTION'
     and d.generation = 1
)
and not exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'COMMENT' and d.target_id = 'c-sd-4'
)
and (select moderation_visibility from public.item_posts where id = 'p-sd-dismiss') = 'PUBLISHED'
and exists (
  select 1 from public.content_reports r
   where r.target_type = 'COMMENT' and r.target_id = 'c-sd-3' and r.status = 'DISMISSED'
)
and exists (
  select 1 from public.content_reports r
   where r.target_type = 'COMMENT' and r.target_id = 'c-sd-4' and r.status = 'OPEN'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  begin
    perform public.findback_apply_moderation('COMMENT', 'c-sd-3', 'HIDE', 'HARASSMENT', 'B overrides the dismissal', null, null);
    raise exception 'S11b FAILED: B reversed A''s comment dismissal' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'MODERATION_DECISION_FINAL' then
      raise exception 'S11b FAILED: wrong refusal token (%)', sqlerrm;
    end if;
    raise notice 'S11b ok: B is refused on the same comment';
  end;
end;
$$;

-- S11c: the parent post is a separate case and may be decided independently.
do $$
begin
  if public.findback_apply_moderation('POST', 'p-sd-dismiss', 'HIDE', 'HARASSMENT', 'B hides the parent independently', null, null) is null then
    raise exception 'S11c FAILED: the independent post decision was refused';
  end if;
end;
$$;

reset role;

select 'S11c the parent post does not inherit the comment verdict' as probe
where (select moderation_visibility from public.item_posts where id = 'p-sd-dismiss') = 'HIDDEN'
  and (select moderation_visibility from public.comments where id = 'c-sd-3') = 'PUBLISHED'
  and (select decision_action from public.moderation_case_decisions
        where target_type = 'COMMENT' and target_id = 'c-sd-3') = 'NO_ACTION'
  and (select generation from public.moderation_case_decisions
        where target_type = 'COMMENT' and target_id = 'c-sd-3') = 1;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
begin
  if public.findback_apply_moderation('COMMENT', 'c-sd-3', 'HIDE', 'HARASSMENT', 'A revises their own decision', null, null) is null then
    raise exception 'S11d FAILED: the original decider could not revise';
  end if;
end;
$$;

reset role;

select 'S11d the same decider revises one comment generation' as probe
where (select moderation_visibility from public.comments where id = 'c-sd-3') = 'HIDDEN'
  and exists (
    select 1 from public.moderation_case_decisions d
     where d.target_type = 'COMMENT' and d.target_id = 'c-sd-3'
       and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
       and d.decision_action = 'HIDE'
       and d.generation = 2
  )
  and exists (
    select 1 from public.content_reports r
     where r.target_type = 'COMMENT' and r.target_id = 'c-sd-4' and r.status = 'OPEN'
  )
  and exists (
    select 1 from public.moderation_case_decisions d
     where d.target_type = 'POST' and d.target_id = 'p-sd-dismiss'
       and d.decider_user_id = '00000000-0000-4000-8000-00000000f103'
       and d.generation = 1
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

-- Reverse direction: after A's HIDE, B cannot dismiss the SAME COMMENT.
do $$ begin
  begin
    perform public.findback_apply_moderation('COMMENT','c-sd-3','NO_ACTION','OTHER','B tries to dismiss the hide',null,null);
    raise exception 'S11 reverse FAILED: B dismissed another decider''s hidden comment' using errcode='0A000';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MODERATION_DECISION_FINAL' then raise; end if;
  end;
end $$;
reset role;
select 'S11 reverse refusal changes no comment, report, audit or generation' as probe
where (select moderation_visibility from public.comments where id='c-sd-3')='HIDDEN'
  and (select generation from public.moderation_case_decisions where target_type='COMMENT' and target_id='c-sd-3')=2
  and (select decision_action from public.moderation_case_decisions where target_type='COMMENT' and target_id='c-sd-3')='HIDE'
  and (select count(*) from public.admin_audit_log where target_type='COMMENT' and target_id='c-sd-3')=2
  and not exists(select 1 from public.content_reports where target_type='COMMENT' and target_id='c-sd-3' and status<>'DISMISSED');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

do $$
begin
  if public.findback_apply_moderation('COMMENT', 'c-sd-4', 'NO_ACTION', 'OTHER', 'B dismisses the second comment', null, null) is null then
    raise exception 'S11e FAILED: an independent comment case was refused';
  end if;
end;
$$;

reset role;

select 'S11e another comment case is decided independently' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'COMMENT' and d.target_id = 'c-sd-4'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f103'
     and d.decision_action = 'NO_ACTION'
     and d.generation = 1
)
and exists (
  select 1 from public.content_reports r
   where r.target_type = 'COMMENT' and r.target_id = 'c-sd-4' and r.status = 'DISMISSED'
)
and (select generation from public.moderation_case_decisions
      where target_type = 'COMMENT' and target_id = 'c-sd-3') = 2;

-- S11f: the reverse ordering on the SAME comment is still refused.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);

do $$
begin
  begin
    perform public.findback_apply_moderation('COMMENT', 'c-sd-4', 'HIDE', 'HARASSMENT', 'A reverses B''s dismissal', null, null);
    raise exception 'S11f FAILED: a comment decision was reversed by another moderator' using errcode = '0A000';
  exception when sqlstate 'P0001' then
    raise notice 'S11f ok: the reverse ordering is refused';
  end;
end;
$$;

select 'S11g the comment reader shows the comment atom decision' as probe
where (public.findback_moderation_target('COMMENT', 'c-sd-3')->'decision'->>'action') = 'HIDE'
  and (public.findback_moderation_target('COMMENT', 'c-sd-3')->'decision'->>'generation')::int = 2
  and (public.findback_moderation_target('COMMENT', 'c-sd-4')->'decision'->>'action') = 'NO_ACTION'
  and (public.findback_moderation_target('COMMENT', 'c-sd-4')->'decision'->>'generation')::int = 1;

-- ---------------------------------------------------------------------------
-- S12. A reopened comment-origin case keeps its report evidence and history.
--
--      Owner amendment: the queue row for the reopened COMMENT must count its
--      report, the target reader must project its snapshot and the COMMENT
--      audit outcome, and decision/reopen must come from the same case.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f111', true);
do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('COMMENT', 'c-sd-5', 'HARASSMENT', 'The comment that was hidden');
  if v_id is null then
    raise exception 'S12 FAILED: the comment report was not accepted';
  end if;
  perform set_config('probe.sd_reopen_report', v_id, true);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation('COMMENT', 'c-sd-5', 'HIDE', 'HARASSMENT', 'A hides only the comment', null, null);
  if v_audit is null then
    raise exception 'S12 FAILED: the comment decision was not recorded';
  end if;
  perform set_config('probe.sd_reopen_audit', v_audit, true);
end;
$$;

reset role;

select 'S12 the decision is on the comment atom with a COMMENT audit' as probe
where exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'COMMENT' and d.target_id = 'c-sd-5'
     and d.decider_user_id = '00000000-0000-4000-8000-00000000f102'
     and d.audit_id = current_setting('probe.sd_reopen_audit', true)
     and d.generation = 1
)
and exists (
  select 1 from public.admin_audit_log l
   where l.id = current_setting('probe.sd_reopen_audit', true)
     and l.target_type = 'COMMENT' and l.target_id = 'c-sd-5' and l.action = 'HIDE'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f101', true);
do $$
begin
  if public.findback_submit_appeal(
       'MODERATION_ACTION', current_setting('probe.sd_reopen_audit', true), 'Please re-evaluate this.'
     ) is null then
    raise exception 'S12 FAILED: the author could not ask for re-evaluation';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

select 'S12 the queue counts the comment report on the COMMENT case' as probe
from public.findback_moderation_queue(200) q
where q.target_type = 'COMMENT' and q.target_id = 'c-sd-5'
  and q.status = 'OPEN'
  and q.current_visibility = 'HIDDEN'
  and q.report_count = 1
  and q.reasons @> array['HARASSMENT']::text[];

select 'S12 the COMMENT reader projects its evidence and audit' as probe
where exists (
  select 1 from jsonb_array_elements(public.findback_moderation_target('COMMENT', 'c-sd-5')->'reports') e
   where e->>'id' = current_setting('probe.sd_reopen_report', true)
     and e->>'reason' = 'HARASSMENT'
     and e->>'status' = 'ACTIONED'
     and e->'evidence'->>'target_type' = 'COMMENT'
     and e->'evidence'->>'post_id' = 'p-sd-reopen'
)
and exists (
  select 1 from jsonb_array_elements(public.findback_moderation_target('COMMENT', 'c-sd-5')->'outcomes') e
   where e->>'action' = 'HIDE'
     and e->>'reason' = 'HARASSMENT'
)
and (public.findback_moderation_target('COMMENT', 'c-sd-5')->'decision'->>'action') = 'HIDE'
and (public.findback_moderation_target('COMMENT', 'c-sd-5')->'target'->>'moderation_visibility') = 'HIDDEN'
and (public.findback_moderation_target('COMMENT', 'c-sd-5')->'decision'->>'generation')::int = 1
and (public.findback_moderation_target('COMMENT', 'c-sd-5')->'reopen'->>'message') = 'Please re-evaluate this.'
and jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-reopen')->'reports') = 0
and (public.findback_moderation_target('POST', 'p-sd-reopen')->'decision') = 'null'::jsonb;

do $$
begin
  if public.findback_apply_moderation('COMMENT', 'c-sd-5', 'PUBLISH', 'HARASSMENT', 'B reconsiders the comment', null, null) is null then
    raise exception 'S12b FAILED: B could not decide the reopened case';
  end if;
end;
$$;

reset role;

select 'S12b B owns generation 2 after the re-evaluation' as probe
where (select moderation_visibility from public.item_posts where id = 'p-sd-reopen') = 'PUBLISHED'
  and exists (
    select 1 from public.moderation_case_decisions d
     where d.target_type = 'COMMENT' and d.target_id = 'c-sd-5'
       and d.decider_user_id = '00000000-0000-4000-8000-00000000f103'
       and d.generation = 2
       and d.reopened_at is null
  );

-- Mixed direct and comment reports are separate atoms, even on the same post.

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f112', true);
do $$
begin
  if public.findback_submit_report('COMMENT', 'c-sd-6', 'INAPPROPRIATE_CONTENT', 'Comment report') is null then
    raise exception 'S12c FAILED: the mixed comment report was not accepted';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f113', true);
do $$
begin
  if public.findback_submit_report('POST', 'p-sd-mixed', 'SCAM_OR_MISLEADING', 'Direct report') is null then
    raise exception 'S12c FAILED: the direct report was not accepted';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation('POST', 'p-sd-mixed', 'HIDE', 'SCAM_OR_MISLEADING', 'A hides the mixed atom', null, null);
  if v_audit is null then
    raise exception 'S12c FAILED: the mixed decision was not recorded';
  end if;
  perform set_config('probe.sd_mixed_audit', v_audit, true);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f101', true);
do $$
begin
  if public.findback_submit_appeal(
       'MODERATION_ACTION', current_setting('probe.sd_mixed_audit', true), 'Reconsider the whole post.'
     ) is null then
    raise exception 'S12c FAILED: the mixed case could not be reopened';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

select 'S12c the reopened post case counts only its direct report' as probe
from public.findback_moderation_queue(200) q
where q.target_type = 'POST' and q.target_id = 'p-sd-mixed'
  and q.status = 'OPEN'
  and q.report_count = 1
  and q.reasons = array['SCAM_OR_MISLEADING']::text[];

select 'S12c the mixed readers keep their reports separate' as probe
where jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-mixed')->'reports') = 1
  and jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-mixed')->'outcomes') = 1
  and (public.findback_moderation_target('POST', 'p-sd-mixed')->'reopen'->>'message') = 'Reconsider the whole post.'
  and jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-6')->'reports') = 1
  and (public.findback_moderation_target('COMMENT', 'c-sd-6')->'reports'->0->>'status') = 'OPEN'
  and (public.findback_moderation_target('COMMENT', 'c-sd-6')->'decision') = 'null'::jsonb;


-- ---------------------------------------------------------------------------
-- S13. Deleting a comment must not delete its retained case evidence.
--
--      Exact COMMENT identity survives the live row without falling back to
--      POST. Its receipt/snapshot/history stay readable to staff, independent
--      of its sibling and parent. A missing target can be dismissed, not hidden.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f114', true);
do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('COMMENT', 'c-sd-7', 'HARASSMENT', 'Reported before deletion');
  if v_id is null then
    raise exception 'S13 FAILED: the first report was not accepted';
  end if;
  perform set_config('probe.sd_deleted_report', v_id, true);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f115', true);
do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('COMMENT', 'c-sd-8', 'SPAM_OR_DUPLICATE', 'Reported before its own deletion');
  if v_id is null then
    raise exception 'S13 FAILED: the second report was not accepted';
  end if;
  perform set_config('probe.sd_deleted_report_2', v_id, true);
end;
$$;

reset role;

-- The moderator queue must still see the open case after one comment row goes.
delete from public.comments where id = 'c-sd-7';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

select 'S13 the deleted comment report stays on the queue atom' as probe
from public.findback_moderation_queue(200) q
where q.target_type = 'COMMENT' and q.target_id = 'c-sd-7'
  and q.status = 'OPEN'
  and q.report_count = 1
  and q.reasons = array['HARASSMENT']::text[];

select 'S13 each COMMENT reader keeps only its own report after deletion' as probe
where jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-7')->'reports') = 1
  and jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-8')->'reports') = 1
  and jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-deleted')->'reports') = 0
  and exists (
    select 1 from jsonb_array_elements(public.findback_moderation_target('COMMENT', 'c-sd-7')->'reports') e
     where e->>'id' = current_setting('probe.sd_deleted_report', true)
       and e->>'status' = 'OPEN'
       and e->'evidence'->>'target_type' = 'COMMENT'
       and e->'evidence'->>'post_id' = 'p-sd-deleted'
  )
  and (public.findback_moderation_target('COMMENT', 'c-sd-7')->'decision'->>'action') is null
  and (public.findback_moderation_target('COMMENT', 'c-sd-7')->>'target_exists')::boolean = false;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
begin
  if public.findback_apply_moderation('COMMENT', 'c-sd-7', 'NO_ACTION', 'HARASSMENT', 'The target was deleted', null, null) is null then
    raise exception 'S13b FAILED: the deleted comment report could not be dismissed';
  end if;
  if public.findback_apply_moderation('COMMENT', 'c-sd-8', 'HIDE', 'SPAM_OR_DUPLICATE', 'A hides the second comment', null, null) is null then
    raise exception 'S13b FAILED: the second comment could not be decided';
  end if;
end;
$$;

reset role;

select 'S13b each decision closes only its exact comment report' as probe
where exists (
  select 1 from public.content_reports r
   where r.id = current_setting('probe.sd_deleted_report', true)
     and r.status = 'DISMISSED'
)
and exists (
  select 1 from public.moderation_case_decisions d
   where d.target_type = 'COMMENT' and d.target_id = 'c-sd-7'
     and d.decision_action = 'NO_ACTION'
     and d.generation = 1
     and current_setting('probe.sd_deleted_report', true) = any(d.known_report_ids)
     and not (current_setting('probe.sd_deleted_report_2', true) = any(d.known_report_ids))
)
and exists (
  select 1 from public.content_reports r
   where r.id = current_setting('probe.sd_deleted_report_2', true) and r.status = 'ACTIONED'
)
and (select moderation_visibility from public.item_posts where id = 'p-sd-deleted') = 'PUBLISHED';

-- The live comment is deleted after its COMMENT decision. Its audit must
-- survive through the decision row.
delete from public.comments where id = 'c-sd-8';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

select 'S13c the deleted comment audit survives through the decision' as probe
where jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-8')->'reports') = 1
  and jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-8')->'outcomes') = 1
  and (public.findback_moderation_target('COMMENT', 'c-sd-8')->'decision'->>'action') = 'HIDE'
  and (public.findback_moderation_target('COMMENT', 'c-sd-8')->'decision'->>'generation')::int = 1
  and jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-deleted')->'outcomes') = 0
  and exists (
    select 1 from jsonb_array_elements(public.findback_moderation_target('COMMENT', 'c-sd-8')->'outcomes') e
     where e->>'action' = 'HIDE'
  );


-- ---------------------------------------------------------------------------
-- S14. The canonical association survives physical evidence erasure.
--
--      R12-M2: the receipt's case was inferred from the live comment or the
--      expiring snapshot. After the mandatory 90-day erasure both are gone, so
--      an OPEN receipt vanished from the queue and a deleted comment's history
--      detached. The receipt now stores case_type/case_id durably and every
--      audit has an internal case link; the snapshot still expires to null.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f116', true);
do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('COMMENT', 'c-sd-9', 'HARASSMENT', 'Reported then erased');
  if v_id is null then
    raise exception 'S14 FAILED: the report was not accepted';
  end if;
  perform set_config('probe.sd_erased_report', v_id, true);
end;
$$;

reset role;

delete from public.comments where id = 'c-sd-9';

-- The approved physical erasure, forced with its test seam. This wipes every
-- snapshot and detail in the fixture database; S14 is the final section.
select public.findback_expire_report_evidence(5000, '2099-01-01T00:00:00.000Z');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);

select 'S14 an OPEN receipt survives erasure on the queue' as probe
from public.findback_moderation_queue(200) q
where q.target_type = 'COMMENT' and q.target_id = 'c-sd-9'
  and q.status = 'OPEN'
  and q.report_count = 1
  and q.reasons @> array['HARASSMENT']::text[];

select 'S14 the reader keeps the receipt with null evidence' as probe
where jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-9')->'reports') = 1
  and exists (
    select 1 from jsonb_array_elements(public.findback_moderation_target('COMMENT', 'c-sd-9')->'reports') e
     where e->>'id' = current_setting('probe.sd_erased_report', true)
       and e->>'status' = 'OPEN'
       and (e->'evidence') = 'null'::jsonb
  )
  and (public.findback_moderation_target('COMMENT', 'c-sd-9')->'decision'->>'action') is null
  and jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-erased')->'reports') = 0;

-- A proactive comment action (no report at all), then deletion, then a parent
-- decision. The deleted COMMENT keeps its own history; the new parent decision
-- must neither adopt nor overwrite it.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
begin
  if public.findback_apply_moderation('COMMENT', 'c-sd-10', 'HIDE', 'OTHER', 'A proactive comment hide', null, null) is null then
    raise exception 'S14b FAILED: the proactive comment action was not recorded';
  end if;
end;
$$;

reset role;

delete from public.comments where id = 'c-sd-10';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
begin
  if public.findback_apply_moderation('POST', 'p-sd-erased-2', 'PUBLISH', 'OTHER', 'A revises the parent', null, null) is null then
    raise exception 'S14b FAILED: the parent revision was not recorded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);
set local role authenticated;

select 'S14b a proactive COMMENT action survives deletion independently' as probe
where jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-erased-2')->'outcomes') = 1
  and (public.findback_moderation_target('POST', 'p-sd-erased-2')->'decision'->>'action') = 'PUBLISH'
  and (public.findback_moderation_target('POST', 'p-sd-erased-2')->'decision'->>'generation')::int = 1
  and (public.findback_moderation_target('COMMENT', 'c-sd-10')->'decision'->>'action') = 'HIDE'
  and (public.findback_moderation_target('COMMENT', 'c-sd-10')->'decision'->>'generation')::int = 1
  and jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-10')->'outcomes') = 1;

-- A reported comment, a current appeal, deletion and erasure, then a parent
-- dismissal. The receipt, COMMENT audit and decision remain on the COMMENT
-- case. There is no live row to publish, so re-evaluation must not invent one.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f117', true);
do $$
declare
  v_id text;
begin
  v_id := public.findback_submit_report('COMMENT', 'c-sd-11', 'INAPPROPRIATE_CONTENT', 'Reported before erasure');
  if v_id is null then
    raise exception 'S14c FAILED: the report was not accepted';
  end if;
  perform set_config('probe.sd_erased_report_2', v_id, true);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
declare
  v_audit text;
begin
  v_audit := public.findback_apply_moderation('COMMENT', 'c-sd-11', 'HIDE', 'INAPPROPRIATE_CONTENT', 'A hides the reported comment', null, null);
  if v_audit is null then
    raise exception 'S14c FAILED: the comment decision was not recorded';
  end if;
  perform set_config('probe.sd_erased_audit', v_audit, true);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f101', true);
do $$
begin
  if public.findback_submit_appeal(
       'MODERATION_ACTION', current_setting('probe.sd_erased_audit', true), 'Please look again.'
     ) is null then
    raise exception 'S14c FAILED: the appeal was not recorded';
  end if;
end;
$$;

reset role;

delete from public.comments where id = 'c-sd-11';
select public.findback_expire_report_evidence(5000, '2099-01-01T00:00:00.000Z');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);
do $$
begin
  begin
    perform public.findback_apply_moderation('COMMENT', 'c-sd-11', 'PUBLISH', 'INAPPROPRIATE_CONTENT', 'No live row to publish', null, null);
    raise exception 'S14c FAILED: a deleted comment was published' using errcode = '0A000';
  exception when no_data_found then null;
  end;
  if public.findback_apply_moderation('COMMENT', 'c-sd-11', 'NO_ACTION', 'INAPPROPRIATE_CONTENT', 'B after erasure', null, null) is null then
    raise exception 'S14c FAILED: B could not decide the reopened case';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);
set local role authenticated;

select 'S14c the erased receipt and COMMENT audit stay on the case' as probe
where jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-11')->'reports') = 1
  and exists (
    select 1 from jsonb_array_elements(public.findback_moderation_target('COMMENT', 'c-sd-11')->'reports') e
     where e->>'id' = current_setting('probe.sd_erased_report_2', true)
       and (e->'evidence') = 'null'::jsonb
  )
  and jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-11')->'outcomes') = 2
  and (public.findback_moderation_target('COMMENT', 'c-sd-11')->'decision'->>'action') = 'NO_ACTION'
  and (public.findback_moderation_target('COMMENT', 'c-sd-11')->'decision'->>'generation')::int = 2
  and (public.findback_moderation_target('COMMENT', 'c-sd-11')->'reopen') = 'null'::jsonb
  and (public.findback_moderation_target('POST', 'p-sd-erased-3')->'decision') = 'null'::jsonb
  and jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-erased-3')->'reports') = 0;

reset role;

-- ---------------------------------------------------------------------------
-- S15. Audit association uses exact COMMENT identity, live or deleted.
--
--      This is a post-amendment association test. Actual pre-amendment COMMENT
--      history blocks migration with LEGACY_COMMENT_CASE_REMEDIATION_REQUIRED;
--      it cannot be silently reclassified by this helper.
-- ---------------------------------------------------------------------------

insert into public.admin_audit_log (
  id, actor_user_id, action, target_type, target_id, reason,
  previous_state, new_state, created_at
) values (
  'sd-legacy-comment-audit', '00000000-0000-4000-8000-00000000f102', 'HIDE',
  'COMMENT', 'c-sd-legacy', 'OTHER', '{}'::jsonb, '{}'::jsonb,
  '2026-10-20T00:00:00.000Z'
);

select public.findback_backfill_moderation_case_audits();

select 'S15 a comment audit maps to the exact comment' as probe
where exists (
  select 1 from public.moderation_case_audits ca
   where ca.audit_id = 'sd-legacy-comment-audit'
     and ca.case_type = 'COMMENT'
     and ca.case_id = 'c-sd-legacy'
);

-- A parent revision after the backfill: the legacy action must stay on the
-- parent history, and the deleted-COMMENT reader must still resolve the case.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f102', true);
do $$
begin
  if public.findback_apply_moderation('POST', 'p-sd-legacy', 'PUBLISH', 'OTHER', 'A revises the legacy parent', null, null) is null then
    raise exception 'S15 FAILED: the parent revision was not recorded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);
set local role authenticated;

select 'S15 parent and comment histories are separate before deletion' as probe
where jsonb_array_length(public.findback_moderation_target('POST', 'p-sd-legacy')->'outcomes') = 1
  and jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-legacy')->'outcomes') = 1
  and (public.findback_moderation_target('POST', 'p-sd-legacy')->'decision'->>'generation')::int = 1;

reset role;
delete from public.comments where id = 'c-sd-legacy';

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f103', true);
set local role authenticated;

select 'S15 deleted COMMENT retains only its exact audit history' as probe
where (public.findback_moderation_target('COMMENT', 'c-sd-legacy')->'decision') = 'null'::jsonb
  and (public.findback_moderation_target('COMMENT', 'c-sd-legacy')->>'target_exists')::boolean = false
  and jsonb_array_length(public.findback_moderation_target('COMMENT', 'c-sd-legacy')->'outcomes') = 1
  and (public.findback_moderation_target('POST', 'p-sd-legacy')->'decision'->>'generation')::int = 1;

reset role;
select set_config('request.jwt.claim.sub', '', true);

rollback;
