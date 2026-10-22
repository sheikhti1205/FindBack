-- HOSTED ONLY, READ-ONLY; NOT RUN. Presence is not hosted acceptance.
-- Archive actual results with the exact accepted migration hash after apply.
-- R1. The objects and their shape.
select t.table_name, c.relrowsecurity as row_security
from information_schema.tables t
join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
where t.table_schema = 'public'
  and t.table_name in ('user_roles','user_role_capabilities','role_invitations','bootstrap_admins','admin_audit_log')
order by t.table_name;

-- R2. The ACL of every privileged table (must be empty for the client roles).
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('user_roles','user_role_capabilities','role_invitations','bootstrap_admins','admin_audit_log')
order by table_name, grantee;

-- R3. Function signatures, volatility, security and path.
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.provolatile, p.prosecdef, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'findback_has_role','findback_can','findback_my_role','findback_bootstrap_admin',
    'findback_role_grant','findback_role_set_capabilities','findback_role_revoke',
    'findback_role_assignments','findback_role_invitations','findback_audit_log',
    'findback_attach_pending_role','findback_write_audit',
    'findback_capability_vocabulary','findback_admin_capabilities'
  )
order by p.proname;

-- R4. The ACL of those functions.
select routine_name, grantee, privilege_type
from information_schema.role_routine_grants
where routine_schema = 'public'
  and (routine_name like 'findback_%role%'
       or routine_name in ('findback_can','findback_has_role','findback_my_role','findback_audit_log','findback_bootstrap_admin'))
order by routine_name, grantee;

-- R5. Seed identifiers only, never credentials.
select email, created_at from public.bootstrap_admins order by email;
select email, role, capabilities, accepted_at, revoked_at from public.role_invitations order by invited_at;
