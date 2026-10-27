-- Trusted service preservation must survive reporter unlinking before reserve;
-- after reserve only the exact opaque generation and metadata may complete it.
begin;
do $$ begin
 if to_regprocedure('public.findback_commit_chat_media_report_evidence(text,text,text,text,text,integer,integer,integer)') is null then
  raise exception 'Missing actor-independent evidence completion boundary';
 end if;
end $$;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9847-000000000001','media047_a','media047_a@example.invalid','+8801984700001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9847-000000000002','media047_b','media047_b@example.invalid','+8801984700002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9847-000000000003','media047_mod','media047_mod@example.invalid','+8801984700003',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.user_roles(user_id,role,granted_at)
 values('00000000-0000-4000-9847-000000000003','MODERATOR','2026-10-28T00:00:00Z');
insert into public.user_role_capabilities(user_id,capability,granted_at)
 values('00000000-0000-4000-9847-000000000003','reports_review','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media047-conv','00000000-0000-4000-9847-000000000001','00000000-0000-4000-9847-000000000002','CONNECTED','00000000-0000-4000-9847-000000000001','media047-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,receipt_connection_epoch) values
 ('media047-message','media047-conv','00000000-0000-4000-9847-000000000001','delete race',encode(sha256(convert_to('delete race','UTF8')),'hex'),'media047-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media047-message','00000000-0000-4000-9847-000000000001'),
 ('media047-message','00000000-0000-4000-9847-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9847-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9847-000000000001','media047-message','00000000-0000-4000-9847-000000000101');
reset role;
select set_config('test.media047.source_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9847-000000000101'),true);
select set_config('test.media047.source_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9847-000000000101'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9847-000000000001','00000000-0000-4000-9847-000000000101',current_setting('test.media047.source_gen'),current_setting('test.media047.source_key'),repeat('c',64),'image/png',300,1024,768);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9847-000000000002',true);
select set_config('test.media047.report_id',public.findback_submit_message_report(
 '00000000-0000-4000-9847-000000000002','media047-message','OTHER',null,'delete race'),true);
reset role;
set local role service_role;
do $$ begin
 begin
  perform public.findback_reserve_chat_media_report_evidence(
   null,current_setting('test.media047.report_id'),
   '00000000-0000-4000-9847-000000000101','00000000-0000-4000-9847-000000000201');
  raise exception 'NULL service authority bypassed a still-linked reporter';
 exception when sqlstate '42501' then null; end;
end $$;
reset role;
delete from public.users where id='00000000-0000-4000-9847-000000000002';
set local role service_role;
do $$ begin
 begin
  perform public.findback_reserve_chat_media_report_evidence(
   '00000000-0000-4000-9847-000000000001',current_setting('test.media047.report_id'),
   '00000000-0000-4000-9847-000000000101','00000000-0000-4000-9847-000000000201');
  raise exception 'Guessed actor reserved evidence after reporter unlinking';
 exception when sqlstate '42501' then null; end;
end $$;
select set_config('test.media047.reservation',(public.findback_reserve_chat_media_report_evidence(
 null,current_setting('test.media047.report_id'),
 '00000000-0000-4000-9847-000000000101','00000000-0000-4000-9847-000000000201'))::text,true);
select set_config('test.media047.evidence_key',current_setting('test.media047.reservation')::jsonb->>'objectKey',true);
select set_config('test.media047.evidence_gen',current_setting('test.media047.reservation')::jsonb->>'generation',true);
do $$ begin
 begin
  perform public.findback_commit_chat_media_report_evidence(
   '00000000-0000-4000-9847-000000000201',gen_random_uuid()::text,current_setting('test.media047.evidence_key'),
   repeat('c',64),'image/png',300,1024,768);
  raise exception 'Guessed generation completed evidence';
 exception when sqlstate '42501' then null; end;
 begin
  perform public.findback_commit_chat_media_report_evidence(
   '00000000-0000-4000-9847-000000000201',current_setting('test.media047.evidence_gen'),'evidence/guessed',
   repeat('c',64),'image/png',300,1024,768);
  raise exception 'Guessed object key completed evidence';
 exception when sqlstate '42501' then null; end;
end $$;
select public.findback_commit_chat_media_report_evidence(
 '00000000-0000-4000-9847-000000000201',current_setting('test.media047.evidence_gen'),current_setting('test.media047.evidence_key'),
 repeat('c',64),'image/png',300,1024,768);
-- Exact retry is idempotent after the reporter is gone.
select public.findback_commit_chat_media_report_evidence(
 '00000000-0000-4000-9847-000000000201',current_setting('test.media047.evidence_gen'),current_setting('test.media047.evidence_key'),
 repeat('c',64),'image/png',300,1024,768);
do $$ declare payload jsonb; begin
 payload:=public.findback_read_chat_media_report_evidence(
  '00000000-0000-4000-9847-000000000003','00000000-0000-4000-9847-000000000201');
 if payload is null or payload->>'reportId'<>current_setting('test.media047.report_id') then
  raise exception 'Moderator could not read evidence completed after reporter deletion';
 end if;
end $$;
reset role;
do $$ begin
 if (select reporter_user_id from public.content_reports where id=current_setting('test.media047.report_id')) is not null then
  raise exception 'Reporter identity remained linked';
 end if;
 if not exists(select 1 from public.chat_media_report_evidence
  where id='00000000-0000-4000-9847-000000000201' and state='ATTACHED') then
  raise exception 'Evidence did not complete after reporter deletion';
 end if;
end $$;
select 'PASS reserve and completion survive reporter deletion with opaque authority' as result;
rollback;
