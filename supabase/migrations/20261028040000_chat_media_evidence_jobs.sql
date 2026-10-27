-- Service-owned continuation of captured report media. Job authority is an
-- opaque lease on the canonical evidence row, never a reporter shadow identity.
begin;
alter table public.chat_media_report_evidence
 add column work_token text,
 add column work_expires_at timestamptz,
 add constraint chat_media_evidence_work_shape check(
  (work_token is null and work_expires_at is null) or
  (work_token is not null and work_token ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and work_expires_at is not null and work_expires_at<=expires_at));

create function public.findback_claim_chat_media_evidence_job()
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_report_id text; v_source_id text; r public.content_reports%rowtype;
 s public.chat_media_report_sources%rowtype; e public.chat_media_report_evidence%rowtype;
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'Evidence work requires READ COMMITTED' using errcode='25001';
 end if;
 -- Lock the parent, not a nullable evidence row. Another worker skips the
 -- report rather than blocking or claiming the same unfinished destination.
 select report.id,source.source_attachment_id into v_report_id,v_source_id
 from public.content_reports report
 join public.chat_media_report_sources source on source.report_id=report.id
 left join public.chat_media_report_evidence evidence on evidence.report_id=report.id
  and evidence.source_attachment_id=source.source_attachment_id
 where report.target_type='MESSAGE' and report.evidence_erased_at is null
  and report.evidence_expires_at::timestamptz>clock_timestamp()
  and (evidence.id is null or (evidence.state='PENDING'
   and evidence.expires_at>clock_timestamp()
   and (evidence.work_expires_at is null or evidence.work_expires_at<=clock_timestamp())))
 order by report.created_at,report.id,source.source_attachment_id
 limit 1 for update of report skip locked;
 if not found then return null; end if;
 -- Re-read after the parent fence, matching canonical reserve/commit/expiry.
 select * into r from public.content_reports where id=v_report_id;
 if r.evidence_erased_at is not null or r.evidence_expires_at::timestamptz<=clock_timestamp() then return null; end if;
 select * into s from public.chat_media_report_sources
  where report_id=r.id and source_attachment_id=v_source_id for update;
 if not found then return null; end if;
 select * into e from public.chat_media_report_evidence
  where report_id=r.id and source_attachment_id=s.source_attachment_id for update;
 if found then
  if e.state<>'PENDING' or e.expires_at<=clock_timestamp()
   or e.work_expires_at>clock_timestamp() then return null; end if;
 else
  -- No caller-chosen ID: report/source locks and the canonical unique key
  -- serialize construction. Do not invert reserve's ID advisory -> report
  -- order by calling the caller-ID reserve function under this report lock.
  insert into public.chat_media_report_evidence(id,report_id,source_attachment_id,source_message_id,
   object_key,sha256,mime,byte_size,width,height,expires_at)
  values(gen_random_uuid()::text,r.id,s.source_attachment_id,s.source_message_id,
   'evidence/'||gen_random_uuid()::text,s.sha256,s.mime,s.byte_size,s.width,s.height,
   r.evidence_expires_at::timestamptz) returning * into e;
 end if;
 update public.chat_media_report_evidence
  set work_token=gen_random_uuid()::text,
   work_expires_at=least(clock_timestamp()+interval '5 minutes',e.expires_at)
  where id=e.id returning * into e;
 return jsonb_build_object('id',e.id,'reportId',r.id,'sourceAttachmentId',s.source_attachment_id,
  'generation',e.generation,'workToken',e.work_token,'workExpiresAt',e.work_expires_at,
  'sourceBucket','findback-chat-media','sourceObjectKey',s.source_object_key,
  'bucket','findback-chat-moderation-evidence','objectKey',e.object_key,
  'sha256',e.sha256,'mime',e.mime,'bytes',e.byte_size,'width',e.width,'height',e.height,'expiresAt',e.expires_at);
end $$;
revoke all on function public.findback_claim_chat_media_evidence_job() from public,anon,authenticated;
grant execute on function public.findback_claim_chat_media_evidence_job() to service_role;

create function public.findback_finish_chat_media_evidence_job(
 p_evidence_id text,p_generation text,p_work_token text,p_object_key text,
 p_sha text,p_mime text,p_bytes integer,p_width integer,p_height integer
) returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_report_id text; r public.content_reports%rowtype; e public.chat_media_report_evidence%rowtype;
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'Evidence work requires READ COMMITTED' using errcode='25001';
 end if;
 select report_id into v_report_id from public.chat_media_report_evidence where id=p_evidence_id;
 select * into r from public.content_reports where id=v_report_id for update;
 if not found or r.evidence_erased_at is not null or r.evidence_expires_at::timestamptz<=clock_timestamp() then
  raise exception 'Evidence work unavailable' using errcode='42501'; end if;
 select * into e from public.chat_media_report_evidence where id=p_evidence_id and report_id=r.id for update;
 if not found or p_work_token is null or e.work_token is distinct from p_work_token
  or (e.state='PENDING' and (e.work_expires_at is null or e.work_expires_at<=clock_timestamp())) then
  raise exception 'Evidence work unavailable' using errcode='42501'; end if;
 -- Reuse canonical completion's opaque-generation and trusted byte checks.
 -- The winning token remains for exact retries until canonical day-90 erasure.
 perform public.findback_commit_chat_media_report_evidence(
  p_evidence_id,p_generation,p_object_key,p_sha,p_mime,p_bytes,p_width,p_height);
end $$;
revoke all on function public.findback_finish_chat_media_evidence_job(text,text,text,text,text,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.findback_finish_chat_media_evidence_job(text,text,text,text,text,text,integer,integer,integer) to service_role;
commit;
