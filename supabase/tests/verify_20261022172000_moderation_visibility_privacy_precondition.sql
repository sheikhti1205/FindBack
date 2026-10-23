-- Verification for 20261022172000_moderation_visibility_privacy_precondition.sql
-- (CF-060 B2a: the moderation-privacy precondition — Residual 1 + Residual 12).
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
--   PGHOST=127.0.0.1 PGPORT=<port> PGUSER=postgres PGDATABASE=findback_sql_test_pre \
--     node scripts/sql-behavior.mjs --apply-chain \
--       --probe supabase/tests/verify_20261022172000_moderation_visibility_privacy_precondition.sql
--
-- The chain MUST include 20261022173000 (the CF-060 B2a/B2b/B2c moderation
-- migration): Section 2 hides a post with that file's REAL moderation writer
-- (`public.findback_apply_moderation`), because the precondition exists to
-- protect against exactly that writer.
--
-- EVERY PROBE IS AN ASSERTION. A SELECT probe returns a row only when its
-- invariant holds, so an empty result means FAILED (the harness reports it as
-- EMPTY and exits non-zero). Every privilege refusal is CAUGHT inside its own
-- block, because a refusal raised in a transaction aborts it.
--
-- The properties under test:
--   1. `authenticated` can no longer read public.item_posts.moderation_visibility
--      (Residual 1) and holds NO table-level SELECT on the table, so a client
--      `select *` fails with 42501 rather than silently exposing the column;
--   2. the item_posts SELECT policy carries the visibility atom — the owner
--      clause AND the moderation atom — and nothing else (D11: one policy,
--      one predicate);
--   3. a stranger reads a HIDDEN post as ZERO rows on every surface (base
--      table, view, feed reader) and the reply for a hidden id is
--      byte-identical to the reply for an id that never existed (contract
--      §13.1);
--   4. the author still reads their own HIDDEN row, on every surface (D10);
--   5. `public.findback_visible_posts` projects exactly the fourteen granted
--      columns plus blocked_author, and does NOT project moderation_visibility;
--   6. `anon` reads nothing at all;
--   7. the inbox reader (a DEFINER, and therefore not covered by the policy)
--      still filters a notification whose target post is HIDDEN (D21);
--   8. no client-reachable INVOKER reader carries the atom: it is decided once,
--      by the policy.
--
-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes.
-- ---------------------------------------------------------------------------

-- P1. Residual 1, the grant side: the moderation column privilege is GONE for
--     `authenticated` (and `anon` never had it). The column itself still
--     exists — this file moves the predicate, it does not remove the state.
select 'P1 the moderation column privilege is revoked from every client role' as probe
where not has_column_privilege('authenticated', 'public.item_posts', 'moderation_visibility', 'SELECT')
  and not has_column_privilege('anon', 'public.item_posts', 'moderation_visibility', 'SELECT')
  and not has_column_privilege('public', 'public.item_posts', 'moderation_visibility', 'SELECT')
  and exists (
    select 1 from pg_attribute a
    where a.attrelid = 'public.item_posts'::regclass
      and a.attname = 'moderation_visibility'
      and a.attnotnull
      and not a.attisdropped
  );

-- P2. The grant stays COLUMN-SCOPED: `authenticated` holds NO table-level
--     SELECT on item_posts, so `select *` cannot widen itself back to the
--     revoked column, while the fourteen granted columns are still readable.
--     (This is the measured consequence of the revoke, stated as an invariant:
--     the client wildcard now fails with 42501 — see B5.)
select 'P2 the item_posts grant stays column-scoped and keeps its fourteen columns' as probe
where not has_table_privilege('authenticated', 'public.item_posts', 'SELECT')
  and not has_table_privilege('anon', 'public.item_posts', 'SELECT')
  and 14 = (
    select count(*)
    from information_schema.column_privileges cp
    where cp.table_schema = 'public'
      and cp.table_name = 'item_posts'
      and cp.grantee = 'authenticated'
      and cp.privilege_type = 'SELECT'
      and cp.column_name in (
        'id', 'user_id', 'type', 'title', 'description', 'category', 'status',
        'event_date', 'latitude', 'longitude', 'location_label', 'youtube_url',
        'created_at', 'updated_at'
      )
  )
  and 14 = (
    select count(*)
    from information_schema.column_privileges cp
    where cp.table_schema = 'public'
      and cp.table_name = 'item_posts'
      and cp.grantee = 'authenticated'
      and cp.privilege_type = 'SELECT'
  );

-- P3. D11, one policy = one predicate. The item_posts SELECT policy is the
--     ONLY visibility predicate for an ordinary reader, and its expression is
--     exactly the owner clause AND the moderation atom: no `or true`, no third
--     disjunct, no role branch. The insert / update / delete policies are
--     untouched, so the table still carries exactly four policies.
select 'P3 the SELECT policy carries exactly the owner clause and the atom' as probe
where 1 = (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'item_posts'
      and policyname = 'item_posts_select_authenticated'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and regexp_replace(lower(qual), '\s', '', 'g')
            = '((user_id=((selectauth.uid()asuid))::text)or(moderation_visibility=''published''::text))'
  )
  and 4 = (
    select count(*)
    from pg_policies
    where schemaname = 'public' and tablename = 'item_posts'
  )
  and exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'item_posts'
      and policyname = 'item_posts_insert_own' and cmd = 'INSERT'
  )
  and exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'item_posts'
      and policyname = 'item_posts_update_own' and cmd = 'UPDATE'
  )
  and exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'item_posts'
      and policyname = 'item_posts_delete_own' and cmd = 'DELETE'
  );

-- P4. The view is a PROJECTION now: security_invoker is retained, it has NO
--     WHERE (the policy decides), and it projects exactly the fourteen granted
--     columns plus blocked_author — moderation_visibility is NOT projected,
--     and `p.*` is gone.
select 'P4 the visible-posts view is an explicit projection with no WHERE' as probe
where exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'findback_visible_posts'
      and c.relkind = 'v'
      and regexp_replace(lower(coalesce(array_to_string(c.reloptions, ','), '')), '\s', '', 'g')
            like '%security_invoker=true%'
  )
  and array['id', 'user_id', 'type', 'title', 'description', 'category', 'status',
            'event_date', 'latitude', 'longitude', 'location_label', 'youtube_url',
            'created_at', 'updated_at', 'blocked_author']::text[] = (
    select array_agg(column_name::text order by ordinal_position)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'findback_visible_posts'
  )
  and not regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
        like '%where%'
  and not regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
        like '%moderation_visibility%'
  and regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
        like '%findback_is_blocked_with_me(user_id)asblocked_author%';

-- P5. The view's ACL: `authenticated` may read it, `anon` may not, and PUBLIC
--     holds nothing on it.
select 'P5 the visible-posts view is granted to authenticated only' as probe
where has_table_privilege('authenticated', 'public.findback_visible_posts', 'SELECT')
  and not has_table_privilege('anon', 'public.findback_visible_posts', 'SELECT')
  and not has_table_privilege('public', 'public.findback_visible_posts', 'SELECT');

-- P6. The inbox reader is a DEFINER, and a definer bypasses the policy — so
--     its D21 moderation term has to be written out. It evaluates the atom
--     EXPLICITLY (owner clause OR PUBLISHED) and no longer asks the view.
select 'P6 the inbox reader evaluates the moderation atom explicitly' as probe
where exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'findback_list_notifications_client'
      and p.pronargs = 1
      and p.prosecdef = true
      and p.provolatile = 'v'
      and regexp_replace(lower(coalesce(array_to_string(p.proconfig, ','), '')), '\s', '', 'g')
            like '%search_path=public,pg_temp%'
      and regexp_replace(lower(p.prosrc), '\s', '', 'g')
            like '%exists(select1frompublic.item_postspwherep.id=n.post_idand(p.user_id=v_uidorp.moderation_visibility=''published''))%'
      and regexp_replace(lower(p.prosrc), '\s', '', 'g')
            not like '%findback_visible_posts%'
  );

-- P7. D11, the chain-wide form: NO client-reachable INVOKER function names
--     moderation_visibility. The atom is decided by the policy; the only
--     functions that name it are DEFINERS that answer for a third party
--     (the D21 trigger, the D21 inbox reader) or the privileged moderation
--     surfaces.
select 'P7 no client-reachable invoker reader carries the atom' as probe
where 0 = (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = false
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and regexp_replace(lower(p.prosrc), '\s', '', 'g') like '%moderation_visibility%'
  )
  and 2 <= (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and regexp_replace(lower(p.prosrc), '\s', '', 'g') like '%moderation_visibility%'
  );

-- P8. House style: every object this migration owns is commented.
select 'P8 the precondition comments every object it owns' as probe
where obj_description('public.findback_visible_posts'::regclass, 'pg_class') is not null
  and obj_description('public.findback_list_notifications_client(boolean)'::regprocedure, 'pg_proc') is not null
  and exists (
    select 1
    from pg_description d
    join pg_policy pol on pol.oid = d.objoid
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'item_posts'
      and pol.polname = 'item_posts_select_authenticated'
      and d.classoid = 'pg_policy'::regclass
      and d.objsubid = 0
      and d.description is not null
  );

-- ---------------------------------------------------------------------------
-- 2. Behavioural probes (DISPOSABLE PostgreSQL only; this transaction ROLLBACKs).
-- ---------------------------------------------------------------------------

begin;

-- B0. Scratch accounts and targets.
--     OWNER owns both posts; STRANGER is the audience the oracle is aimed at;
--     MODERATOR holds the content_hide capability the D2 writer requires.
insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, avatar_url, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000f001', 'pre_owner',     'pre_owner@example.invalid',     '+8801700000001', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f002', 'pre_stranger',  'pre_stranger@example.invalid',  '+8801700000002', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f003', 'pre_moderator', 'pre_moderator@example.invalid', '+8801700000003', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-4000-8000-00000000f004', 'pre_admin',     'pre_admin@example.invalid',     '+8801700000004', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
on conflict (id) do nothing;

insert into public.user_roles (user_id, role, granted_by, granted_at)
values ('00000000-0000-4000-8000-00000000f003', 'MODERATOR', '00000000-0000-4000-8000-00000000f004', '2026-10-22T00:00:00.000Z')
on conflict do nothing;

insert into public.user_role_capabilities (user_id, capability, granted_by, granted_at)
values ('00000000-0000-4000-8000-00000000f003', 'content_hide', '00000000-0000-4000-8000-00000000f004', '2026-10-22T00:00:00.000Z')
on conflict do nothing;

insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
values
  ('pre-post-pub',    '00000000-0000-4000-8000-00000000f001', 'LOST',  'Published post',  'A published report', 'Electronics', 'OPEN', '2020-01-01', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('pre-post-hidden', '00000000-0000-4000-8000-00000000f001', 'FOUND', 'Hidden post',     'A report under review', 'Electronics', 'OPEN', '2020-01-01', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
on conflict (id) do nothing;

-- Two stored inbox rows for the STRANGER: one targets the published post, one
-- targets the post that is about to be hidden. The reader must render the
-- first and not the second (D21, moderation half).
insert into public.notifications (id, user_id, actor_id, type, post_id, comment_id, preview, read, created_at)
values
  ('pre-notif-pub',    '00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f001', 'COMMENT', 'pre-post-pub',    null, 'A comment on the published post', 0, '2026-10-22T00:00:00.000Z'),
  ('pre-notif-hidden', '00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f001', 'COMMENT', 'pre-post-hidden', null, 'A comment on the hidden post',    0, '2026-10-22T00:00:00.000Z')
on conflict (id) do nothing;

-- B1. The REAL moderation writer hides a post. This is the writer the
--     precondition exists to protect against (20261022173000), used here as
--     the source of a genuine HIDDEN state, not a hand-written column value.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f003', true);

select 'B1 the moderation writer really wrote the HIDDEN state' as probe
where (select public.findback_apply_moderation('POST', 'pre-post-hidden', 'HIDE', 'HARASSMENT', null)) is not null;

reset role;
select set_config('request.jwt.claim.sub', '', true);

select 'B1 the hidden post is HIDDEN in the table' as probe
where (select moderation_visibility from public.item_posts where id = 'pre-post-hidden') = 'HIDDEN'
  and (select moderation_visibility from public.item_posts where id = 'pre-post-pub') = 'PUBLISHED';

-- B2. The stranger is the audience of the oracle. Every one of these reads
--     must fail with 42501 now.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f002', true);

do $$
begin
  begin
    perform p.moderation_visibility from public.item_posts p;
    raise exception 'B2a FAILED: a client read the moderation column' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2a ok: the moderation column is refused with 42501';
  end;

  begin
    perform count(*) from (select p.* from public.item_posts p) s;
    raise exception 'B2b FAILED: a client read item_posts with a wildcard' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B2b ok: select * on item_posts is refused with 42501';
  end;

  raise notice 'B2 ok: the moderation column is unreadable to a signed-in client';
end;
$$;

-- B3. Residual 12, closed at the row level: the stranger reads ZERO rows for
--     the hidden post, on the base table.
select 'B3 a stranger reads zero rows of the hidden post' as probe
where 0 = (select count(*) from public.item_posts where id = 'pre-post-hidden');

-- B4. ... and zero rows for an id that never existed. The two are the same
--     observation: the hidden post is ABSENT, not merely unshown.
select 'B4 a stranger reads zero rows of an id that never existed' as probe
where 0 = (select count(*) from public.item_posts where id = 'pre-post-never-existed');

-- B5. The visible-posts view is a projection, so it is filtered by the POLICY:
--     the hidden post is absent from it for the stranger, the published one is
--     present.
select 'B5 the view hides the hidden post from the stranger' as probe
where 0 = (select count(*) from public.findback_visible_posts where id = 'pre-post-hidden')
  and 1 = (select count(*) from public.findback_visible_posts where id = 'pre-post-pub');

-- B6. The feed reader agrees: a hidden id and an id that never existed return
--     BYTE-IDENTICAL results (contract §13.1). The comparison is over the full
--     row payload, not over a count.
with hidden_reply as (
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) as payload
  from public.findback_query_posts_client(p_post_id => 'pre-post-hidden') t
),
missing_reply as (
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) as payload
  from public.findback_query_posts_client(p_post_id => 'pre-post-never-existed') t
)
select 'B6 the feed reply for a hidden id is byte-identical to a missing id' as probe
where (select payload from hidden_reply) = (select payload from missing_reply)
  and (select jsonb_array_length(payload) from hidden_reply) = 0;

-- B7. The feed reader still WORKS for the stranger on a published post: the
--     precondition must not have broken the product.
select 'B7 the feed reader still returns a published post to the stranger' as probe
where 1 = (select count(*) from public.findback_query_posts_client(p_post_id => 'pre-post-pub'));

-- B8. D21, the moderation half, on the DEFINER inbox reader: a stored row
--     whose target post is HIDDEN is not rendered for a stranger, while the
--     row whose target is published is. This is the case that stops filtering
--     if the atom is moved into the policy and the reader is not updated.
select 'B8 the inbox reader still filters a hidden target for a stranger' as probe
where 0 = (select count(*) from public.findback_list_notifications_client(false) n where n.post_id = 'pre-post-hidden')
  and 1 = (select count(*) from public.findback_list_notifications_client(false) n where n.post_id = 'pre-post-pub');

-- B9. anon holds no path at all.
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  begin
    perform p.id from public.item_posts p;
    raise exception 'B9a FAILED: anon read item_posts' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B9a ok: anon is refused item_posts with 42501';
  end;

  begin
    perform v.id from public.findback_visible_posts v;
    raise exception 'B9b FAILED: anon read the visible-posts view' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B9b ok: anon is refused the view with 42501';
  end;

  begin
    perform count(*) from public.findback_list_notifications_client(false);
    raise exception 'B9c FAILED: anon read the inbox' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B9c ok: anon is refused the inbox reader with 42501';
  end;

  raise notice 'B9 ok: anon holds no path into posts, the view or the inbox';
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- B10. D10, the owner column: the author still reads their own HIDDEN row on
--      every surface — the base table, the view and the feed — and still sees
--      the notification about their own post. The precondition removes the
--      ORACLE, not the owner's own knowledge of their own report.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f001', true);

select 'B10 the author still reads their own hidden row on every surface' as probe
where 1 = (select count(*) from public.item_posts where id = 'pre-post-hidden')
  and 1 = (select count(*) from public.findback_visible_posts where id = 'pre-post-hidden')
  and 1 = (select count(*) from public.findback_query_posts_client(p_post_id => 'pre-post-hidden'))
  and 1 <= (select count(*) from public.findback_list_notifications_client(false) n where n.post_id = 'pre-post-hidden');

-- B11. The owner's own row does not become a channel for the column either:
--      the revoke is unconditional, so the author learns their own state
--      through the owner-scoped state reader, never through the base table.
do $$
begin
  begin
    perform p.moderation_visibility from public.item_posts p;
    raise exception 'B11a FAILED: the author read the moderation column' using errcode = '0A000';
  exception when insufficient_privilege then
    raise notice 'B11a ok: the moderation column is refused to the author too';
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

rollback;
