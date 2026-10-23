-- Verification for 20261023030000_last_admin_deletion_guard.sql (the only
-- admin account cannot be deleted).
--
-- STATUS, STATED PLAINLY. Nothing in this file may be quoted as a passing
-- result until it has been run and its output recorded. The migration has NOT
-- been applied to the hosted project. A static parity test proves the TEXT of
-- the SQL; it proves nothing about behaviour, which is what section 2 measures.
--
-- WHAT IT PROVES. Account deletion reaches `public.user_roles` through a
-- cascade (auth.users -> public.users -> user_roles), which the role RPCs never
-- see. Section 2 therefore deletes ordinary rows and asserts the outcome:
--   a. the only ADMIN cannot be deleted (42501), and the row survives;
--   b. the only DUAL-ROLE account (ADMIN *and* MODERATOR) cannot be deleted
--      either (42501), both of its role rows survive, and the refusal carries
--      the exact server sentence;
--   c. once a second ADMIN exists, the first one deletes, and its role rows go
--      with it;
--   d. a MODERATOR-only account deletes without touching the guard;
--   e. a reader with no role deletes;
--   f. an ADMIN who also holds MODERATOR deletes once another admin exists;
--   g. the last remaining admin is still protected.
--
-- Case (b) is the one a laxer guard would fail: a predicate that only counted
-- an account holding ADMIN "and no other role" would let the dual-role last
-- admin delete itself, and case (b) is the only assertion that notices.
--
-- WHAT IT DOES NOT PROVE. That the `delete-account` Edge Function surfaces the
-- refusal as a sentence rather than a generic failure, and that it refuses
-- BEFORE the storage fence and the media sweep — that is the function's job,
-- not the trigger's, and it is proved by the function's own unit tests
-- (supabase/functions/delete-account/index.test.ts) and by the static guard
-- (supabase/tests/last_admin_deletion_guard_parity.test.mjs). It also does not
-- prove the absence of a partial state on the OLD path: the fence and the
-- media sweep used to happen BEFORE the trigger fired, so a refusal there
-- arrives after the media is already gone. The Edge now requires a committed
-- atomic admission receipt before Storage. This file proves the rule helper
-- is a pure read, NOT that a read check reserves anything. Admission behavior
-- is covered by verify_last_admin_admission.sql and admission-sql.test.ts.
--
-- HOW TO RUN IT. On a DISPOSABLE PostgreSQL 17 with the whole migration chain
-- applied, never on production:
--   psql -v ON_ERROR_STOP=1 -f verify_20261023030000_last_admin_deletion_guard.sql
-- The script writes scratch accounts and ROLLBACKs; it leaves no rows behind.
-- It needs no `auth` schema and no JWT: the guard reads public tables only.

-- Run with psql -v ON_ERROR_STOP=1 (or through scripts/sql-behavior.mjs, which
-- compiles each SELECT into a probe and stops on the first error). No psql
-- meta-commands live in this file so that both runners accept it byte for byte.

begin;

-- A lock wait must fail loudly instead of hanging the gate: the guard takes
-- an advisory lock, and a stale lock must not look like a passing probe.
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Catalogue probes (read-only).
-- ---------------------------------------------------------------------------
do $$
declare
  v_trigger text;
  v_definer boolean;
  v_config text;
  v_rule_definer boolean;
  v_rule_config text;
begin
  select t.tgname
    into v_trigger
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'users'
     and t.tgname = 'users_guard_last_admin_deletion'
     and not t.tgisinternal;

  if v_trigger is null then
    raise exception 'catalogue: the BEFORE DELETE trigger on public.users is missing';
  end if;

  select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '')
    into v_definer, v_config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'findback_guard_last_admin_deletion';

  if v_definer is not true then
    raise exception 'catalogue: the guard is not SECURITY DEFINER';
  end if;
  if v_config not like '%search_path=public, pg_temp%' then
    raise exception 'catalogue: the guard search_path is not pinned (got %)', v_config;
  end if;

  -- The rule the trigger and the Edge Function pre-flight share.
  select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '')
    into v_rule_definer, v_rule_config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'findback_is_last_admin';

  if v_rule_definer is null then
    raise exception 'catalogue: the shared rule function findback_is_last_admin is missing';
  end if;
  if v_rule_definer is not true then
    raise exception 'catalogue: the shared rule function is not SECURITY DEFINER';
  end if;
  if v_rule_config not like '%search_path=public, pg_temp%' then
    raise exception 'catalogue: the shared rule search_path is not pinned (got %)', v_rule_config;
  end if;

  -- The role only exists on a cluster prepared for the full chain; skip the
  -- privilege probe where it does not, rather than reporting a false failure.
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.findback_guard_last_admin_deletion()', 'EXECUTE') then
    raise exception 'catalogue: authenticated may execute the guard directly';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.findback_is_last_admin(text)', 'EXECUTE') then
    raise exception 'catalogue: authenticated may execute the shared rule directly';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.findback_is_last_admin(text)', 'EXECUTE') then
    raise exception 'catalogue: anon may execute the shared rule directly';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Behaviour: delete the rows and check what happened.
-- ---------------------------------------------------------------------------

insert into public.users (id, username, email, phone, password_hash, created_at, updated_at)
values
  ('guard-admin-1', 'guardadmin1', 'guard-admin-1@example.test', '+10000000001', 'x', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z'),
  ('guard-admin-2', 'guardadmin2', 'guard-admin-2@example.test', '+10000000002', 'x', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z'),
  ('guard-mod-1',   'guardmod1',   'guard-mod-1@example.test',   '+10000000003', 'x', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z'),
  ('guard-none-1',  'guardnone1',  'guard-none-1@example.test',  '+10000000004', 'x', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z'),
  ('guard-admin-3', 'guardadmin3', 'guard-admin-3@example.test', '+10000000005', 'x', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z');

-- Exactly ONE admin to begin with: the guard protects the last one, so a
-- second seeded admin here would make every later "last admin" case vacuous.
insert into public.user_roles (user_id, role, granted_by, granted_at)
values
  ('guard-admin-1', 'ADMIN', null, '2026-10-23T00:00:00Z'),
  ('guard-mod-1', 'MODERATOR', 'guard-admin-1', '2026-10-23T00:00:00Z');

-- a. The only admin cannot be deleted, and survives the refusal.
do $$
declare
  v_message text;
begin
  begin
    delete from public.users where id = 'guard-admin-1';
    raise exception 'a: the only ADMIN was deleted — the guard did not run';
  exception
    when sqlstate '42501' then
      v_message := sqlerrm; -- the refusal this migration exists for
  end;

  if v_message is distinct from 'This is the only admin account. Promote another admin before deleting this one.' then
    raise exception 'a: the refusal text was not the server sentence (got %)', coalesce(v_message, '<none>');
  end if;
  if not exists (select 1 from public.users where id = 'guard-admin-1') then
    raise exception 'a: the refused delete removed the account anyway';
  end if;
  if not exists (select 1 from public.user_roles where user_id = 'guard-admin-1' and role = 'ADMIN') then
    raise exception 'a: the refused delete removed the role row';
  end if;
  raise notice 'probe case a: the only ADMIN was refused with the server sentence';
end $$;

-- b. THE DUAL-ROLE LAST ADMIN. An account that holds ADMIN *and* MODERATOR
--    holds ADMIN, so when it is the only admin it must be refused as well.
--    This is the case a laxer predicate ("ADMIN and no other role") would
--    silently allow, so it is the only assertion here that can fail for a
--    guard that treats dual-role holders as non-admins.
do $$
declare
  v_message text;
begin
  -- Make guard-admin-3 the ONLY admin: it holds ADMIN and MODERATOR, and
  -- guard-admin-1's ADMIN role is moved out of the way for the attempt.
  delete from public.user_roles where user_id = 'guard-admin-1' and role = 'ADMIN';
  insert into public.user_roles (user_id, role, granted_by, granted_at)
  values
    ('guard-admin-3', 'ADMIN', null, '2026-10-23T00:00:00Z'),
    ('guard-admin-3', 'MODERATOR', null, '2026-10-23T00:00:00Z');

  if (select count(*) from public.user_roles where role = 'ADMIN') <> 1 then
    raise exception 'b: the fixture is not a single-admin world';
  end if;

  begin
    delete from public.users where id = 'guard-admin-3';
    raise exception 'b: the only dual-role ADMIN was deleted — the guard did not run';
  exception
    when sqlstate '42501' then
      v_message := sqlerrm;
  end;

  -- The refusal must carry the real server sentence, not a loose substring.
  if v_message is distinct from 'This is the only admin account. Promote another admin before deleting this one.' then
    raise exception 'b: the refusal text was not the server sentence (got %)', coalesce(v_message, '<none>');
  end if;
  if not exists (select 1 from public.users where id = 'guard-admin-3') then
    raise exception 'b: the refused delete removed the dual-role account anyway';
  end if;
  if not exists (select 1 from public.user_roles where user_id = 'guard-admin-3' and role = 'ADMIN') then
    raise exception 'b: the refused delete removed the ADMIN role row';
  end if;
  if not exists (select 1 from public.user_roles where user_id = 'guard-admin-3' and role = 'MODERATOR') then
    raise exception 'b: the refused delete removed the MODERATOR role row';
  end if;

  -- Put the world back the way case (c) expects it.
  delete from public.user_roles where user_id = 'guard-admin-3';
  insert into public.user_roles (user_id, role, granted_by, granted_at)
  values ('guard-admin-1', 'ADMIN', null, '2026-10-23T00:00:00Z');

  raise notice 'probe case b: the only ADMIN+MODERATOR account was refused, both role rows survived';
end $$;

-- b2. The shared rule the Edge Function pre-flights is a PURE READ: asking
--     the question writes nothing, so a refused pre-flight leaves no fence
--     row behind.
do $$
declare
  v_is_last_admin boolean;
  v_fence_rows integer;
begin
  select public.findback_is_last_admin('guard-admin-1') into v_is_last_admin;
  if v_is_last_admin is not true then
    raise exception 'b2: the shared rule did not recognise the only admin';
  end if;
  select public.findback_is_last_admin('guard-none-1') into v_is_last_admin;
  if v_is_last_admin is not false then
    raise exception 'b2: the shared rule called a roleless account the last admin';
  end if;

  select count(*) into v_fence_rows
    from public.account_deletion_fences
   where user_id = 'guard-admin-1';
  if v_fence_rows <> 0 then
    raise exception 'b2: the pre-flight left a deletion fence row behind';
  end if;

  raise notice 'probe case b2: the pre-flight rule is a pure read and left no fence row';
end $$;

-- c. A second admin makes the first deletable, and the cascade still applies.
do $$
begin
  insert into public.user_roles (user_id, role, granted_by, granted_at)
  values ('guard-admin-2', 'ADMIN', 'guard-admin-1', '2026-10-23T00:00:01Z');

  delete from public.users where id = 'guard-admin-1';

  if exists (select 1 from public.users where id = 'guard-admin-1') then
    raise exception 'c: the account survived a permitted delete';
  end if;
  if exists (select 1 from public.user_roles where user_id = 'guard-admin-1') then
    raise exception 'c: the role row survived the account delete (cascade broken)';
  end if;
  raise notice 'probe case c: with a second admin present the first one deleted and cascaded';
end $$;

-- d. A moderator-only account is not blocked by the admin guard.
do $$
begin
  delete from public.users where id = 'guard-mod-1';
  if exists (select 1 from public.user_roles where user_id = 'guard-mod-1') then
    raise exception 'd: the moderator role row survived the account delete';
  end if;
  raise notice 'probe case d: a moderator-only account deleted';
end $$;

-- e. A reader with no role at all is unaffected.
do $$
begin
  delete from public.users where id = 'guard-none-1';
  if exists (select 1 from public.users where id = 'guard-none-1') then
    raise exception 'e: a roleless account was not deleted';
  end if;
  raise notice 'probe case e: a roleless account deleted';
end $$;

-- f. An ADMIN who also holds MODERATOR is treated as an admin, not exempt.
do $$
begin
  -- guard-admin-3 is given both roles here, only after guard-admin-2 became a
  -- second admin in case (c) — so this deletion must SUCCEED: the guard
  -- protects the LAST admin, not any admin.
  insert into public.user_roles (user_id, role, granted_by, granted_at)
  values
    ('guard-admin-3', 'ADMIN', 'guard-admin-2', '2026-10-23T00:00:00Z'),
    ('guard-admin-3', 'MODERATOR', 'guard-admin-2', '2026-10-23T00:00:00Z');

  begin
    delete from public.users where id = 'guard-admin-3';
  exception
    when sqlstate '42501' then
      raise exception 'f: a deletable admin was refused while another admin exists';
  end;

  if exists (select 1 from public.user_roles where user_id = 'guard-admin-3') then
    raise exception 'f: the deleted admin kept a role row';
  end if;
  raise notice 'probe case f: a dual-role admin deleted while another admin exists';
end $$;

-- g. And the last remaining admin is still protected.
do $$
declare
  v_message text;
begin
  begin
    delete from public.users where id = 'guard-admin-2';
    raise exception 'g: the final ADMIN was deleted';
  exception
    when sqlstate '42501' then
      v_message := sqlerrm;
  end;

  if v_message is distinct from 'This is the only admin account. Promote another admin before deleting this one.' then
    raise exception 'g: the refusal text was not the server sentence (got %)', coalesce(v_message, '<none>');
  end if;
  if not exists (select 1 from public.user_roles where user_id = 'guard-admin-2' and role = 'ADMIN') then
    raise exception 'g: the final admin role row disappeared';
  end if;
  raise notice 'probe case g: the final ADMIN was refused with the server sentence';
end $$;

-- One SELECT so a probe runner that requires a result row still has one; the
-- assertions themselves are the DO blocks above.
select 'last-admin deletion guard: probes passed' as result;

rollback;
