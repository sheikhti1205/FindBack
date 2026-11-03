-- Disposable actual PostgreSQL/RPC behavior, not hosted/account/device acceptance.
begin;
-- Synthetic elevated commit models the independently verified Edge signature.
-- It exists only inside this rolled-back test; production never grants commit.
create function pg_temp.head_enroll() returns void language plpgsql security definer as $$ declare c jsonb; begin
 c:=public.findback_device_enrollment_challenge(current_setting('head.device'),'04'||repeat('ab',64),'Head fixture','web');
 perform public.findback_device_enrollment_commit(auth.uid()::text,(auth.jwt()->>'session_id')::uuid,(c->>'challengeId')::uuid);
end $$;
grant execute on function pg_temp.head_enroll() to authenticated;
create function pg_temp.head_call(action text,args jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$ begin
 perform set_config('request.jwt.claims',jsonb_build_object('session_id',current_setting('head.device'))::text,true);
 if action='REGISTER' then perform pg_temp.head_enroll(); end if;
 return public.findback_chat_exchange(auth.uid()::text,current_setting('head.device'),action,
  jsonb_build_object('conversationId','00000000-0000-4000-9944-000000000099')||args);
end
$$;
create function pg_temp.head_get() returns jsonb language sql as $$ select pg_temp.head_call('HEAD') $$;
create function pg_temp.head_send(n integer,kind text default 'TEXT') returns jsonb language sql as $$
 select pg_temp.head_call('SEND',jsonb_build_object('recipientId','00000000-0000-4000-9944-000000000002',
  'messageId','00000000-0000-4000-9944-'||lpad(n::text,12,'0'),'body','Head fixture','messageType',kind,
  'expectedEpoch',pg_temp.head_get()->>'epoch','expectedHead',pg_temp.head_get()))
$$;
grant execute on function pg_temp.head_call(text,jsonb),pg_temp.head_get(),pg_temp.head_send(integer,text) to authenticated;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9944-000000000001','head_a','head_a@example.invalid','+8801994400001',1,now(),now()),
 ('00000000-0000-4000-9944-000000000002','head_b','head_b@example.invalid','+8801994400002',1,now(),now());
insert into auth.users(id,email) select id::uuid,email from public.users where username in('head_a','head_b');
insert into auth.sessions(id,user_id) values
 ('00000000-0000-4000-9944-000000000011','00000000-0000-4000-9944-000000000001'),
 ('00000000-0000-4000-9944-000000000022','00000000-0000-4000-9944-000000000002'),
 ('00000000-0000-4000-9944-000000000023','00000000-0000-4000-9944-000000000002');
insert into public.chat_conversations(id,user_a,user_b,state,receipt_connection_epoch) values
 ('00000000-0000-4000-9944-000000000099','00000000-0000-4000-9944-000000000001','00000000-0000-4000-9944-000000000002','CONNECTED','head-connection');
insert into public.chat_member_state(conversation_id,user_id,mode) values
 ('00000000-0000-4000-9944-000000000099','00000000-0000-4000-9944-000000000001','CONNECTED'),
 ('00000000-0000-4000-9944-000000000099','00000000-0000-4000-9944-000000000002','CONNECTED');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000002',true);
select set_config('head.device','00000000-0000-4000-9944-000000000022',true);
select pg_temp.head_call('REGISTER','{"platform":"web"}');
do $$ begin
 if pg_temp.head_get()->>'position'<>'0' then raise exception 'new conversation must start at zero'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000001',true);
select set_config('head.device','00000000-0000-4000-9944-000000000011',true);
select pg_temp.head_call('REGISTER','{"platform":"web"}');
-- New work has no legacy bypass; malformed/absent HEAD cannot authorize SEND.
do $$ declare args jsonb; invalid jsonb; begin
 args:=jsonb_build_object('recipientId','00000000-0000-4000-9944-000000000002',
  'messageId','00000000-0000-4000-9944-000000000199','body','No HEAD admission',
  'expectedEpoch',pg_temp.head_get()->>'epoch');
 foreach invalid in array array[args,args||'{"expectedHead":null}'::jsonb,
  args||'{"expectedHead":{}}'::jsonb,args||'{"expectedHead":[]}'::jsonb] loop
  begin
   perform pg_temp.head_call('SEND',invalid);
   raise exception 'new SEND admitted without a complete authorized HEAD';
  exception when serialization_failure then null;
  end;
 end loop;
end $$;
do $$ begin
 for n in 101..111 loop perform pg_temp.head_send(n); end loop;
 if pg_temp.head_get()->>'position'<>'11' or pg_temp.head_get()->>'messageHead'<>'11' then raise exception 'actor head is not dense'; end if;
end $$;
select set_config('head.before',pg_temp.head_get()::text,true);
select pg_temp.head_send(150,'MEDIA');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000002',true);
select set_config('head.device','00000000-0000-4000-9944-000000000022',true);
do $$ begin
 if pg_temp.head_get()->>'position'<>'11' then raise exception 'pending peer photo activity disclosed'; end if;
end $$;
select set_config('head.peerbefore',pg_temp.head_get()::text,true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000001',true);
select set_config('head.device','00000000-0000-4000-9944-000000000011',true);
select pg_temp.head_send(151);
select public.findback_reserve_chat_media(auth.uid()::text,'00000000-0000-4000-9944-000000000150','00000000-0000-4000-9944-000000000250');
select set_config('head.authority',public.findback_device_admission(current_setting('head.device'))::text,true);
reset role;
select set_config('head.gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9944-000000000250'),true);
select set_config('head.key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9944-000000000250'),true);
set local role service_role;
select public.findback_commit_chat_media_for_device('00000000-0000-4000-9944-000000000001',
 (current_setting('head.authority')::jsonb->>'sessionId')::uuid,current_setting('head.authority')::jsonb->>'deviceId',
 (current_setting('head.authority')::jsonb->>'generation')::uuid,'00000000-0000-4000-9944-000000000250',current_setting('head.gen'),current_setting('head.key'),repeat('a',64),'image/jpeg',100,64,64);
select public.findback_commit_chat_media_for_device('00000000-0000-4000-9944-000000000001',
 (current_setting('head.authority')::jsonb->>'sessionId')::uuid,current_setting('head.authority')::jsonb->>'deviceId',
 (current_setting('head.authority')::jsonb->>'generation')::uuid,'00000000-0000-4000-9944-000000000250',current_setting('head.gen'),current_setting('head.key'),repeat('a',64),'image/jpeg',100,64,64);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000002',true);
select set_config('head.device','00000000-0000-4000-9944-000000000022',true);
do $$ declare page jsonb; begin
  if pg_temp.head_get()->>'position'<>'13' then raise exception 'late photo not appended once after text'; end if;
  if public.findback_chat_media_target_client('00000000-0000-4000-9944-000000000250','READ')->>'sha256'<>repeat('a',64) then
   raise exception 'Current recipient cannot read committed media through session gate'; end if;
 page:=pg_temp.head_call('CONVERSATION_SYNC',jsonb_build_object('head',pg_temp.head_get(),'afterPosition',11));
 if page#>>'{entries,0,messageId}'<>'00000000-0000-4000-9944-000000000151'
  or page#>>'{entries,1,messageId}'<>'00000000-0000-4000-9944-000000000150' then raise exception 'late publication order lost: %',page; end if;
 if page#>>'{throughPosition}'<>'13' or jsonb_array_length(page->'entries')<>2 then raise exception 'range closure missing'; end if;
end $$;
-- A private delete must not move the peer head. State to this actor must hard-gate.
select set_config('head.before',pg_temp.head_get()::text,true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000001',true);
select set_config('head.device','00000000-0000-4000-9944-000000000011',true);
select pg_temp.head_call('DELETE_FOR_ME','{"messageId":"00000000-0000-4000-9944-000000000101"}');
do $$ begin
 if (pg_temp.head_get()->>'stateHead')::bigint=0 then raise exception 'relevant state absent from head'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000002',true);
select set_config('head.device','00000000-0000-4000-9944-000000000022',true);
do $$ begin
 if (pg_temp.head_get()-'serverTime') is distinct from (current_setting('head.before')::jsonb-'serverTime') then raise exception 'private delete leaked through peer head'; end if;
end $$;
-- Erasure after a final HEAD must fence new work under the same pair lock.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000001',true);
select set_config('head.device','00000000-0000-4000-9944-000000000011',true);
select set_config('head.stale',pg_temp.head_get()::text,true);
select pg_temp.head_call('UNSEND','{"messageId":"00000000-0000-4000-9944-000000000102"}');
do $$ begin
 begin
  perform pg_temp.head_call('SEND',jsonb_build_object('messageId','00000000-0000-4000-9944-000000000180',
   'recipientId','00000000-0000-4000-9944-000000000002','body','Stale work','expectedEpoch',pg_temp.head_get()->>'epoch',
   'expectedHead',current_setting('head.stale')::jsonb));
  raise exception 'stale head admitted new work';
 exception when serialization_failure then null;
 end;
 -- Lost response retry still validates payload identity but is not new work.
 if pg_temp.head_send(102)#>>'{}'<>'00000000-0000-4000-9944-000000000102' then raise exception 'accepted replay broken'; end if;
 if pg_temp.head_call('SEND',jsonb_build_object('recipientId','00000000-0000-4000-9944-000000000002',
  'messageId','00000000-0000-4000-9944-000000000102','body','Head fixture','messageType','TEXT',
  'expectedEpoch',current_setting('head.stale')::jsonb->>'epoch',
  'expectedHead',current_setting('head.stale')::jsonb))#>>'{}'<>'00000000-0000-4000-9944-000000000102'
 then raise exception 'stale HEAD broke accepted replay'; end if;
 if pg_temp.head_call('SEND',jsonb_build_object('recipientId','00000000-0000-4000-9944-000000000002',
  'messageId','00000000-0000-4000-9944-000000000102','body','Head fixture','messageType','TEXT'))#>>'{}'
  <>'00000000-0000-4000-9944-000000000102' then raise exception 'HEAD requirement broke accepted replay'; end if;
end $$;
-- An unpublished photo UNSEND must not invent peer activity or erasure metadata.
select pg_temp.head_send(160,'MEDIA');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000002',true);
select set_config('head.device','00000000-0000-4000-9944-000000000022',true);
select set_config('head.before',pg_temp.head_get()::text,true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000001',true);
select set_config('head.device','00000000-0000-4000-9944-000000000011',true);
select pg_temp.head_call('UNSEND','{"messageId":"00000000-0000-4000-9944-000000000160"}');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9944-000000000002',true);
select set_config('head.device','00000000-0000-4000-9944-000000000022',true);
do $$ begin
 if (pg_temp.head_get()-'serverTime') is distinct from (current_setting('head.before')::jsonb-'serverTime') then raise exception 'unpublished photo UNSEND head leak'; end if;
 if exists(select 1 from jsonb_array_elements(pg_temp.head_call('STATE_SYNC','{"afterSequence":0}')) x
  where x#>>'{change,messageId}'='00000000-0000-4000-9944-000000000160') then raise exception 'unpublished photo UNSEND state leak'; end if;
end $$;
-- A replacement installation cannot obtain old bodies from publication metadata.
select set_config('head.device','00000000-0000-4000-9944-000000000023',true);
select pg_temp.head_call('REGISTER','{"platform":"web"}');
do $$ declare page jsonb; begin
 page:=pg_temp.head_call('CONVERSATION_SYNC',jsonb_build_object('head',pg_temp.head_get(),'afterPosition',0));
 if (page#>>'{throughPosition}') is distinct from (pg_temp.head_get()->>'position') then raise exception 'new installation prefix did not close'; end if;
 if exists(select 1 from jsonb_array_elements(page->'entries') x where x->>'kind'<>'STATE'
  and (x->>'disposition' is distinct from 'UNAVAILABLE' or x ? 'envelope')) then raise exception 'metadata fabricated body delivery'; end if;
 if not exists(select 1 from jsonb_array_elements(page->'entries') x where x->>'kind'='STATE') then raise exception 'new installation lost erasure'; end if;
end $$;
reset role;
do $$ begin
 if has_table_privilege('authenticated','public.chat_conversation_log','select')
  or has_table_privilege('anon','public.chat_conversation_heads','select') then raise exception 'private ledger exposed'; end if;
end $$;
rollback;
