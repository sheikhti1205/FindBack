-- A report may capture only media attached at report time, and that immutable
-- source set must survive ordinary attachment metadata deletion.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9846-000000000001','media046_a','media046_a@example.invalid','+8801984600001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9846-000000000002','media046_b','media046_b@example.invalid','+8801984600002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media046-conv','00000000-0000-4000-9846-000000000001','00000000-0000-4000-9846-000000000002','CONNECTED','00000000-0000-4000-9846-000000000001','media046-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,receipt_connection_epoch) values
 ('media046-message-late','media046-conv','00000000-0000-4000-9846-000000000001','late media',encode(sha256(convert_to('late media','UTF8')),'hex'),'media046-epoch'),
 ('media046-message-kept','media046-conv','00000000-0000-4000-9846-000000000001','kept media',encode(sha256(convert_to('kept media','UTF8')),'hex'),'media046-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media046-message-late','00000000-0000-4000-9846-000000000001'),
 ('media046-message-late','00000000-0000-4000-9846-000000000002'),
 ('media046-message-kept','00000000-0000-4000-9846-000000000001'),
 ('media046-message-kept','00000000-0000-4000-9846-000000000002');

-- First report a text-only message, then add media. That later attachment must
-- never enter the report's immutable source set.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9846-000000000002',true);
select set_config('test.media046.late_report',public.findback_submit_message_report(
 '00000000-0000-4000-9846-000000000002','media046-message-late','OTHER',null,'late media'),true);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9846-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9846-000000000001','media046-message-late','00000000-0000-4000-9846-000000000101');
reset role;
select set_config('test.media046.late_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9846-000000000101'),true);
select set_config('test.media046.late_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9846-000000000101'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9846-000000000001','00000000-0000-4000-9846-000000000101',current_setting('test.media046.late_gen'),current_setting('test.media046.late_key'),repeat('a',64),'image/jpeg',100,640,480);
do $$ declare admitted boolean:=true; begin
 begin
  perform public.findback_reserve_chat_media_report_evidence(
   '00000000-0000-4000-9846-000000000002',current_setting('test.media046.late_report'),
   '00000000-0000-4000-9846-000000000101','00000000-0000-4000-9846-000000000201');
 exception when sqlstate '42501' then admitted:=false; end;
 perform set_config('test.media046.late_admitted',admitted::text,true);
end $$;
reset role;
update public.content_reports set created_at=to_char((clock_timestamp() at time zone 'utc')-interval '2 days','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 where id=current_setting('test.media046.late_report');

-- Attach media before reporting, then remove the ordinary metadata. The report
-- must retain enough immutable provenance for the gateway to reserve its copy.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9846-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9846-000000000001','media046-message-kept','00000000-0000-4000-9846-000000000102');
reset role;
select set_config('test.media046.kept_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9846-000000000102'),true);
select set_config('test.media046.kept_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9846-000000000102'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9846-000000000001','00000000-0000-4000-9846-000000000102',current_setting('test.media046.kept_gen'),current_setting('test.media046.kept_key'),repeat('b',64),'image/webp',200,800,600);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9846-000000000002',true);
select set_config('test.media046.kept_report',public.findback_submit_message_report(
 '00000000-0000-4000-9846-000000000002','media046-message-kept','OTHER',null,'kept media'),true);
reset role;
delete from public.chat_media_attachments where id='00000000-0000-4000-9846-000000000102';
set local role service_role;
do $$ declare retained boolean:=true; payload jsonb; begin
 begin
  payload:=public.findback_reserve_chat_media_report_evidence(
   '00000000-0000-4000-9846-000000000002',current_setting('test.media046.kept_report'),
   '00000000-0000-4000-9846-000000000102','00000000-0000-4000-9846-000000000202');
  retained:=payload->>'sourceObjectKey'=current_setting('test.media046.kept_key')
   and payload->>'sha256'=repeat('b',64);
 exception when sqlstate '42501' then retained:=false; end;
 perform set_config('test.media046.kept_retained',retained::text,true);
end $$;
reset role;

do $$ begin
 if current_setting('test.media046.late_admitted')::boolean then
  raise exception 'Post-report attachment entered immutable evidence set';
 end if;
 if not current_setting('test.media046.kept_retained')::boolean then
  raise exception 'Report-time attachment provenance did not survive metadata deletion';
 end if;
end $$;
select 'PASS immutable report-time media provenance' as result;
rollback;
