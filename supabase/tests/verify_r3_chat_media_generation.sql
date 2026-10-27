-- Cleanup/retry must not let an old worker delete or commit a new generation.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9843-000000000001','media043_a','media043_a@example.invalid','+8801984300001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9843-000000000002','media043_b','media043_b@example.invalid','+8801984300002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media043-conv','00000000-0000-4000-9843-000000000001','00000000-0000-4000-9843-000000000002','CONNECTED','00000000-0000-4000-9843-000000000001','media043-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,receipt_connection_epoch) values
 ('media043-message','media043-conv','00000000-0000-4000-9843-000000000001','','media043-epoch');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9843-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9843-000000000001','media043-message','00000000-0000-4000-9843-000000000101');
reset role;
select set_config('test.media043.old_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9843-000000000101'),true);
select set_config('test.media043.old_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9843-000000000101'),true);
update public.chat_media_attachments set expires_at=clock_timestamp()-interval '2 hours';
set local role service_role;
select public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9843-000000000101',current_setting('test.media043.old_gen'),current_setting('test.media043.old_key'));
reset role;
set local role authenticated;
select public.findback_reserve_chat_media('00000000-0000-4000-9843-000000000001','media043-message','00000000-0000-4000-9843-000000000101');
reset role;
do $$ begin
 if (select object_key from public.chat_media_attachments where id='00000000-0000-4000-9843-000000000101')=current_setting('test.media043.old_key') then
  raise exception 'Reservation reused a deleted object generation'; end if;
end $$;
select set_config('test.media043.new_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9843-000000000101'),true);
select set_config('test.media043.new_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9843-000000000101'),true);
set local role service_role;
do $$ begin
 begin
   perform public.findback_commit_chat_media('00000000-0000-4000-9843-000000000001','00000000-0000-4000-9843-000000000101',current_setting('test.media043.old_gen'),current_setting('test.media043.old_key'),repeat('a',64),'image/jpeg',100,640,480);
  raise exception 'Old upload committed new generation';
 exception when insufficient_privilege then null; end;
  perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9843-000000000101',current_setting('test.media043.old_gen'),current_setting('test.media043.old_key'));
  perform public.findback_commit_chat_media('00000000-0000-4000-9843-000000000001','00000000-0000-4000-9843-000000000101',current_setting('test.media043.new_gen'),current_setting('test.media043.new_key'),repeat('a',64),'image/jpeg',100,640,480);
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.chat_media_attachments where state='ATTACHED' and object_key=current_setting('test.media043.new_key')) then
  raise exception 'Old cleanup removed new reservation'; end if;
end $$;
select 'PASS distinct upload generations and stale commit/cleanup denial' as result;
rollback;
