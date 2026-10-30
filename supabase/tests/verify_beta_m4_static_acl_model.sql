-- DISPOSABLE LOCAL ONLY. Independent PostgreSQL oracle for M4 static-guard
-- semantics; rollback-only metadata/ACL probes, never hosted acceptance.
begin;
create function pg_temp.m4_acl_check(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'M4 ACL MODEL: %',label; end if; end $$;

create table public.m4_acl_columns(id text,width integer,height integer);
revoke all on public.m4_acl_columns from public,anon,authenticated;
grant select(id,width) on public.m4_acl_columns to authenticated;
select pg_temp.m4_acl_check(
 has_column_privilege('authenticated','public.m4_acl_columns','width','select')
 and not has_column_privilege('authenticated','public.m4_acl_columns','height','select'),
 'compact SELECT grants exactly the named columns');

create function public.m4_acl_original(p_id text, -- not a type, or argument
 p_note text default null) returns text language sql security definer as $$ select p_id; $$;
revoke all on function public.m4_acl_original(text,text) from public,authenticated;
alter function public.m4_acl_original(text,text) rename to m4_acl_delegate;
create function public.m4_acl_original(p_id text,p_note text default null) returns text language sql as $$ select p_id; $$;
select pg_temp.m4_acl_check(
 not has_function_privilege('authenticated','public.m4_acl_delegate(text,text)','execute')
 and has_function_privilege('authenticated','public.m4_acl_original(text,text)','execute'),
 'rename preserves private delegate ACL and new wrapper starts with PUBLIC EXECUTE');

revoke all on function public.m4_acl_original from public,authenticated;
select pg_temp.m4_acl_check(not has_function_privilege('authenticated','public.m4_acl_original(text,text)','execute'),
 'a unique bare-name revoke resolves to its only signature');
create or replace function public.m4_acl_original(p_id text,p_note text default null) returns text language sql as $$ select p_note; $$;
select pg_temp.m4_acl_check(not has_function_privilege('authenticated','public.m4_acl_original(text,text)','execute'),
 'CREATE OR REPLACE preserves explicit revokes');
drop function public.m4_acl_original(text,text);
create function public.m4_acl_original(p_id text,p_note text default null) returns text language sql as $$ select p_id; $$;
select pg_temp.m4_acl_check(has_function_privilege('authenticated','public.m4_acl_original(text,text)','execute'),
 'DROP then CREATE resets PUBLIC EXECUTE');

revoke all on function public.m4_acl_original(text,text),public.m4_acl_delegate(text,text) from public,authenticated;
grant execute on function public.m4_acl_original(text,text),public.m4_acl_delegate(text,text) to service_role;
select pg_temp.m4_acl_check(
 not has_function_privilege('authenticated','public.m4_acl_original(text,text)','execute')
 and not has_function_privilege('authenticated','public.m4_acl_delegate(text,text)','execute')
 and has_function_privilege('service_role','public.m4_acl_original(text,text)','execute')
 and has_function_privilege('service_role','public.m4_acl_delegate(text,text)','execute'),
 'multi-function grant/revoke applies to every listed signature');
rollback;
