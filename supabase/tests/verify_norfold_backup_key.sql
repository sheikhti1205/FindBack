-- Disposable PG/RPC/privileges for the account-scoped Drive backup key.
-- Synthetic claims, not hosted Auth acceptance. Runs after the local migration chain.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9908-000000000001','backup_a','backup-a@example.test','+19909908001',1,now(),now()),
 ('00000000-0000-4000-9908-000000000002','backup_b','backup-b@example.test','+19909908002',1,now(),now());
insert into auth.users(id,email) values
 ('00000000-0000-4000-9908-000000000001','backup-a@example.test'),
 ('00000000-0000-4000-9908-000000000002','backup-b@example.test');
insert into auth.sessions(id,user_id) values
 ('00000000-0000-4000-9908-000000000011','00000000-0000-4000-9908-000000000001'),
 ('00000000-0000-4000-9908-000000000012','00000000-0000-4000-9908-000000000001'),
 ('00000000-0000-4000-9908-000000000013','00000000-0000-4000-9908-000000000001'),
 ('00000000-0000-4000-9908-000000000014','00000000-0000-4000-9908-000000000001'),
 ('00000000-0000-4000-9908-000000000021','00000000-0000-4000-9908-000000000002');

create function pg_temp.backup_claim(n integer,u integer default 1) returns void language plpgsql as $$ begin
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9908-'||lpad(u::text,12,'0'),true);
 perform set_config('request.jwt.claims',jsonb_build_object('session_id','00000000-0000-4000-9908-'||lpad(n::text,12,'0'))::text,true);
end $$;
create function pg_temp.backup_issue(d integer,k text default '04'||repeat('ab',64)) returns jsonb language sql as $$
 select public.findback_device_enrollment_challenge('00000000-0000-4000-9908-'||lpad(d::text,12,'0'),k,'Synthetic device','web')
$$;
create function pg_temp.backup_commit(c jsonb) returns jsonb language sql as $$
 select public.findback_device_enrollment_commit(auth.uid()::text,(auth.jwt()->>'session_id')::uuid,(c->>'challengeId')::uuid)
$$;
grant execute on function pg_temp.backup_claim(integer,integer),pg_temp.backup_issue(integer,text) to authenticated;

-- Enroll A/201 on session 11, A/202 on session 12, B/301 on session 21.
select pg_temp.backup_claim(11);
set local role authenticated;
select set_config('backup.c',pg_temp.backup_issue(201)::text,true);
reset role;
select pg_temp.backup_commit(current_setting('backup.c')::jsonb);
select pg_temp.backup_claim(12);
set local role authenticated;
select set_config('backup.c',pg_temp.backup_issue(202)::text,true);
reset role;
select pg_temp.backup_commit(current_setting('backup.c')::jsonb);
select pg_temp.backup_claim(21,2);
set local role authenticated;
select set_config('backup.c',pg_temp.backup_issue(301)::text,true);
reset role;
select pg_temp.backup_commit(current_setting('backup.c')::jsonb);

-- No direct table read, no anon execute, no service-role execute.
do $$ begin
 if has_table_privilege('authenticated','public.chat_backup_keys','select')
  or has_table_privilege('service_role','public.chat_backup_keys','select')
  or has_function_privilege('anon','public.findback_backup_key(text,jsonb)','execute')
  or has_function_privilege('service_role','public.findback_backup_key(text,jsonb)','execute') then
  raise exception 'backup key authority leaked'; end if;
end $$;

select pg_temp.backup_claim(11);
set local role authenticated;
select set_config('backup.first',public.findback_backup_key('READ')::text,true);
do $$ declare r jsonb:=current_setting('backup.first')::jsonb; begin
 if r->>'accountId'<>'00000000-0000-4000-9908-000000000001'
  or r->>'key'!~'^[0-9a-f]{64}$'
  or r->>'generation'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or (r->>'createdAt')::bigint<1 then raise exception 'bad backup projection'; end if;
 if (select count(*) from jsonb_object_keys(r))<>4 or r ? 'sessionId' or r ? 'deviceId' then
  raise exception 'backup projection leaked context'; end if;
end $$;
-- READ is idempotent: another call (and another device) sees the same active key.
select set_config('backup.second',public.findback_backup_key('READ')::text,true);
do $$ begin
 if (current_setting('backup.first')::jsonb-'createdAt')<>(current_setting('backup.second')::jsonb-'createdAt') then
  raise exception 'READ rotated the account key'; end if;
end $$;
select pg_temp.backup_claim(12);
select set_config('backup.other',public.findback_backup_key('READ')::text,true);
do $$ begin
 if (current_setting('backup.other')::jsonb->>'key')<>(current_setting('backup.first')::jsonb->>'key')
  or (current_setting('backup.other')::jsonb->>'generation')<>(current_setting('backup.first')::jsonb->>'generation') then
  raise exception 'second device did not recover the same key'; end if;
end $$;
-- ROTATE changes both generation and key, and READ then returns the new pair.
select set_config('backup.rotated',public.findback_backup_key('ROTATE')::text,true);
do $$ begin
 if (current_setting('backup.rotated')::jsonb->>'generation')=(current_setting('backup.first')::jsonb->>'generation')
  or (current_setting('backup.rotated')::jsonb->>'key')=(current_setting('backup.first')::jsonb->>'key') then
  raise exception 'rotate kept the old key'; end if;
 if (public.findback_backup_key('READ')->>'generation')<>(current_setting('backup.rotated')::jsonb->>'generation')
  or (public.findback_backup_key('READ')->>'key')<>(current_setting('backup.rotated')::jsonb->>'key') then
  raise exception 'READ lost the rotated key'; end if;
end $$;
-- Another Norfold account gets its own independent key.
select pg_temp.backup_claim(21,2);
do $$ declare r jsonb:=public.findback_backup_key('READ'); begin
 if r->>'accountId'<>'00000000-0000-4000-9908-000000000002' then raise exception 'cross-account key'; end if;
 if r->>'generation'=(current_setting('backup.rotated',true)::jsonb->>'generation')
  or r->>'key'=(current_setting('backup.rotated',true)::jsonb->>'key') then raise exception 'shared account key'; end if;
end $$;
-- Invalid actions and payloads are refused before any key is created.
select pg_temp.backup_claim(11);
do $$ begin
 begin perform public.findback_backup_key('WRITE'); raise exception 'unknown action accepted';
 exception when invalid_parameter_value then null; end;
 begin perform public.findback_backup_key('READ',jsonb_build_object('accountId','x')); raise exception 'args accepted';
 exception when invalid_parameter_value then null; end;
 begin perform public.findback_backup_key(null); raise exception 'null action accepted';
 exception when invalid_parameter_value then null; end;
end $$;
reset role;

-- Revoking the other installation cuts its key access immediately.
select pg_temp.backup_claim(11);
set local role authenticated;
select public.findback_devices('REVOKE',jsonb_build_object('deviceId','00000000-0000-4000-9908-000000000202'));
select pg_temp.backup_claim(12);
do $$ begin
 begin perform public.findback_backup_key('READ'); raise exception 'revoked device read the key';
 exception when insufficient_privilege then null; end;
end $$;
-- The current installation keeps its own access.
select pg_temp.backup_claim(11);
select public.findback_backup_key('READ');
reset role;

-- A rebound installation is fenced from the key by the same admission path:
-- enroll device 203 on session 13, then rebind the same device on session 14.
select pg_temp.backup_claim(13);
set local role authenticated;
select set_config('backup.c',pg_temp.backup_issue(203)::text,true);
reset role;
select pg_temp.backup_commit(current_setting('backup.c')::jsonb);
select pg_temp.backup_claim(14);
set local role authenticated;
select set_config('backup.c',pg_temp.backup_issue(203)::text,true);
reset role;
select pg_temp.backup_commit(current_setting('backup.c')::jsonb);
select pg_temp.backup_claim(13);
set local role authenticated;
do $$ begin
 begin perform public.findback_backup_key('READ'); raise exception 'rebound session read the key';
 exception when insufficient_privilege then null; end;
end $$;
-- The rebond installation itself still recovers the account key.
select pg_temp.backup_claim(14);
select public.findback_backup_key('READ');
reset role;
do $$ begin
 if (select count(*) from public.chat_backup_keys)<>2 then raise exception 'unexpected key rows'; end if;
end $$;
rollback;
