-- Focused upload-generation, limits, metadata, expiry and Storage-denial checks.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9844-000000000001','media044_a','media044_a@example.invalid','+8801984400001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9844-000000000002','media044_b','media044_b@example.invalid','+8801984400002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media044-conv','00000000-0000-4000-9844-000000000001','00000000-0000-4000-9844-000000000002','CONNECTED','00000000-0000-4000-9844-000000000001','media044-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,receipt_connection_epoch) values
 ('media044-message','media044-conv','00000000-0000-4000-9844-000000000001','','media044-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media044-message','00000000-0000-4000-9844-000000000001'),
 ('media044-message','00000000-0000-4000-9844-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9844-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9844-000000000001','media044-message','00000000-0000-4000-9844-000000000101');
reset role;
select set_config('test.media044.stale_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9844-000000000101'),true);

-- Block/unblock changes the admission generation. Retrying must replace the
-- stale pending object instead of returning an unusable reservation forever.
set local role authenticated;
select public.findback_block_user('00000000-0000-4000-9844-000000000002');
select public.findback_unblock_user('00000000-0000-4000-9844-000000000002');
select public.findback_reserve_chat_media('00000000-0000-4000-9844-000000000001','media044-message','00000000-0000-4000-9844-000000000101');
reset role;
do $$ begin
 if (select object_key from public.chat_media_attachments where id='00000000-0000-4000-9844-000000000101')=current_setting('test.media044.stale_key') then
  raise exception 'Block/unblock retry reused stale upload generation';
 end if;
end $$;
select set_config('test.media044.live_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9844-000000000101'),true);
select set_config('test.media044.live_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9844-000000000101'),true);

set local role authenticated;
select public.findback_reserve_chat_media('00000000-0000-4000-9844-000000000001','media044-message','00000000-0000-4000-9844-000000000102');
select public.findback_reserve_chat_media('00000000-0000-4000-9844-000000000001','media044-message','00000000-0000-4000-9844-000000000103');
select public.findback_reserve_chat_media('00000000-0000-4000-9844-000000000001','media044-message','00000000-0000-4000-9844-000000000104');
do $$ begin
 begin
  perform public.findback_reserve_chat_media('00000000-0000-4000-9844-000000000001','media044-message','00000000-0000-4000-9844-000000000105');
  raise exception 'Per-message media limit bypassed';
 exception when sqlstate '54000' then null; end;
end $$;
reset role;

set local role service_role;
do $$ begin
 begin
  perform public.findback_commit_chat_media('00000000-0000-4000-9844-000000000001','00000000-0000-4000-9844-000000000101',current_setting('test.media044.live_gen'),current_setting('test.media044.live_key'),'not-a-sha','image/jpeg',100,640,480);
  raise exception 'Malformed trusted metadata accepted';
 exception when check_violation then null; end;
 perform public.findback_commit_chat_media('00000000-0000-4000-9844-000000000001','00000000-0000-4000-9844-000000000101',current_setting('test.media044.live_gen'),current_setting('test.media044.live_key'),repeat('a',64),'image/jpeg',100,640,480);
end $$;
reset role;

-- A current block revokes gateway reads. Unblocking does not erase history.
set local role authenticated;
select public.findback_block_user('00000000-0000-4000-9844-000000000002');
reset role;
set local role service_role;
do $$ begin
 if public.findback_read_chat_media('00000000-0000-4000-9844-000000000002','00000000-0000-4000-9844-000000000101') is not null then
  raise exception 'Blocked peer retained media read';
 end if;
end $$;
reset role;
set local role authenticated;
select public.findback_unblock_user('00000000-0000-4000-9844-000000000002');
reset role;
set local role service_role;
do $$ begin
 if public.findback_read_chat_media('00000000-0000-4000-9844-000000000002','00000000-0000-4000-9844-000000000101') is null then
  raise exception 'Unblock erased historical media';
 end if;
end $$;
reset role;
update public.chat_media_attachments set expires_at=clock_timestamp()-interval '1 second'
 where id='00000000-0000-4000-9844-000000000101';
set local role service_role;
do $$ begin
 if public.findback_read_chat_media('00000000-0000-4000-9844-000000000002','00000000-0000-4000-9844-000000000101') is not null then
  raise exception 'Expired media remained readable';
 end if;
end $$;
reset role;

insert into storage.objects(bucket_id,name) values('findback-chat-media','test-only/authenticated-denial');
set local role authenticated;
do $$ declare n integer; begin
 begin
  select count(*) into n from storage.objects where bucket_id='findback-chat-media';
  if n<>0 then raise exception 'Authenticated client listed private media'; end if;
 exception when insufficient_privilege then null; end;
 begin
  insert into storage.objects(bucket_id,name) values('findback-chat-media','test-only/client-write');
  raise exception 'Authenticated client wrote private media';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS block generations, limits, metadata, expiry and direct Storage denial' as result;
rollback;
