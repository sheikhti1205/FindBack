-- Cascading ordinary metadata removal must not lose storage cleanup provenance.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9842-000000000001','media042_a','media042_a@example.invalid','+8801984200001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9842-000000000002','media042_b','media042_b@example.invalid','+8801984200002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media042-conv','00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000002','CONNECTED','00000000-0000-4000-9842-000000000001','media042-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,receipt_connection_epoch) values
 ('media042-message','media042-conv','00000000-0000-4000-9842-000000000001','','media042-epoch');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9842-000000000001','media042-message','00000000-0000-4000-9842-000000000101');
reset role;
select set_config('test.media042.deleted_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9842-000000000101'),true);
select set_config('test.media042.deleted_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9842-000000000101'),true);
delete from public.chat_messages where id='media042-message';
do $$ begin
 if to_regclass('public.chat_media_cleanup_queue') is null then raise exception 'Cascade lost object cleanup provenance'; end if;
 if not exists(select 1 from public.chat_media_cleanup_queue where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Cascade lost object key'; end if;
end $$;
-- The queue survives account/conversation deletion and holds no user/message FK.
delete from public.chat_conversations where id='media042-conv';
delete from public.users where id='00000000-0000-4000-9842-000000000001';
set local role service_role;
do $$ begin
 if exists(select 1 from public.findback_chat_media_cleanup_candidates(100) where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Cleanup ignored in-flight upload grace'; end if;
  perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9842-000000000101',current_setting('test.media042.deleted_gen'),current_setting('test.media042.deleted_key'));
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.chat_media_cleanup_queue where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Premature cleanup acknowledgement dropped provenance'; end if;
end $$;
update public.chat_media_cleanup_queue set not_before=clock_timestamp()-interval '1 second';
set local role service_role;
do $$ begin
 if not exists(select 1 from public.findback_chat_media_cleanup_candidates(100) where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Orphan omitted from cleanup'; end if;
  perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9842-000000000101',current_setting('test.media042.deleted_gen'),current_setting('test.media042.deleted_key'));
  perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9842-000000000101',current_setting('test.media042.deleted_gen'),current_setting('test.media042.deleted_key'));
end $$;
reset role;
do $$ begin
 if exists(select 1 from public.chat_media_cleanup_queue where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Cleanup acknowledgement retained deleted key'; end if;
end $$;
select 'PASS cascade cleanup provenance, grace and idempotent acknowledgement' as result;
rollback;
