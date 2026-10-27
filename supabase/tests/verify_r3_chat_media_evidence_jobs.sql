-- Real report-source fixture for service-owned copy continuation. No Storage
-- calls or deployed worker scheduling are emulated by this SQL probe.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9851-000000000001','media051_a','media051_a@example.invalid','+8801985100001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9851-000000000002','media051_b','media051_b@example.invalid','+8801985100002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media051-conv','00000000-0000-4000-9851-000000000001','00000000-0000-4000-9851-000000000002','CONNECTED','00000000-0000-4000-9851-000000000001','media051-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,receipt_connection_epoch) values
 ('media051-message','media051-conv','00000000-0000-4000-9851-000000000001','job evidence',encode(sha256(convert_to('job evidence','UTF8')),'hex'),'media051-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media051-message','00000000-0000-4000-9851-000000000001'),
 ('media051-message','00000000-0000-4000-9851-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9851-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9851-000000000001','media051-message','00000000-0000-4000-9851-000000000101');
reset role;
select public.findback_commit_chat_media('00000000-0000-4000-9851-000000000001',id,generation,object_key,repeat('c',64),'image/webp',500,1280,960)
 from public.chat_media_attachments where id='00000000-0000-4000-9851-000000000101';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9851-000000000002',true);
select set_config('test.media051.report_id',public.findback_submit_message_report(
 '00000000-0000-4000-9851-000000000002','media051-message','OTHER',null,'job evidence'),true);
reset role;
set local role service_role;
select set_config('test.media051.claim',public.findback_claim_chat_media_evidence_job()::text,true);
do $$ declare claim jsonb:=current_setting('test.media051.claim')::jsonb; begin
 if claim is null or claim->>'reportId' is distinct from current_setting('test.media051.report_id')
  or claim->>'sourceAttachmentId' is distinct from '00000000-0000-4000-9851-000000000101'
  or claim->>'sha256' is distinct from repeat('c',64) or claim->>'workToken' is null then
  raise exception 'Service failed to discover canonical report source';
 end if;
 if claim::text ~* '(reporter|actor|userId)' then raise exception 'Work payload leaked reporter identity'; end if;
 if public.findback_claim_chat_media_evidence_job() is not null then raise exception 'Active lease claimed twice'; end if;
end $$;
reset role;
do $$ begin
 begin
  update public.chat_media_report_evidence set work_token=null
   where id=current_setting('test.media051.claim')::jsonb->>'id';
  raise exception 'RED: partial work authority passed shape constraint';
 exception when check_violation then null; end;
end $$;
-- A second actual report with an existing reporter-created reservation must
-- reuse the canonical destination rather than fork evidence ownership.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9851-000000000001',true);
select set_config('test.media051.second_report',public.findback_submit_message_report(
 '00000000-0000-4000-9851-000000000001','media051-message','OTHER',null,'job evidence'),true);
reset role;
set local role service_role;
select set_config('test.media051.reserved',public.findback_reserve_chat_media_report_evidence(
 '00000000-0000-4000-9851-000000000001',current_setting('test.media051.second_report'),
 '00000000-0000-4000-9851-000000000101','00000000-0000-4000-9851-000000000201')::text,true);
select set_config('test.media051.second_claim',public.findback_claim_chat_media_evidence_job()::text,true);
do $$ declare job jsonb:=current_setting('test.media051.second_claim')::jsonb;
 reserved jsonb:=current_setting('test.media051.reserved')::jsonb; begin
 if job->>'id' is distinct from reserved->>'id' or job->>'generation' is distinct from reserved->>'generation'
  or job->>'objectKey' is distinct from reserved->>'objectKey' then raise exception 'Claim forked an existing destination'; end if;
 perform public.findback_finish_chat_media_evidence_job(job->>'id',job->>'generation',job->>'workToken',job->>'objectKey',
  job->>'sha256',job->>'mime',(job->>'bytes')::integer,(job->>'width')::integer,(job->>'height')::integer);
 perform public.findback_finish_chat_media_evidence_job(job->>'id',job->>'generation',job->>'workToken',job->>'objectKey',
  job->>'sha256',job->>'mime',(job->>'bytes')::integer,(job->>'width')::integer,(job->>'height')::integer);
 if public.findback_claim_chat_media_evidence_job() is not null then raise exception 'Attached or active job was rediscovered'; end if;
end $$;
reset role;

-- Real reporter deletion unlinks its report. Service continuation must not need
-- the deleted account ID, nor retain it in any job field or returned payload.
delete from public.users where id='00000000-0000-4000-9851-000000000002';
do $$ begin
 if (select reporter_user_id from public.content_reports where id=current_setting('test.media051.report_id')) is not null then
  raise exception 'Reporter was not unlinked'; end if;
end $$;
update public.chat_media_report_evidence set work_expires_at=clock_timestamp()-interval '1 second'
 where id=current_setting('test.media051.claim')::jsonb->>'id';
set local role service_role;
do $$ declare old_job jsonb:=current_setting('test.media051.claim')::jsonb; begin
 begin
  perform public.findback_finish_chat_media_evidence_job(old_job->>'id',old_job->>'generation',old_job->>'workToken',old_job->>'objectKey',
   old_job->>'sha256',old_job->>'mime',(old_job->>'bytes')::integer,(old_job->>'width')::integer,(old_job->>'height')::integer);
  raise exception 'Expired worker lease completed';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('test.media051.reclaimed',public.findback_claim_chat_media_evidence_job()::text,true);
do $$ declare old_job jsonb:=current_setting('test.media051.claim')::jsonb;
 job jsonb:=current_setting('test.media051.reclaimed')::jsonb; begin
 if job is null or job->>'id' is distinct from old_job->>'id'
  or job->>'generation' is distinct from old_job->>'generation' or job->>'objectKey' is distinct from old_job->>'objectKey'
  or job->>'workToken' is not distinct from old_job->>'workToken' then raise exception 'Reclaim did not reuse destination with new authority'; end if;
 if job::text ~* '(reporter|actor|userId)' then raise exception 'Unlinked work leaked reporter identity'; end if;
 begin
  perform public.findback_finish_chat_media_evidence_job(job->>'id',job->>'generation',old_job->>'workToken',job->>'objectKey',
   job->>'sha256',job->>'mime',(job->>'bytes')::integer,(job->>'width')::integer,(job->>'height')::integer);
  raise exception 'Stale worker token completed reclaimed work';
 exception when insufficient_privilege then null; end;
 begin
  perform public.findback_finish_chat_media_evidence_job(job->>'id',job->>'generation',job->>'workToken',job->>'objectKey',
   repeat('d',64),job->>'mime',(job->>'bytes')::integer,(job->>'width')::integer,(job->>'height')::integer);
  raise exception 'Worker completed with wrong trusted hash';
 exception when insufficient_privilege then null; end;
 perform public.findback_finish_chat_media_evidence_job(job->>'id',job->>'generation',job->>'workToken',job->>'objectKey',
  job->>'sha256',job->>'mime',(job->>'bytes')::integer,(job->>'width')::integer,(job->>'height')::integer);
 perform public.findback_finish_chat_media_evidence_job(job->>'id',job->>'generation',job->>'workToken',job->>'objectKey',
  job->>'sha256',job->>'mime',(job->>'bytes')::integer,(job->>'width')::integer,(job->>'height')::integer);
 if public.findback_claim_chat_media_evidence_job() is not null then raise exception 'Attached job was rediscovered'; end if;
end $$;
reset role;

-- Canonical day-90 erasure owns job tokens too. No shadow job queue survives.
select public.findback_expire_report_evidence(500,evidence_expires_at)
 from public.content_reports where id=current_setting('test.media051.report_id');
do $$ begin
 if exists(select 1 from public.chat_media_report_sources where report_id=current_setting('test.media051.report_id'))
  or exists(select 1 from public.chat_media_report_evidence where report_id=current_setting('test.media051.report_id')) then
  raise exception 'Canonical erasure retained source, evidence or work token'; end if;
end $$;
set local role service_role;
do $$ declare job jsonb:=current_setting('test.media051.reclaimed')::jsonb; begin
 if public.findback_claim_chat_media_evidence_job() is not null then raise exception 'Expired job remained discoverable'; end if;
 begin
  perform public.findback_finish_chat_media_evidence_job(job->>'id',job->>'generation',job->>'workToken',job->>'objectKey',
   job->>'sha256',job->>'mime',(job->>'bytes')::integer,(job->>'width')::integer,(job->>'height')::integer);
  raise exception 'Erased evidence job completed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
 begin perform public.findback_claim_chat_media_evidence_job(); raise exception 'Authenticated caller claimed service work';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_finish_chat_media_evidence_job(null,null,null,null,null,null,1,1,1);
  raise exception 'Authenticated caller completed service work'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform public.findback_claim_chat_media_evidence_job(); raise exception 'Anon caller claimed service work';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_finish_chat_media_evidence_job(null,null,null,null,null,null,1,1,1);
  raise exception 'Anon caller completed service work'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS service discovery, durable leases, stale completion and erasure' as result;
rollback;
begin isolation level repeatable read;
set local role service_role;
do $$ begin
 begin perform public.findback_claim_chat_media_evidence_job(); raise exception 'Claim accepted frozen isolation';
 exception when sqlstate '25001' then null; end;
 begin perform public.findback_finish_chat_media_evidence_job(null,null,null,null,null,null,1,1,1);
  raise exception 'Finish accepted frozen isolation'; exception when sqlstate '25001' then null; end;
end $$;
rollback;
