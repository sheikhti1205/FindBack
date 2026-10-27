-- Ordinary source bytes remain protected until every live report snapshot has
-- an ATTACHED independent evidence copy. Candidate selection and acknowledgement
-- must enforce the same guard so a stale worker cannot win the copy race.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9848-000000000001','media048_a','media048_a@example.invalid','+8801984800001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9848-000000000002','media048_b','media048_b@example.invalid','+8801984800002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media048-conv','00000000-0000-4000-9848-000000000001','00000000-0000-4000-9848-000000000002','CONNECTED','00000000-0000-4000-9848-000000000001','media048-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,receipt_connection_epoch) values
 ('media048-message','media048-conv','00000000-0000-4000-9848-000000000001','cleanup guard',encode(sha256(convert_to('cleanup guard','UTF8')),'hex'),'media048-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media048-message','00000000-0000-4000-9848-000000000001'),
 ('media048-message','00000000-0000-4000-9848-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9848-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9848-000000000001','media048-message','00000000-0000-4000-9848-000000000101');
reset role;
select set_config('test.media048.source_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9848-000000000101'),true);
select set_config('test.media048.source_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9848-000000000101'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9848-000000000001','00000000-0000-4000-9848-000000000101',current_setting('test.media048.source_gen'),current_setting('test.media048.source_key'),repeat('d',64),'image/jpeg',400,1200,900);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9848-000000000002',true);
select set_config('test.media048.report_id',public.findback_submit_message_report(
 '00000000-0000-4000-9848-000000000002','media048-message','OTHER',null,'cleanup guard'),true);
reset role;

-- Ordinary metadata deletion queues the object. Advance that queue beyond its
-- one-hour grace period while the captured report still lacks its own copy.
delete from public.chat_media_attachments where id='00000000-0000-4000-9848-000000000101';
update public.chat_media_cleanup_queue set not_before=clock_timestamp()-interval '1 second'
 where bucket_id='findback-chat-media' and media_id='00000000-0000-4000-9848-000000000101';
set local role service_role;
do $$ begin
 if exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where bucket_id='findback-chat-media' and media_id='00000000-0000-4000-9848-000000000101') then
  raise exception 'Source cleanup raced ahead of evidence reservation';
 end if;
 perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9848-000000000101',
  current_setting('test.media048.source_gen'),current_setting('test.media048.source_key'));
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.chat_media_cleanup_queue where bucket_id='findback-chat-media'
  and media_id='00000000-0000-4000-9848-000000000101') then
  raise exception 'Cleanup acknowledgement released source before evidence reservation';
 end if;
end $$;

set local role service_role;
select set_config('test.media048.reservation',(public.findback_reserve_chat_media_report_evidence(
 '00000000-0000-4000-9848-000000000002',current_setting('test.media048.report_id'),
 '00000000-0000-4000-9848-000000000101','00000000-0000-4000-9848-000000000201'))::text,true);
select set_config('test.media048.evidence_key',current_setting('test.media048.reservation')::jsonb->>'objectKey',true);
select set_config('test.media048.evidence_gen',current_setting('test.media048.reservation')::jsonb->>'generation',true);
do $$ begin
 if exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where bucket_id='findback-chat-media' and media_id='00000000-0000-4000-9848-000000000101') then
  raise exception 'Source cleanup raced ahead of evidence commit';
 end if;
 perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9848-000000000101',
  current_setting('test.media048.source_gen'),current_setting('test.media048.source_key'));
 perform public.findback_commit_chat_media_report_evidence(
  '00000000-0000-4000-9848-000000000201',current_setting('test.media048.evidence_gen'),current_setting('test.media048.evidence_key'),
  repeat('d',64),'image/jpeg',400,1200,900);
 if not exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where bucket_id='findback-chat-media' and media_id='00000000-0000-4000-9848-000000000101') then
  raise exception 'Attached evidence did not release ordinary source cleanup';
 end if;
 perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9848-000000000101',
  current_setting('test.media048.source_gen'),current_setting('test.media048.source_key'));
end $$;
reset role;
do $$ begin
 if exists(select 1 from public.chat_media_attachments where id='00000000-0000-4000-9848-000000000101') then
  raise exception 'Released ordinary source metadata remained';
 end if;
 if exists(select 1 from public.chat_media_cleanup_queue where bucket_id='findback-chat-media'
  and media_id='00000000-0000-4000-9848-000000000101') then
  raise exception 'Released ordinary source cleanup provenance remained';
 end if;
 if not exists(select 1 from public.chat_media_report_evidence
  where id='00000000-0000-4000-9848-000000000201' and state='ATTACHED') then
  raise exception 'Source cleanup damaged attached moderation evidence';
 end if;
end $$;
select 'PASS source cleanup waits for attached report evidence' as result;
rollback;
