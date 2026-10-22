-- HOSTED ONLY, read-only. NOT RUN: file presence is not hosted acceptance.
-- Archive actual output alongside the accepted migration hash after deployment.
select p.proname,pg_get_function_identity_arguments(p.oid) as args,
 pg_get_functiondef(p.oid) as definition,pg_get_function_result(p.oid) as output,
 p.provolatile,p.prosecdef,p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='findback_match_candidates_client';
select routine_name,grantee,privilege_type from information_schema.role_routine_grants
where routine_schema='public' and routine_name='findback_match_candidates_client' order by grantee;
select version from supabase_migrations.schema_migrations order by version desc limit 3;
