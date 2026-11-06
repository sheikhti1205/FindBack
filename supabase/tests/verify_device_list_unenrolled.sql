-- Synthetic RPC/privilege regression; never real-account acceptance.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9907-000000000001','list_a','list-a@example.test','+19909907001',1,now(),now()),
 ('00000000-0000-4000-9907-000000000002','list_b','list-b@example.test','+19909907002',1,now(),now());
insert into auth.users(id,email) values
 ('00000000-0000-4000-9907-000000000001','list-a@example.test'),
 ('00000000-0000-4000-9907-000000000002','list-b@example.test');
insert into auth.sessions(id,user_id) values
 ('00000000-0000-4000-9907-000000000011','00000000-0000-4000-9907-000000000001'),
 ('00000000-0000-4000-9907-000000000012','00000000-0000-4000-9907-000000000001'),
 ('00000000-0000-4000-9907-000000000021','00000000-0000-4000-9907-000000000002');
insert into public.chat_devices(user_id,device_id,device_name,platform,public_key,auth_session_id,enrollment_generation) values
 ('00000000-0000-4000-9907-000000000001','00000000-0000-4000-9907-000000000101','Other browser','web','04'||repeat('ab',64),'00000000-0000-4000-9907-000000000011','00000000-0000-4000-9907-000000000201');
insert into public.chat_device_sessions(session_id,user_id,device_id,generation) values
 ('00000000-0000-4000-9907-000000000011','00000000-0000-4000-9907-000000000001','00000000-0000-4000-9907-000000000101','00000000-0000-4000-9907-000000000201');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9907-000000000001',true);
select set_config('request.jwt.claims','{"session_id":"00000000-0000-4000-9907-000000000012"}',true);
set local role authenticated;
do $$ declare r jsonb; begin
 r:=public.findback_devices('LIST','{}');
 if jsonb_array_length(r)<>1 or r->0->>'name'<>'Other browser' or (r->0->>'current')::boolean
  or (select count(*) from jsonb_object_keys(r->0))<>5 then raise exception 'unenrolled list missing or private fields leaked'; end if;
 begin perform public.findback_devices('RENAME','{"deviceId":"00000000-0000-4000-9907-000000000101","name":"Unsafe"}');
  raise exception 'unenrolled mutation admitted'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"session_id":"00000000-0000-4000-9907-000000000011"}',true);
do $$ begin
 if not (public.findback_devices('LIST','{}')->0->>'current')::boolean then raise exception 'current device lost'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9907-000000000002',true);
select set_config('request.jwt.claims','{"session_id":"00000000-0000-4000-9907-000000000021"}',true);
do $$ begin
 if public.findback_devices('LIST','{}')<>'[]'::jsonb then raise exception 'other account devices leaked'; end if;
end $$;
-- Valid user but another account's session cannot read its roster.
select set_config('request.jwt.claims','{"session_id":"00000000-0000-4000-9907-000000000011"}',true);
do $$ begin
 begin perform public.findback_devices('LIST','{}'); raise exception 'wrong session admitted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.chat_device_sessions set revoked_at=now() where session_id='00000000-0000-4000-9907-000000000011';
select set_config('request.jwt.claim.sub','00000000-0000-4000-9907-000000000001',true);
set local role authenticated;
do $$ begin
 begin perform public.findback_devices('LIST','{}'); raise exception 'removed session resurrected'; exception when insufficient_privilege then null; end;
end $$;
reset role;
delete from auth.sessions where id='00000000-0000-4000-9907-000000000012';
select set_config('request.jwt.claims','{"session_id":"00000000-0000-4000-9907-000000000012"}',true);
set local role authenticated;
do $$ begin
 begin perform public.findback_devices('LIST','{}'); raise exception 'ended session admitted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS device list: unenrolled visibility, current identity, scoped rows, mutation/revocation/session fences' as result;
rollback;
