-- Disposable local PostgreSQL contract tests. No Storage gateway is emulated.
begin;
do $$ begin
 if to_regprocedure('public.findback_reserve_chat_media(text,text,text)') is null then
  raise exception 'Missing private media reservation boundary';
 end if;
end $$;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9841-000000000001','media041_a','media041_a@example.invalid','+8801984100001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9841-000000000002','media041_b','media041_b@example.invalid','+8801984100002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9841-000000000003','media041_c','media041_c@example.invalid','+8801984100003',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by) values
 ('media041-conv','00000000-0000-4000-9841-000000000001','00000000-0000-4000-9841-000000000002','REQUEST','00000000-0000-4000-9841-000000000001');
insert into public.chat_messages(id,conversation_id,sender_id,body) values
 ('media041-message','media041-conv','00000000-0000-4000-9841-000000000001','');
insert into public.chat_message_audience(message_id,user_id) values
 ('media041-message','00000000-0000-4000-9841-000000000001'),('media041-message','00000000-0000-4000-9841-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9841-000000000001',true);
do $$ begin
 begin
  perform public.findback_reserve_chat_media('00000000-0000-4000-9841-000000000001','media041-message','00000000-0000-4000-9841-000000000101');
  raise exception 'REQUEST reservation allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.chat_conversations set state='CONNECTED' where id='media041-conv';
update public.chat_messages set receipt_connection_epoch=(select receipt_connection_epoch from public.chat_conversations where id='media041-conv') where id='media041-message';
set local role authenticated;
do $$ begin
 begin
  perform public.findback_reserve_chat_media('00000000-0000-4000-9841-000000000002','media041-message','00000000-0000-4000-9841-000000000101');
  raise exception 'account switch bypass';
 exception when insufficient_privilege then null; end;
 perform public.findback_reserve_chat_media('00000000-0000-4000-9841-000000000001','media041-message','00000000-0000-4000-9841-000000000101');
 perform public.findback_reserve_chat_media('00000000-0000-4000-9841-000000000001','media041-message','00000000-0000-4000-9841-000000000101');
 begin
   perform public.findback_commit_chat_media('00000000-0000-4000-9841-000000000001','00000000-0000-4000-9841-000000000101','untrusted-generation','untrusted-key',repeat('a',64),'image/jpeg',100,640,480);
  raise exception 'untrusted commit allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 if (select count(*) from public.chat_media_attachments)<>1 then raise exception 'reservation retry duplicated'; end if;
end $$;
select set_config('test.media041.key101',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9841-000000000101'),true);
select set_config('test.media041.gen101',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9841-000000000101'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9841-000000000001','00000000-0000-4000-9841-000000000101',current_setting('test.media041.gen101'),current_setting('test.media041.key101'),repeat('a',64),'image/jpeg',100,640,480);
select public.findback_commit_chat_media('00000000-0000-4000-9841-000000000001','00000000-0000-4000-9841-000000000101',current_setting('test.media041.gen101'),current_setting('test.media041.key101'),repeat('a',64),'image/jpeg',100,640,480);
do $$ begin
 begin
   perform public.findback_commit_chat_media('00000000-0000-4000-9841-000000000001','00000000-0000-4000-9841-000000000101',current_setting('test.media041.gen101'),current_setting('test.media041.key101'),repeat('b',64),'image/jpeg',100,640,480);
  raise exception 'immutable content changed';
 exception when insufficient_privilege then null; end;
 if public.findback_read_chat_media('00000000-0000-4000-9841-000000000002','00000000-0000-4000-9841-000000000101') is null then raise exception 'recipient read missing'; end if;
 if public.findback_read_chat_media('00000000-0000-4000-9841-000000000003','00000000-0000-4000-9841-000000000101') is not null then raise exception 'nonparticipant read'; end if;
end $$;
reset role;
-- Historical reads survive End, but an old upload cannot finalize after End/reaccept.
set local role authenticated;
select public.findback_reserve_chat_media('00000000-0000-4000-9841-000000000001','media041-message','00000000-0000-4000-9841-000000000102');
select public.findback_end_conversation('media041-conv');
reset role;
set local role service_role;
do $$ begin
 if public.findback_read_chat_media('00000000-0000-4000-9841-000000000002','00000000-0000-4000-9841-000000000101') is null then raise exception 'End erased historical read'; end if;
 begin
   perform public.findback_commit_chat_media('00000000-0000-4000-9841-000000000001','00000000-0000-4000-9841-000000000102','unavailable-generation','unavailable-after-end',repeat('a',64),'image/jpeg',100,640,480);
  raise exception 'finalized after End';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9841-000000000002',true);
select public.findback_register_chat_device('00000000-0000-4000-9841-000000000012','web');
select public.findback_chat_exchange('00000000-0000-4000-9841-000000000002','00000000-0000-4000-9841-000000000012',
 'DELETE_FOR_ME','{"conversationId":"media041-conv","messageId":"media041-message"}'::jsonb);
reset role;
set local role service_role;
do $$ begin
 if public.findback_read_chat_media('00000000-0000-4000-9841-000000000002','00000000-0000-4000-9841-000000000101') is not null then raise exception 'personal delete ignored'; end if;
 if public.findback_read_chat_media('00000000-0000-4000-9841-000000000001','00000000-0000-4000-9841-000000000101') is null then raise exception 'personal delete erased peer'; end if;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9841-000000000001',true);
select public.findback_unsend_chat_message('media041-message');
reset role;
set local role service_role;
do $$ begin
 if public.findback_read_chat_media('00000000-0000-4000-9841-000000000001','00000000-0000-4000-9841-000000000101') is not null then raise exception 'unsend ignored'; end if;
end $$;
reset role;
select 'PASS media reservation, trusted commit, idempotency, End, deletion and unsend' as result;
rollback;
