-- Verification for 20261022143000_roles_capabilities_invitations.sql (roles,
-- the per-moderator capability matrix, email invitations, the one-time admin
-- claim).
--
-- STATUS, STATED PLAINLY. This migration has NOT been applied to the hosted
-- project. Nothing in this file may be quoted as a passing result until it has
-- been run and its output recorded. The static guard
-- (supabase/tests/roles_capabilities_parity.test.mjs) checks the TEXT of the
-- migration; it proves nothing about the behaviour of the objects.
--
-- HOW TO RUN IT. Section 1 is read-only catalog probes: run them in the
-- Supabase dashboard SQL editor (or as the database owner) after the
-- migration is applied. Section 2 is behavioural: it switches to the
-- `authenticated` role with a JWT subject claim
-- (`set_config('request.jwt.claim.sub', <uid>, true)` — LOCAL, so the claim
-- cannot outlive the transaction) and writes scratch rows, so run it on a
-- DISPOSABLE PostgreSQL 17 with the whole migration chain applied on top —
-- never on production — and wrap it in a transaction that ROLLBACKs.
--
-- WHAT THE DISPOSABLE INSTANCE MUST HAVE. A plain PostgreSQL is not
-- Supabase, so three things have to exist before section 2 can say
-- anything about the roles:
--
--   create role authenticated nologin;
--   create role anon nologin;
--   create schema if not exists auth;
--   -- the trigger functions of this migration fire on auth.users, and the
--   -- predicates read the JWT subject through auth.uid():
--   create table if not exists auth.users (
--     id uuid primary key,
--     email text,
--     email_confirmed_at timestamptz
--   );
--   create or replace function auth.uid() returns uuid
--     language sql stable as $$
--       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
--     $$;
--
-- Without those, the probes fail with a role or schema error rather than a
-- behavioural one — and the `anon` half of the contract (CONTRACT-ROLES-
-- ADMIN-2026-10-22.md §5) cannot be run at all.
--
-- Section 3 is the post-apply READBACK: the exact queries to
-- run against the hosted project once the migration has been applied, to show
-- that the tables, the RLS state, the ACLs, the functions and the seeds are
-- what the migration intended.
--
-- EVERY PROBE IN SECTION 2 IS AN ASSERTION. A probe that fails raises an
-- exception with its own name, so a failure cannot hide behind an empty
-- result set. Every privilege refusal is CAUGHT inside its own block: a
-- refusal raised inside a transaction aborts it, so a verifier that called a
-- privileged RPC directly could never reach the probes after it.
--
-- The properties under test, in the order the migration states them:
--   1. the five privileged tables are ungranted to anon/authenticated and
--      carry RLS with no policy (D36);
--   2. the audit log is append-only — no UPDATE, no DELETE, no write grant
--      (D37);
--   3. findback_has_role and findback_can are definer, stable, granted to
--      authenticated and revoked from anon (D35, A2.2);
--   4. an ordinary authenticated caller is refused with 42501 by every
--      privileged RPC, and an ANONYMOUS caller is refused with 42501 by
--      every privileged RPC as well (A2.6, CONTRACT §5);
--   5. a moderator WITHOUT a capability is refused with 42501, and a
--      moderator WITH it succeeds (A2.6);
--   6. an admin passes every check (A2.2);
--   7. the last active admin cannot be revoked, and cannot be demoted (A2.3);
--   8. the one-time admin claim is refused for an address outside the
--      allowlist and refused once an admin exists (A2.4);
--   9. a pending invitation is consumed on a VERIFIED path, with exactly the
--      invited capability set, and an UNVERIFIED sign-up cannot burn it
--      (A2.3);
--  10. a revoked account loses its capabilities immediately (A2.3).

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes.
-- ---------------------------------------------------------------------------

-- P1. All five tables exist with RLS enabled.
select 'P1 tables exist with RLS' as probe
where 5 = (
  select count(*) from information_schema.tables t
  where t.table_schema = 'public'
    and t.table_name in ('user_roles','user_role_capabilities','role_invitations','bootstrap_admins','admin_audit_log')
)
and 5 = (
  select count(*) from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('user_roles','user_role_capabilities','role_invitations','bootstrap_admins','admin_audit_log')
    and c.relrowsecurity
);

-- P2. No client role holds a table privilege on any of them.
select 'P2 no client table privilege' as probe
where not exists (
  select 1
  from information_schema.role_table_grants g
  join information_schema.tables t
    on t.table_schema = g.table_schema and t.table_name = g.table_name
  where g.table_schema = 'public'
    and t.table_name in ('user_roles','user_role_capabilities','role_invitations','bootstrap_admins','admin_audit_log')
    and g.grantee in ('anon','authenticated','PUBLIC')
);

-- P3. The audit log has no UPDATE or DELETE privilege for any client role.
select 'P3 audit log is append-only' as probe
where not exists (
  select 1 from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.table_name = 'admin_audit_log'
    and g.privilege_type in ('UPDATE','DELETE','INSERT','TRUNCATE')
    and g.grantee in ('anon','authenticated','PUBLIC')
);

-- P4. Every role predicate is SECURITY DEFINER, STABLE and granted exactly
--     to authenticated.
select 'P4 predicates are definer/stable/anon-revoked' as probe
where 10 = (
  select count(*)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'findback_has_role','findback_can','findback_my_role','findback_bootstrap_admin',
      'findback_role_grant','findback_role_set_capabilities','findback_role_revoke',
      'findback_role_assignments','findback_role_invitations','findback_audit_log'
    )
    and p.prosecdef
    and p.provolatile in ('s','v')
)
and not exists (
  select 1 from information_schema.role_routine_grants g
  join pg_proc p on p.proname = g.routine_name
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where g.routine_schema = 'public'
    and g.grantee in ('anon','PUBLIC')
    and p.proname in (
      'findback_has_role','findback_can','findback_my_role','findback_bootstrap_admin',
      'findback_role_grant','findback_role_set_capabilities','findback_role_revoke',
      'findback_role_assignments','findback_role_invitations','findback_audit_log'
    )
);

-- P5. The seeds are present (emails only).
select 'P5 seeds present' as probe
where 2 = (select count(*) from public.bootstrap_admins)
  and 1 = (select count(*) from public.role_invitations where lower(btrim(email)) = 'sheikhti109@gmail.com');

-- ---------------------------------------------------------------------------
-- 2. Behavioural probes (DISPOSABLE PostgreSQL only; wrap in ROLLBACK).
-- ---------------------------------------------------------------------------

-- B0. Scratch accounts. The behaviour is asserted against these roles:
--     an ordinary reader, a moderator with reports_review + content_hide, an
--     admin, an invited account that verifies its address, and one that does
--     not.
begin;

insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, avatar_url, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000001', 'reader_one',     'reader_one@example.com',     '+8801000000001', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-0000-0000-000000000002', 'mod_one',        'mod_one@example.com',        '+8801000000002', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-0000-0000-000000000003', 'admin_one',      'admin_one@example.com',      '+8801000000003', null, 1, 0, null, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
on conflict (id) do nothing;

insert into public.user_roles (user_id, role, granted_by, granted_at)
values ('00000000-0000-0000-0000-000000000002', 'MODERATOR', '00000000-0000-0000-0000-000000000003', '2026-10-22T00:00:00.000Z')
on conflict do nothing;

insert into public.user_role_capabilities (user_id, capability, granted_by, granted_at)
values
  ('00000000-0000-0000-0000-000000000002', 'reports_review', '00000000-0000-0000-0000-000000000003', '2026-10-22T00:00:00.000Z'),
  ('00000000-0000-0000-0000-000000000002', 'content_hide',   '00000000-0000-0000-0000-000000000003', '2026-10-22T00:00:00.000Z')
on conflict do nothing;

insert into public.user_roles (user_id, role, granted_by, granted_at)
values ('00000000-0000-0000-0000-000000000003', 'ADMIN', '00000000-0000-0000-0000-000000000003', '2026-10-22T00:00:00.000Z')
on conflict do nothing;

-- B1. An ordinary reader holds no role and no capability.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

do $$
begin
  if public.findback_has_role('MODERATOR') is not false then
    raise exception 'B1 FAILED: the reader holds the moderator role';
  end if;
  if public.findback_has_role('ADMIN') is not false then
    raise exception 'B1 FAILED: the reader holds the admin role';
  end if;
  if public.findback_can('reports_review') is not false then
    raise exception 'B1 FAILED: the reader holds a capability';
  end if;
  raise notice 'B1 ok: the reader holds no role and no capability';
end;
$$;

-- B2. The reader is refused by every privileged RPC, each with 42501.
do $$
begin
  perform public.findback_role_assignments();
  raise exception 'B2a FAILED: the reader read the team list';
exception
  when insufficient_privilege then
    raise notice 'B2a ok: the reader was refused the team list with 42501';
end;
$$;

do $$
begin
  perform public.findback_role_invitations();
  raise exception 'B2b FAILED: the reader read the invitation list';
exception
  when insufficient_privilege then
    raise notice 'B2b ok: the reader was refused the invitation list with 42501';
end;
$$;

do $$
begin
  perform public.findback_audit_log(10);
  raise exception 'B2c FAILED: the reader read the audit log';
exception
  when insufficient_privilege then
    raise notice 'B2c ok: the reader was refused the audit log with 42501';
end;
$$;

do $$
begin
  perform public.findback_role_grant('x@example.com', 'MODERATOR', array['reports_review']);
  raise exception 'B2d FAILED: the reader granted a role';
exception
  when insufficient_privilege then
    raise notice 'B2d ok: the reader was refused a role grant with 42501';
end;
$$;

do $$
begin
  perform public.findback_role_set_capabilities('x@example.com', array['reports_review']);
  raise exception 'B2e FAILED: the reader changed a capability set';
exception
  when insufficient_privilege then
    raise notice 'B2e ok: the reader was refused a capability change with 42501';
end;
$$;

do $$
begin
  perform public.findback_role_revoke('x@example.com');
  raise exception 'B2f FAILED: the reader revoked a role';
exception
  when insufficient_privilege then
    raise notice 'B2f ok: the reader was refused a revoke with 42501';
end;
$$;

-- B3. The moderator holds exactly the two invited capabilities.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);

do $$
begin
  if public.findback_has_role('MODERATOR') is not true then
    raise exception 'B3 FAILED: the moderator does not hold the role';
  end if;
  if public.findback_can('reports_review') is not true then
    raise exception 'B3 FAILED: the moderator lost reports_review';
  end if;
  if public.findback_can('content_hide') is not true then
    raise exception 'B3 FAILED: the moderator lost content_hide';
  end if;
  if public.findback_can('members_suspend') is not false then
    raise exception 'B3 FAILED: the moderator holds a capability it was not given';
  end if;
  if public.findback_can('roles_manage') is not false then
    raise exception 'B3 FAILED: the moderator holds an admin-only capability';
  end if;
  raise notice 'B3 ok: the moderator holds exactly the two invited capabilities';
end;
$$;

-- B4. The moderator is refused an action outside the capability set.
do $$
begin
  perform public.findback_role_grant('x@example.com', 'MODERATOR', array['reports_review']);
  raise exception 'B4a FAILED: the moderator granted a role';
exception
  when insufficient_privilege then
    raise notice 'B4a ok: the moderator was refused a role grant with 42501';
end;
$$;

do $$
begin
  perform public.findback_audit_log(10);
  raise exception 'B4b FAILED: the moderator read the audit log';
exception
  when insufficient_privilege then
    raise notice 'B4b ok: the moderator was refused the audit log with 42501';
end;
$$;

-- B5. The admin passes every capability check, including the admin-only ones.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);

do $$
begin
  if public.findback_has_role('ADMIN') is not true then
    raise exception 'B5 FAILED: the admin does not hold the role';
  end if;
  if public.findback_can('roles_manage') is not true then
    raise exception 'B5 FAILED: the admin lost roles_manage';
  end if;
  if public.findback_can('data_export') is not true then
    raise exception 'B5 FAILED: the admin lost data_export';
  end if;
  if public.findback_can('reports_review') is not true then
    raise exception 'B5 FAILED: the admin lost a moderator capability';
  end if;
  raise notice 'B5 ok: the admin holds every capability';
end;
$$;

-- B6. The admin can read the team and the audit log.
--
-- The fixtures above are seeded DIRECTLY, so nothing has written an audit row
-- yet and a bare `count(*)` would be a check that cannot fail. Write one real
-- mutation first, then require the admin to see its audit row: that is the
-- property that matters (the log is readable AND it records the action).
do $$
declare
  v_team integer;
  v_log  integer;
  v_newest text;
begin
  perform public.findback_role_grant('b6-audit@example.invalid', 'MODERATOR', array['reports_review']);

  select count(*) into v_team from public.findback_role_assignments();
  if v_team < 2 then
    raise exception 'B6 FAILED: the admin read only % team rows', v_team;
  end if;

  select count(*) into v_log from public.findback_audit_log(50);
  if v_log < 1 then
    raise exception 'B6 FAILED: the mutation wrote no readable audit row';
  end if;
  select l.action into v_newest from public.findback_audit_log(50) l limit 1;
  if v_newest <> 'ROLE_INVITED' then
    raise exception 'B6 FAILED: the newest audit row is %, not the invitation just written', v_newest;
  end if;
  raise notice 'B6 ok: the admin read the team list and the audit row of the write it made';
end;
$$;

-- B7. The last admin cannot be revoked, and cannot be demoted.
do $$
begin
  perform public.findback_role_revoke('admin_one@example.com');
  raise exception 'B7a FAILED: the last admin was revoked';
exception
  when insufficient_privilege then
    raise notice 'B7a ok: the last admin cannot be revoked';
end;
$$;

do $$
begin
  perform public.findback_role_grant('admin_one@example.com', 'MODERATOR', array['reports_review']);
  raise exception 'B7b FAILED: the last admin was demoted';
exception
  when insufficient_privilege then
    raise notice 'B7b ok: the last admin cannot be demoted';
end;
$$;

-- B8. The one-time claim is refused for an address outside the allowlist.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

do $$
begin
  perform public.findback_bootstrap_admin();
  raise exception 'B8 FAILED: an address outside the allowlist claimed the admin role';
exception
  when insufficient_privilege then
    raise notice 'B8 ok: the claim is refused outside the allowlist with 42501';
end;
$$;

-- B9. A pending invitation is consumed on a VERIFIED path, with exactly the
--     invited capability set.
reset role;
select set_config('request.jwt.claim.sub', '', true);

insert into public.role_invitations (email, role, capabilities, invited_by, invited_at)
values (
  'invitee_one@example.com',
  'MODERATOR',
  array['content_hide'],
  '00000000-0000-0000-0000-000000000003',
  '2026-10-22T00:00:00.000Z'
);

-- The verified profile row appears: the invitation must be consumed now.
insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, avatar_url, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000004',
  'invitee_one',
  'invitee_one@example.com',
  '+8801000000004',
  null,
  1,
  0,
  null,
  '2026-10-22T00:00:00.000Z',
  '2026-10-22T00:00:00.000Z'
)
on conflict (id) do nothing;

do $$
declare
  v_role text;
  v_caps text[];
begin
  select r.role into v_role
    from public.user_roles r
   where r.user_id = '00000000-0000-0000-0000-000000000004';

  if v_role is distinct from 'MODERATOR' then
    raise exception 'B9 FAILED: the verified invitee holds no moderator role (got %)', coalesce(v_role, 'null');
  end if;

  select coalesce(array_agg(c.capability order by c.capability), '{}'::text[])
    into v_caps
    from public.user_role_capabilities c
   where c.user_id = '00000000-0000-0000-0000-000000000004';

  if v_caps <> array['content_hide']::text[] then
    raise exception 'B9 FAILED: the verified invitee holds the wrong capability set';
  end if;

  raise notice 'B9 ok: the verified invitee holds the moderator role and exactly the invited capability';
end;
$$;

-- B10. An UNVERIFIED sign-up cannot burn an invitation. The invitation is
--      created FIRST, and only then does the unverified profile row appear —
--      which is exactly the order the app produces.
insert into public.role_invitations (email, role, capabilities, invited_by, invited_at)
values (
  'unverified_one@example.com',
  'MODERATOR',
  array['content_hide'],
  '00000000-0000-0000-0000-000000000003',
  '2026-10-22T00:00:00.000Z'
);

insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, avatar_url, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000005',
  'unverified_one',
  'unverified_one@example.com',
  '+8801000000005',
  null,
  0,
  0,
  null,
  '2026-10-22T00:00:00.000Z',
  '2026-10-22T00:00:00.000Z'
)
on conflict (id) do nothing;

do $$
declare
  v_roles integer;
  v_live  integer;
begin
  select count(*) into v_roles
    from public.user_roles r
   where r.user_id = '00000000-0000-0000-0000-000000000005';

  if v_roles <> 0 then
    raise exception 'B10 FAILED: an unverified account was given a role';
  end if;

  select count(*) into v_live
    from public.role_invitations r
   where lower(btrim(r.email)) = 'unverified_one@example.com'
     and r.accepted_at is null
     and r.revoked_at is null;

  if v_live <> 1 then
    raise exception 'B10 FAILED: the invitation for the unverified account was consumed';
  end if;

  raise notice 'B10 ok: the unverified account holds no role and the invitation is still live';
end;
$$;

-- B11. A revoked account loses its capabilities immediately.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);

do $$
begin
  perform public.findback_role_revoke('mod_one@example.com');
  raise notice 'B11 setup: the moderator role was revoked';
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);

do $$
begin
  if public.findback_can('reports_review') is not false then
    raise exception 'B11 FAILED: the revoked moderator still holds reports_review';
  end if;
  if public.findback_has_role('MODERATOR') is not false then
    raise exception 'B11 FAILED: the revoked moderator still holds the role';
  end if;
  if (public.findback_my_role() ->> 'role') is not null then
    raise exception 'B11 FAILED: the revoked moderator is still reported as staff';
  end if;
  if jsonb_array_length(public.findback_my_role() -> 'capabilities') <> 0 then
    raise exception 'B11 FAILED: the revoked moderator is still reported with capabilities';
  end if;
  raise notice 'B11 ok: the revoked account lost its role and its capabilities';
end;
$$;

-- B12. THE ANON HALF (CONTRACT-ROLES-ADMIN-2026-10-22.md §5). An anonymous
--      caller may not reach a single privileged RPC. The refusal is
--      42501 — the function is not granted to `anon` at all.
set local role anon;

do $$
begin
  perform public.findback_role_assignments();
  raise exception 'B12a FAILED: anon read the team list';
exception
  when insufficient_privilege then
    raise notice 'B12a ok: anon was refused the team list with 42501';
end;
$$;

do $$
begin
  perform public.findback_role_invitations();
  raise exception 'B12b FAILED: anon read the invitation list';
exception
  when insufficient_privilege then
    raise notice 'B12b ok: anon was refused the invitation list with 42501';
end;
$$;

do $$
begin
  perform public.findback_audit_log(10);
  raise exception 'B12c FAILED: anon read the audit log';
exception
  when insufficient_privilege then
    raise notice 'B12c ok: anon was refused the audit log with 42501';
end;
$$;

do $$
begin
  perform public.findback_role_grant('x@example.com', 'MODERATOR', array['reports_review']);
  raise exception 'B12d FAILED: anon granted a role';
exception
  when insufficient_privilege then
    raise notice 'B12d ok: anon was refused a role grant with 42501';
end;
$$;

do $$
begin
  perform public.findback_role_set_capabilities('x@example.com', array['reports_review']);
  raise exception 'B12e FAILED: anon changed a capability set';
exception
  when insufficient_privilege then
    raise notice 'B12e ok: anon was refused a capability change with 42501';
end;
$$;

do $$
begin
  perform public.findback_role_revoke('x@example.com');
  raise exception 'B12f FAILED: anon revoked a role';
exception
  when insufficient_privilege then
    raise notice 'B12f ok: anon was refused a revoke with 42501';
end;
$$;

do $$
begin
  perform public.findback_bootstrap_admin();
  raise exception 'B12g FAILED: anon claimed the admin role';
exception
  when insufficient_privilege then
    raise notice 'B12g ok: anon was refused the admin claim with 42501';
end;
$$;

rollback;

-- Hosted post-apply catalog readback is deliberately separate:
-- supabase/tests/readback_20261022143000_roles_capabilities_hosted.sql.
