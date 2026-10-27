-- Moderation media evidence must be an independent private object lifecycle.
begin;
do $$ begin
 if to_regprocedure('public.findback_reserve_chat_media_report_evidence(text,text,text,text)') is null
     or to_regprocedure('public.findback_commit_chat_media_report_evidence(text,text,text,text,text,integer,integer,integer)') is null then
  raise exception 'Missing independent media evidence boundary';
 end if;
end $$;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9845-000000000001','media045_a','media045_a@example.invalid','+8801984500001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9845-000000000002','media045_b','media045_b@example.invalid','+8801984500002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9845-000000000003','media045_mod','media045_mod@example.invalid','+8801984500003',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media045-conv','00000000-0000-4000-9845-000000000001','00000000-0000-4000-9845-000000000002','CONNECTED','00000000-0000-4000-9845-000000000001','media045-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,receipt_connection_epoch) values
 ('media045-message','media045-conv','00000000-0000-4000-9845-000000000001','reported media',encode(sha256(convert_to('reported media','UTF8')),'hex'),'media045-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media045-message','00000000-0000-4000-9845-000000000001'),
 ('media045-message','00000000-0000-4000-9845-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9845-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9845-000000000001','media045-message','00000000-0000-4000-9845-000000000101');
reset role;
select set_config('test.media045.source_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9845-000000000101'),true);
select set_config('test.media045.source_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9845-000000000101'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9845-000000000001','00000000-0000-4000-9845-000000000101',current_setting('test.media045.source_gen'),current_setting('test.media045.source_key'),repeat('a',64),'image/jpeg',100,640,480);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9845-000000000002',true);
select set_config('test.media045.report_id',public.findback_submit_message_report(
 '00000000-0000-4000-9845-000000000002','media045-message','OTHER',null,'reported media'),true);
reset role;
set local role service_role;
select set_config('test.media045.evidence_reservation',(public.findback_reserve_chat_media_report_evidence(
 '00000000-0000-4000-9845-000000000002',current_setting('test.media045.report_id'),
 '00000000-0000-4000-9845-000000000101','00000000-0000-4000-9845-000000000201'))::text,true);
select set_config('test.media045.evidence_key',current_setting('test.media045.evidence_reservation')::jsonb->>'objectKey',true);
select set_config('test.media045.evidence_gen',current_setting('test.media045.evidence_reservation')::jsonb->>'generation',true);
select public.findback_commit_chat_media_report_evidence(
 '00000000-0000-4000-9845-000000000201',current_setting('test.media045.evidence_gen'),current_setting('test.media045.evidence_key'),
 repeat('a',64),'image/jpeg',100,640,480);
reset role;

-- The service-only reader must still apply the actor's live moderation role
-- and capability. A reporter and a moderator without reports_review are denied.
set local role service_role;
do $$ begin
 begin
  perform public.findback_read_chat_media_report_evidence(
   '00000000-0000-4000-9845-000000000002','00000000-0000-4000-9845-000000000201');
  raise exception 'Reporter read moderation evidence';
 exception when sqlstate '42501' then null; end;
 begin
  perform public.findback_read_chat_media_report_evidence(
   '00000000-0000-4000-9845-000000000003','00000000-0000-4000-9845-000000000201');
  raise exception 'Unprivileged moderator read moderation evidence';
 exception when sqlstate '42501' then null; end;
end $$;
reset role;
insert into public.user_roles(user_id,role,granted_at)
 values('00000000-0000-4000-9845-000000000003','MODERATOR','2026-10-28T00:00:00Z');
insert into public.user_role_capabilities(user_id,capability,granted_at)
 values('00000000-0000-4000-9845-000000000003','reports_review','2026-10-28T00:00:00Z');
set local role service_role;
do $$ declare payload jsonb; begin
 payload:=public.findback_read_chat_media_report_evidence(
  '00000000-0000-4000-9845-000000000003','00000000-0000-4000-9845-000000000201');
 if payload is null or payload->>'bucket'<>'findback-chat-moderation-evidence'
    or payload->>'reportId'<>current_setting('test.media045.report_id') then
  raise exception 'Authorized moderator could not read bounded evidence metadata';
 end if;
end $$;
reset role;

-- Account deletion unlinks the reporter on the parent report. The independent
-- evidence object may remain until day 90, but it must not retain a shadow copy
-- of the reporter identity.
do $$ begin
 if exists(select 1 from information_schema.columns where table_schema='public'
  and table_name='chat_media_report_evidence' and column_name='reporter_user_id') then
  raise exception 'Moderation evidence retained reporter identity';
 end if;
end $$;

-- Ordinary unsend and metadata deletion must not delete or expose the captured copy.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9845-000000000001',true);
select public.findback_unsend_chat_message('media045-message');
reset role;
delete from public.chat_media_attachments where id='00000000-0000-4000-9845-000000000101';
do $$ begin
 if not exists(select 1 from public.chat_media_report_evidence e
  where e.id='00000000-0000-4000-9845-000000000201' and e.report_id=current_setting('test.media045.report_id')
   and e.source_attachment_id='00000000-0000-4000-9845-000000000101' and e.state='ATTACHED') then
  raise exception 'Unsend or ordinary cleanup removed moderation evidence';
 end if;
end $$;

set local role authenticated;
do $$ declare n integer; begin
 begin
  select count(*) into n from storage.objects where bucket_id='findback-chat-moderation-evidence';
  if n<>0 then raise exception 'Reporter could list moderation evidence'; end if;
 exception when insufficient_privilege then null; end;
end $$;
reset role;

delete from public.users where id='00000000-0000-4000-9845-000000000002';
do $$ begin
 if (select reporter_user_id from public.content_reports
      where id=current_setting('test.media045.report_id')) is not null then
  raise exception 'Reporter identity was not unlinked';
 end if;
 if not exists(select 1 from public.chat_media_report_evidence
  where id='00000000-0000-4000-9845-000000000201' and state='ATTACHED') then
  raise exception 'Reporter deletion removed retained moderation evidence';
 end if;
end $$;

-- The parent report's immutable 90-day erasure atom removes the evidence row
-- and leaves bucket-aware object cleanup provenance for a trusted worker.
select set_config('test.media045.expires_at',(select evidence_expires_at from public.content_reports
 where id=current_setting('test.media045.report_id')),true);
set local role service_role;
select public.findback_expire_report_evidence(500,current_setting('test.media045.expires_at'));
reset role;
do $$ begin
 if exists(select 1 from public.chat_media_report_evidence where id='00000000-0000-4000-9845-000000000201') then
  raise exception 'Expired moderation evidence metadata remained';
 end if;
 if exists(select 1 from public.chat_media_report_sources where report_id=current_setting('test.media045.report_id')) then
  raise exception 'Expired report source snapshot metadata remained';
 end if;
 if not exists(select 1 from public.chat_media_cleanup_queue where bucket_id='findback-chat-moderation-evidence'
  and media_id='00000000-0000-4000-9845-000000000201' and generation=current_setting('test.media045.evidence_gen')
  and object_key=current_setting('test.media045.evidence_key')) then
  raise exception 'Expired moderation object lost cleanup provenance';
 end if;
end $$;
update public.chat_media_cleanup_queue set not_before=clock_timestamp()-interval '1 second'
 where bucket_id='findback-chat-moderation-evidence';
set local role service_role;
do $$ begin
 if not exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where bucket_id='findback-chat-moderation-evidence' and media_id='00000000-0000-4000-9845-000000000201'
   and generation=current_setting('test.media045.evidence_gen') and object_key=current_setting('test.media045.evidence_key')) then
  raise exception 'Evidence cleanup candidate omitted bucket or generation';
 end if;
 perform public.findback_chat_media_cleanup_done('findback-chat-moderation-evidence','00000000-0000-4000-9845-000000000201',
  current_setting('test.media045.evidence_gen'),current_setting('test.media045.evidence_key'));
end $$;
reset role;
select 'PASS independent moderation media evidence retention and denial' as result;
rollback;
