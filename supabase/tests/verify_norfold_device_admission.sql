-- Synthetic local PostgreSQL only: real routines/grants, not hosted JWT acceptance.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9907-000000000001','admission_a','admission-a@example.test','+19909907001',1,now(),now());
insert into auth.users(id,email) values ('00000000-0000-4000-9907-000000000001','admission-a@example.test');
insert into auth.sessions(id,user_id) values
 ('00000000-0000-4000-9907-000000000011','00000000-0000-4000-9907-000000000001'),
 ('00000000-0000-4000-9907-000000000012','00000000-0000-4000-9907-000000000001');
create function pg_temp.admission_claim(n integer) returns void language plpgsql as $$ begin
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9907-000000000001',true);
 perform set_config('request.jwt.claims',jsonb_build_object('session_id','00000000-0000-4000-9907-'||lpad(n::text,12,'0'))::text,true);
end $$;
create function pg_temp.admission_denied(q text) returns void language plpgsql as $$ begin
 begin execute q; exception when insufficient_privilege then return; end;
 raise exception 'Revoked or unbound route admitted: %',q;
end $$;
grant execute on function pg_temp.admission_claim(integer),pg_temp.admission_denied(text) to authenticated;
select pg_temp.admission_claim(11);
set local role authenticated;
-- VIEWS has no device-presence check on old source. This must fail without binding.
select pg_temp.admission_denied($q$select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9907-000000000101','VIEWS','{}')$q$);
select set_config('admission.c',public.findback_device_enrollment_challenge(
 '00000000-0000-4000-9907-000000000101','04'||repeat('ab',64),'Synthetic browser','web')::text,true);
reset role;
select public.findback_device_enrollment_commit(auth.uid()::text,(auth.jwt()->>'session_id')::uuid,(current_setting('admission.c')::jsonb->>'challengeId')::uuid);
set local role authenticated;
-- Canonical routes still work after signed enrollment; fixtures model verified commit.
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9907-000000000101','REGISTER','{"platform":"web"}');
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9907-000000000101','VIEWS','{}');
select public.findback_fetch_chat_media_delivery(auth.uid()::text,'00000000-0000-4000-9907-000000000101');
select public.findback_chat_receipt_view(auth.uid()::text,'00000000-0000-4000-9907-000000000101',null,'[]');
select public.findback_chat_receipt_observe(auth.uid()::text,'00000000-0000-4000-9907-000000000101',null,null,null);
select public.findback_register_device_token_client('synthetic-admission-token','web');
select set_config('admission.ctx',public.findback_device_admission()::text,true);
reset role;
do $$ begin
 if not exists(select 1 from public.device_tokens where token='synthetic-admission-token'
  and installation_id='00000000-0000-4000-9907-000000000101'
  and auth_session_id='00000000-0000-4000-9907-000000000011'
  and enrollment_generation=(current_setting('admission.ctx')::jsonb->>'generation')::uuid) then
  raise exception 'Push enrollment not bound to canonical authority'; end if;
 if not public.findback_device_push_allowed('00000000-0000-4000-9907-000000000001','synthetic-admission-token') then
  raise exception 'Current push denied'; end if;
end $$;
set local role authenticated;
-- Another installation stays usable when the first is removed.
select pg_temp.admission_claim(12);
select set_config('admission.c',public.findback_device_enrollment_challenge(
 '00000000-0000-4000-9907-000000000102','04'||repeat('cd',64),'Another browser','web')::text,true);
reset role;
select public.findback_device_enrollment_commit(auth.uid()::text,(auth.jwt()->>'session_id')::uuid,(current_setting('admission.c')::jsonb->>'challengeId')::uuid);
set local role authenticated;
select public.findback_devices('REVOKE','{"deviceId":"00000000-0000-4000-9907-000000000101"}');
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9907-000000000102','VIEWS','{}');
select pg_temp.admission_claim(11);
-- Admission precedes validation or legacy function work on every public route.
select pg_temp.admission_denied($q$select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9907-000000000101','REGISTER','{"platform":"web"}')$q$);
select pg_temp.admission_denied($q$select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9907-000000000102','VIEWS','{}')$q$);
select pg_temp.admission_denied($q$select public.findback_chat_receipt_view(auth.uid()::text,'00000000-0000-4000-9907-000000000101',null,null)$q$);
select pg_temp.admission_denied($q$select public.findback_chat_receipt_observe(auth.uid()::text,'00000000-0000-4000-9907-000000000101',null,null,null)$q$);
select pg_temp.admission_denied($q$select public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9907-000000000101',null,null)$q$);
select pg_temp.admission_denied($q$select public.findback_reserve_chat_media(auth.uid()::text,null,null)$q$);
select pg_temp.admission_denied($q$select public.findback_fetch_chat_media_delivery(auth.uid()::text,'00000000-0000-4000-9907-000000000101')$q$);
select pg_temp.admission_denied($q$select public.findback_ack_chat_media_delivery(auth.uid()::text,'00000000-0000-4000-9907-000000000101',null)$q$);
select pg_temp.admission_denied($q$select public.findback_chat_media_target_client(null,'READ')$q$);
select pg_temp.admission_denied($q$select public.findback_register_device_token_client('synthetic-admission-token','web')$q$);
select pg_temp.admission_denied($q$select public.findback_unregister_device_token_client('synthetic-admission-token')$q$);
reset role;
do $$ declare f record; begin
 if public.findback_device_push_allowed('00000000-0000-4000-9907-000000000001','synthetic-admission-token') then
  raise exception 'Revoked token eligible'; end if;
 -- Stale verified Edge context cannot commit media after revocation, even though
 -- the privileged gateway is service-only. Error must precede attachment lookup.
 begin
  perform public.findback_commit_chat_media_for_device('00000000-0000-4000-9907-000000000001',
   '00000000-0000-4000-9907-000000000011','00000000-0000-4000-9907-000000000101',
   (current_setting('admission.ctx')::jsonb->>'generation')::uuid,null,null,null,null,null,null,null,null);
  raise exception 'Stale Edge commit admitted'; exception when insufficient_privilege then null; end;
 for f in select p.oid::regprocedure sig from pg_proc p where p.pronamespace='public'::regnamespace
  and p.proname like '%_authority_legacy_internal' loop
  if has_function_privilege('authenticated',f.sig,'execute') or has_function_privilege('anon',f.sig,'execute')
   or has_function_privilege('service_role',f.sig,'execute') then raise exception 'Legacy alias exposed: %',f.sig; end if;
 end loop;
 if has_function_privilege('authenticated','public.findback_commit_chat_media_for_device(text,uuid,text,uuid,text,text,text,text,text,integer,integer,integer)','execute')
  or has_function_privilege('authenticated','public.findback_device_push_allowed(text,text)','execute') then raise exception 'Service authority exposed'; end if;
end $$;
-- Deletion fences deny even while a profile/Auth session still exists.
insert into public.account_deletion_fences(user_id) values ('00000000-0000-4000-9907-000000000001');
select pg_temp.admission_claim(12);
set local role authenticated;
select pg_temp.admission_denied($q$select public.findback_device_admission()$q$);
reset role;
rollback;
