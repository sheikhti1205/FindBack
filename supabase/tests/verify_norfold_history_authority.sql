-- Disposable synthetic RPC/privacy tests. No production accounts or bodies.
begin;
insert into public.users(id,username,email,phone,created_at,updated_at) values
 ('00000000-0000-4000-9910-000000000001','recovery_a','recovery-a@example.test','+19909910001',now(),now()),
 ('00000000-0000-4000-9910-000000000002','recovery_b','recovery-b@example.test','+19909910002',now(),now()),
 ('00000000-0000-4000-9910-000000000003','recovery_c','recovery-c@example.test','+19909910003',now(),now());
insert into auth.users(id,email) select id::uuid,email from public.users where id like '00000000-0000-4000-9910-%';
insert into auth.sessions(id,user_id) select ('00000000-0000-4000-9910-'||lpad((10+n)::text,12,'0'))::uuid,
 ('00000000-0000-4000-9910-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3) n;
create function pg_temp.claim(n integer) returns void language plpgsql as $$ begin
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9910-'||lpad(n::text,12,'0'),true);
 perform set_config('request.jwt.claims',jsonb_build_object('session_id','00000000-0000-4000-9910-'||lpad((10+n)::text,12,'0'))::text,true);
end $$;
grant execute on function pg_temp.claim(integer) to authenticated;
do $$ declare n integer; c jsonb; begin
 for n in 1..3 loop
  perform pg_temp.claim(n);
  c:=public.findback_device_enrollment_challenge('00000000-0000-4000-9910-'||lpad((10+n)::text,12,'0'),'04'||repeat('ab',64),'Recovery fixture','web');
  perform public.findback_device_enrollment_commit(auth.uid()::text,(auth.jwt()->>'session_id')::uuid,(c->>'challengeId')::uuid);
 end loop;
end $$;
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by) values
 ('00000000-0000-4000-9910-000000000100','00000000-0000-4000-9910-000000000001','00000000-0000-4000-9910-000000000002','CONNECTED','00000000-0000-4000-9910-000000000001');
-- Elevated fixture inserts model already accepted identity, NOT a sending route.
insert into public.chat_messages(id,conversation_id,sender_id,body,message_type,payload_identity) values
 ('00000000-0000-4000-9910-000000000201','00000000-0000-4000-9910-000000000100','00000000-0000-4000-9910-000000000001','Original é','TEXT',public.findback_chat_payload_identity('Original é','TEXT',null,null,null,null)),
 ('00000000-0000-4000-9910-000000000202','00000000-0000-4000-9910-000000000100','00000000-0000-4000-9910-000000000001','Withheld','TEXT',public.findback_chat_payload_identity('Withheld','TEXT',null,null,null,null)),
 ('00000000-0000-4000-9910-000000000203','00000000-0000-4000-9910-000000000100','00000000-0000-4000-9910-000000000001','Legacy','TEXT',null);
insert into public.chat_message_audience(message_id,user_id)
 select m.id,u.id from public.chat_messages m cross join public.users u
 where m.conversation_id='00000000-0000-4000-9910-000000000100' and u.id in('00000000-0000-4000-9910-000000000001','00000000-0000-4000-9910-000000000002')
 and (m.id<>'00000000-0000-4000-9910-000000000202' or u.id='00000000-0000-4000-9910-000000000001') on conflict do nothing;
select set_config('recovery.epoch',public.findback_chat_relationship_epoch(c),true) from public.chat_conversations c where id='00000000-0000-4000-9910-000000000100';
select set_config('recovery.hash',payload_identity,true) from public.chat_messages where id='00000000-0000-4000-9910-000000000201';
select set_config('recovery.withheld_hash',payload_identity,true) from public.chat_messages where id='00000000-0000-4000-9910-000000000202';
do $$ begin assert current_setting('recovery.hash')='ab5491462857aef5c3428614cfbf416521b90644acc517b42e40ef1eb00e9882','UTF8 v2 cross-platform vector'; end $$;
-- Erase retained body as mailbox cleanup would. Identity remains recoverable.
update public.chat_messages set body='' where id='00000000-0000-4000-9910-000000000201';
create function pg_temp.authority(target integer default 2) returns jsonb language sql as $$
 select public.findback_chat_history_authority('00000000-0000-4000-9910-000000000100',current_setting('recovery.epoch'),
  '00000000-0000-4000-9910-'||lpad(target::text,12,'0'),jsonb_build_array(
   jsonb_build_object('messageId','00000000-0000-4000-9910-000000000201','payloadIdentity',current_setting('recovery.hash')),
   jsonb_build_object('messageId','00000000-0000-4000-9910-000000000202','payloadIdentity',current_setting('recovery.withheld_hash')),
   jsonb_build_object('messageId','00000000-0000-4000-9910-000000000203','payloadIdentity',repeat('a',64)),
   jsonb_build_object('messageId','00000000-0000-4000-9910-000000000999','payloadIdentity',repeat('a',64))))
$$;
grant execute on function pg_temp.authority(integer) to authenticated;
select pg_temp.claim(1);
set local role authenticated;
do $$ declare r jsonb; begin
 r:=pg_temp.authority();
 assert jsonb_array_length(r)=1,'TTL recovery accepts exact identity, omits unknown/legacy/withheld';
 assert r->0->>'messageId'='00000000-0000-4000-9910-000000000201','canonical id';
 assert r->0->>'authorId'='00000000-0000-4000-9910-000000000001','canonical author';
 assert r->0->>'recipientId'='00000000-0000-4000-9910-000000000002','canonical recipient';
 assert r->0->>'messageType'='TEXT' and (r->0->>'sequence')::bigint>0 and (r->0->>'sentAt')::bigint>0,'canonical metadata';
 assert not(r->0 ?| array['body','readAt','deletedForMe','clears','location','contextReportId']),'body-free/private-free';
 begin perform pg_temp.authority(3); raise exception 'nonmember target accepted'; exception when insufficient_privilege then null; end;
 begin perform public.findback_chat_history_authority('00000000-0000-4000-9910-000000000100',repeat('0',64),auth.uid()::text,'[]');
  raise exception 'stale epoch accepted'; exception when serialization_failure then null; end;
 begin perform public.findback_chat_history_authority('00000000-0000-4000-9910-000000000100',current_setting('recovery.epoch'),auth.uid()::text,
  jsonb_build_array(jsonb_build_object('messageId','00000000-0000-4000-9910-000000000201','payloadIdentity',current_setting('recovery.hash'),'body','leak')));
  raise exception 'body accepted'; exception when invalid_parameter_value then null; end;
  assert not has_function_privilege('anon','public.findback_chat_history_authority(text,text,text,jsonb)','execute'),'anon denied';
  assert jsonb_array_length(public.findback_chat_history_authority('00000000-0000-4000-9910-000000000100',current_setting('recovery.epoch'),
   auth.uid()::text,jsonb_build_array(jsonb_build_object('messageId','00000000-0000-4000-9910-000000000201','payloadIdentity',repeat('b',64)))))=0,'wrong body identity omitted';
  begin perform public.findback_chat_history_authority('00000000-0000-4000-9910-000000000100',current_setting('recovery.epoch'),auth.uid()::text,
   (select jsonb_agg(jsonb_build_object('messageId','00000000-0000-4000-9910-'||lpad((300+n)::text,12,'0'),'payloadIdentity',repeat('a',64))) from generate_series(1,65) n));
   raise exception 'oversize batch admitted'; exception when program_limit_exceeded then null; end;
  begin perform public.findback_chat_history_authority('00000000-0000-4000-9910-000000000100',current_setting('recovery.epoch'),auth.uid()::text,
   jsonb_build_array(jsonb_build_object('messageId','00000000-0000-4000-9910-000000000201','payloadIdentity',current_setting('recovery.hash')),
    jsonb_build_object('messageId','00000000-0000-4000-9910-000000000201','payloadIdentity',current_setting('recovery.hash'))));
   raise exception 'duplicate inventory admitted'; exception when invalid_parameter_value then null; end;
end $$;
select pg_temp.claim(3);
do $$ begin begin perform pg_temp.authority(); raise exception 'nonparticipant admitted'; exception when insufficient_privilege then null; end; end $$;
select pg_temp.claim(2);
do $$ begin assert jsonb_array_length(pg_temp.authority(1))=1,'receiver authority before import'; end $$;
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9910-000000000012','DELETE_FOR_ME',
 '{"conversationId":"00000000-0000-4000-9910-000000000100","messageId":"00000000-0000-4000-9910-000000000201"}');
do $$ begin assert jsonb_array_length(pg_temp.authority(1))=0,'receiver private deletion wins'; end $$;
select pg_temp.claim(1);
do $$ begin assert jsonb_array_length(pg_temp.authority())=1,'target private deletion is not observable to the sender'; end $$;
reset role;
select pg_temp.claim(1);
set local role authenticated;
select set_config('recovery.peer',public.findback_history_peer('OPEN',jsonb_build_object(
 'conversationId','00000000-0000-4000-9910-000000000100','epoch',current_setting('recovery.epoch'),
 'peerAccountId','00000000-0000-4000-9910-000000000002','targetDeviceId','00000000-0000-4000-9910-000000000012'))->>'sessionId',true);
select public.findback_history_peer('WRITE',jsonb_build_object('sessionId',current_setting('recovery.peer'),'type','offer','data',
 jsonb_build_object('sdp','v=0'||chr(13)||chr(10)||'a=fingerprint:sha-256 '||repeat('AB:',31)||'AB')));
select pg_temp.claim(2);
do $$ declare r jsonb; begin
 r:=public.findback_history_peer('PENDING','{}');
 assert jsonb_array_length(r)=1 and r->0->>'sessionId'=current_setting('recovery.peer'),'incoming discovery';
 r:=public.findback_history_peer('READ',jsonb_build_object('sessionId',current_setting('recovery.peer'),'after',0));
 assert r->>'peerAccountId'='00000000-0000-4000-9910-000000000001','verified counterpart';
 assert r->>'conversationId'='00000000-0000-4000-9910-000000000100' and r->>'epoch'=current_setting('recovery.epoch'),'scope bound';
 assert jsonb_array_length(r->'signals')=1,'scoped offer delivered';
 begin perform public.findback_history_peer('WRITE',jsonb_build_object('sessionId',current_setting('recovery.peer'),'type','offer','data','{}'::jsonb));
  raise exception 'wrong endpoint wrote offer'; exception when insufficient_privilege then null; end;
 assert not has_table_privilege('authenticated','public.chat_peer_sessions','select'),'private signaling storage';
end $$;
select pg_temp.claim(3);
do $$ begin
 assert jsonb_array_length(public.findback_history_peer('PENDING','{}'))=0,'other user no sessions';
 begin perform public.findback_history_peer('READ',jsonb_build_object('sessionId',current_setting('recovery.peer'),'after',0));
  raise exception 'unrelated session leaked'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Media export must not reveal the recipient's private media deletion either.
insert into public.chat_messages(id,conversation_id,sender_id,body,message_type,payload_identity) values
 ('00000000-0000-4000-9910-000000000204','00000000-0000-4000-9910-000000000100','00000000-0000-4000-9910-000000000001','Photo','MEDIA',public.findback_chat_payload_identity('Photo','MEDIA',null,null,null,null));
insert into public.chat_message_audience(message_id,user_id) values
 ('00000000-0000-4000-9910-000000000204','00000000-0000-4000-9910-000000000001'),
 ('00000000-0000-4000-9910-000000000204','00000000-0000-4000-9910-000000000002');
insert into public.chat_media_attachments(id,message_id,author_id,conversation_id,connection_epoch,block_epoch,object_key,state,sha256,mime,byte_size,width,height,expires_at)
 select '00000000-0000-4000-9910-000000000304','00000000-0000-4000-9910-000000000204',c.user_a,c.id,
  coalesce(c.receipt_connection_epoch,gen_random_uuid()::text),c.receipt_block_epoch,'chat-media/recovery-fixture/photo','ATTACHED',repeat('a',64),'image/jpeg',1024,64,64,clock_timestamp()+interval '1 hour'
 from public.chat_conversations c where id='00000000-0000-4000-9910-000000000100';
select set_config('recovery.media_hash',payload_identity,true) from public.chat_messages where id='00000000-0000-4000-9910-000000000204';
create function pg_temp.media_authority(target integer) returns jsonb language sql as $$
 select public.findback_chat_history_authority('00000000-0000-4000-9910-000000000100',current_setting('recovery.epoch'),
  '00000000-0000-4000-9910-'||lpad(target::text,12,'0'),jsonb_build_array(jsonb_build_object('messageId','00000000-0000-4000-9910-000000000204','payloadIdentity',current_setting('recovery.media_hash'))))
$$;
grant execute on function pg_temp.media_authority(integer) to authenticated;
select pg_temp.claim(2);
set local role authenticated;
do $$ begin assert jsonb_array_length(pg_temp.media_authority(1))=1,'published media recovery'; end $$;
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9910-000000000012','DELETE_FOR_ME',
 '{"conversationId":"00000000-0000-4000-9910-000000000100","messageId":"00000000-0000-4000-9910-000000000204"}');
do $$ begin assert jsonb_array_length(pg_temp.media_authority(1))=0,'receiver-private media deletion wins'; end $$;
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9910-000000000012','CLEAR_FOR_ME',
 '{"conversationId":"00000000-0000-4000-9910-000000000100","throughSequence":999999}');
select pg_temp.claim(1);
do $$ begin
 assert jsonb_array_length(pg_temp.media_authority(2))=1,'recipient-private media deletion and clear not observable';
 assert jsonb_array_length(pg_temp.authority())=1,'recipient-private clear not observable';
end $$;
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9910-000000000011','UNSEND',
 '{"conversationId":"00000000-0000-4000-9910-000000000100","messageId":"00000000-0000-4000-9910-000000000201"}');
do $$ begin assert jsonb_array_length(pg_temp.authority())=0,'universal unsend denies export';
 assert jsonb_array_length(pg_temp.authority(1))=1,'own published withheld body still eligible'; end $$;
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9910-000000000011','CLEAR_FOR_ME',
 '{"conversationId":"00000000-0000-4000-9910-000000000100","throughSequence":999999}');
do $$ begin assert jsonb_array_length(pg_temp.authority(1))=0 and jsonb_array_length(pg_temp.media_authority(2))=0,'caller-private clear denies own export'; end $$;
reset role;
update public.chat_devices set enrollment_generation=gen_random_uuid() where device_id='00000000-0000-4000-9910-000000000012';
select pg_temp.claim(1);
set local role authenticated;
do $$ begin
 begin perform public.findback_history_peer('CHECK',jsonb_build_object('sessionId',current_setting('recovery.peer')));
  raise exception 'changed endpoint admitted'; exception when insufficient_privilege then null; end;
 begin perform public.findback_peer_history_authority(current_setting('recovery.peer')::uuid,'[]');
  raise exception 'changed endpoint page authority'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
