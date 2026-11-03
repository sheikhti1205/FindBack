-- Actual disposable PG/RPC/privileges. Synthetic claims, not hosted Auth acceptance.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9906-000000000001','device_a','device-a@example.test','+19909906001',1,now(),now()),
 ('00000000-0000-4000-9906-000000000002','device_b','device-b@example.test','+19909906002',1,now(),now());
insert into auth.users(id,email) values
 ('00000000-0000-4000-9906-000000000001','device-a@example.test'),
 ('00000000-0000-4000-9906-000000000002','device-b@example.test');
insert into auth.sessions(id,user_id) values
 ('00000000-0000-4000-9906-000000000011','00000000-0000-4000-9906-000000000001'),
 ('00000000-0000-4000-9906-000000000012','00000000-0000-4000-9906-000000000001'),
 ('00000000-0000-4000-9906-000000000013','00000000-0000-4000-9906-000000000001'),
 ('00000000-0000-4000-9906-000000000021','00000000-0000-4000-9906-000000000002');
create function pg_temp.device_claim(n integer,u integer default 1) returns void language plpgsql as $$ begin
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9906-'||lpad(u::text,12,'0'),true);
 perform set_config('request.jwt.claims',jsonb_build_object('session_id','00000000-0000-4000-9906-'||lpad(n::text,12,'0'))::text,true);
end $$;
create function pg_temp.device_issue(d integer,k text default '04'||repeat('ab',64)) returns jsonb language sql as $$
 select public.findback_device_enrollment_challenge('00000000-0000-4000-9906-'||lpad(d::text,12,'0'),k,'Synthetic phone','web')
$$;
create function pg_temp.device_commit(c jsonb) returns jsonb language sql as $$
 select public.findback_device_enrollment_commit(auth.uid()::text,(auth.jwt()->>'session_id')::uuid,(c->>'challengeId')::uuid)
$$;
grant execute on function pg_temp.device_claim(integer,integer),pg_temp.device_issue(integer,text) to authenticated;
select pg_temp.device_claim(11);
set local role authenticated;
-- Missing feature must fail here on old source; no direct table/helper/commit grants.
select set_config('device.c',pg_temp.device_issue(101)::text,true);
select public.findback_device_enrollment_proof((current_setting('device.c')::jsonb->>'challengeId')::uuid);
do $$ begin
 if has_function_privilege('authenticated','public.findback_device_enrollment_commit(text,uuid,uuid)','execute')
  or has_table_privilege('authenticated','public.chat_device_sessions','select')
  or has_table_privilege('authenticated','public.chat_device_challenges','select') then raise exception 'private authority leaked'; end if;
end $$;
reset role;
select pg_temp.device_commit(current_setting('device.c')::jsonb);
do $$ begin
 if has_function_privilege('anon','public.findback_device_enrollment_proof(uuid)','execute') then raise exception 'anon proof access'; end if;
end $$;
-- Corrupt/null association must not pass SQL three-valued comparisons.
update public.chat_devices set auth_session_id=null where device_id='00000000-0000-4000-9906-000000000101';
set local role authenticated;
do $$ begin
 begin perform public.findback_device_admission(); raise exception 'null association admitted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.chat_devices set auth_session_id='00000000-0000-4000-9906-000000000011' where device_id='00000000-0000-4000-9906-000000000101';
do $$ begin
 begin perform pg_temp.device_commit(current_setting('device.c')::jsonb); raise exception 'challenge replay accepted';
 exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
select public.findback_devices('LIST','{}'::jsonb);
do $$ declare r jsonb; begin
 r:=public.findback_devices('LIST','{}'::jsonb);
 if jsonb_array_length(r)<>1 or r->0->>'name'<>'Synthetic phone' or not (r->0->>'current')::boolean
  or r->0 ? 'publicKey' or r->0 ? 'sessionId' then raise exception 'consumer device projection'; end if;
 begin perform pg_temp.device_issue(102); raise exception 'session alias accepted'; exception when insufficient_privilege then null; end;
end $$;
select public.findback_devices('RENAME',jsonb_build_object('deviceId','00000000-0000-4000-9906-000000000101','name','  My browser  '));
do $$ begin
 if public.findback_devices('LIST','{}')->0->>'name'<>'My browser' then raise exception 'rename not persisted'; end if;
 begin perform public.findback_device_admission('00000000-0000-4000-9906-000000000999'); raise exception 'alias admission'; exception when insufficient_privilege then null; end;
end $$;
select pg_temp.device_claim(12);
select set_config('device.c',pg_temp.device_issue(102)::text,true);
reset role;
select pg_temp.device_commit(current_setting('device.c')::jsonb);
set local role authenticated;
select pg_temp.device_claim(11);
select set_config('device.peer',public.findback_peer_signal('OPEN',jsonb_build_object('targetDeviceId','00000000-0000-4000-9906-000000000102'))->>'sessionId',true);
select public.findback_peer_signal('WRITE',jsonb_build_object('sessionId',current_setting('device.peer'),'type','offer',
 'data',jsonb_build_object('sdp','v=0'||chr(13)||chr(10)||'a=fingerprint:sha-256 '||repeat('AB:',31)||'AB'||chr(13)||chr(10))));
select pg_temp.device_claim(12);
do $$ declare r jsonb; begin
 r:=public.findback_peer_signal('READ',jsonb_build_object('sessionId',current_setting('device.peer'),'after',0));
 if jsonb_array_length(r->'signals')<>1 or r->'signals'->0->>'type'<>'offer' then raise exception 'scoped signaling missing'; end if;
 begin perform public.findback_peer_signal('WRITE',jsonb_build_object('sessionId',current_setting('device.peer'),'type','offer','data',jsonb_build_object('sdp','v=0')));
  raise exception 'wrong signaling role accepted'; exception when insufficient_privilege then null; end;
 begin perform public.findback_peer_signal('WRITE',jsonb_build_object('sessionId',current_setting('device.peer'),'type','candidate','data',jsonb_build_object('candidate','candidate:x','body','message')));
  raise exception 'message in signaling accepted'; exception when invalid_parameter_value then null; end;
 if has_table_privilege('authenticated','public.chat_peer_sessions','select')
  or has_table_privilege('authenticated','public.chat_peer_signals','select') then raise exception 'signaling table exposed'; end if;
 begin
  for i in 1..65 loop perform public.findback_peer_signal('WRITE',jsonb_build_object('sessionId',current_setting('device.peer'),'type','candidate',
    'data',jsonb_build_object('candidate','candidate:x','sdpMid','0','sdpMLineIndex',0))); end loop;
  raise exception 'signaling count unbounded'; exception when program_limit_exceeded then null;
 end;
end $$;
reset role;
update public.chat_peer_sessions set expires_at=clock_timestamp()-interval '1 second' where id=current_setting('device.peer')::uuid;
set local role authenticated;
do $$ begin
 begin perform public.findback_peer_signal('READ',jsonb_build_object('sessionId',current_setting('device.peer'),'after',0));
  raise exception 'expired signaling disclosed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.chat_peer_sessions set expires_at=clock_timestamp()+interval '60 seconds' where id=current_setting('device.peer')::uuid;
set local role authenticated;
select set_config('device.expired',pg_temp.device_issue(102)::text,true);
reset role;
update public.chat_device_challenges set expires_ms=0 where id=(current_setting('device.expired')::jsonb->>'challengeId')::uuid;
do $$ begin
 begin perform pg_temp.device_commit(current_setting('device.expired')::jsonb); raise exception 'expired challenge committed';
  exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
-- Existing installation rebind must prove the same key; replacing it is forbidden.
select pg_temp.device_claim(13);
do $$ begin
 begin perform pg_temp.device_issue(101,'04'||repeat('cd',64)); raise exception 'key replacement accepted';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('device.c',pg_temp.device_issue(101)::text,true);
reset role;
select pg_temp.device_commit(current_setting('device.c')::jsonb);
set local role authenticated;
select pg_temp.device_claim(11);
do $$ begin
 begin perform pg_temp.device_issue(103); raise exception 'old rebound session accepted'; exception when insufficient_privilege then null; end;
 begin perform public.findback_devices('LIST','{}'); raise exception 'old session read accepted'; exception when insufficient_privilege then null; end;
end $$;
select pg_temp.device_claim(12);
do $$ begin
 begin perform public.findback_peer_signal('READ',jsonb_build_object('sessionId',current_setting('device.peer'),'after',0));
  raise exception 'rebound endpoint signaling survived'; exception when insufficient_privilege then null; end;
end $$;
-- Current installation can revoke another; pending proof must not commit afterward.
select pg_temp.device_claim(12);
select set_config('device.late',pg_temp.device_issue(102)::text,true);
select pg_temp.device_claim(13);
select public.findback_devices('REVOKE',jsonb_build_object('deviceId','00000000-0000-4000-9906-000000000102'));
select pg_temp.device_claim(12);
do $$ begin
 begin perform pg_temp.device_issue(999); raise exception 'revoked session new UUID accepted'; exception when insufficient_privilege then null; end;
 begin perform pg_temp.device_issue(101); raise exception 'revoked session other UUID accepted'; exception when insufficient_privilege then null; end;
 begin perform public.findback_devices('LIST','{}'); raise exception 'revoked read accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 begin perform pg_temp.device_commit(current_setting('device.late')::jsonb); raise exception 'post revoke commit accepted'; exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
select pg_temp.device_claim(21,2);
select set_config('device.c',pg_temp.device_issue(201)::text,true);
reset role;
select pg_temp.device_commit(current_setting('device.c')::jsonb);
set local role authenticated;
do $$ begin
 if jsonb_array_length(public.findback_devices('LIST','{}'))<>1 then raise exception 'cross account roster'; end if;
 begin perform public.findback_peer_signal('READ',jsonb_build_object('sessionId',current_setting('device.peer'),'after',0));
  raise exception 'cross account signaling accepted'; exception when insufficient_privilege then null; end;
 begin perform public.findback_devices('REVOKE',jsonb_build_object('deviceId','00000000-0000-4000-9906-000000000101'));
  raise exception 'cross account revoke'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{}',true);
do $$ begin
 begin perform pg_temp.device_issue(202); raise exception 'missing session accepted'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"session_id":"bad"}',true);
do $$ begin
 begin perform pg_temp.device_issue(202); raise exception 'malformed session accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.device_claim(21,2);
delete from auth.sessions where id='00000000-0000-4000-9906-000000000021';
set local role authenticated;
do $$ begin
 begin perform public.findback_devices('LIST','{}'); raise exception 'signed out JWT accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
