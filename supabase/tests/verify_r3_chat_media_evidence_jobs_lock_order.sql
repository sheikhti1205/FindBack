-- Real concurrent claim/reserve/finish/expiry. All background queries have
-- observable lock barriers and bounded waits, not timing-based assumptions.
create extension if not exists dblink;
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9852-000000000001','media052_a','media052_a@example.invalid','+8801985200001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9852-000000000002','media052_b','media052_b@example.invalid','+8801985200002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media052-conv','00000000-0000-4000-9852-000000000001','00000000-0000-4000-9852-000000000002','CONNECTED','00000000-0000-4000-9852-000000000001','media052-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,receipt_connection_epoch) values
 ('media052-message','media052-conv','00000000-0000-4000-9852-000000000001','job locks',encode(sha256(convert_to('job locks','UTF8')),'hex'),'media052-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media052-message','00000000-0000-4000-9852-000000000001'),
 ('media052-message','00000000-0000-4000-9852-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9852-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9852-000000000001','media052-message','00000000-0000-4000-9852-000000000101');
reset role;
select public.findback_commit_chat_media('00000000-0000-4000-9852-000000000001',id,generation,object_key,repeat('b',64),'image/webp',500,1280,960)
 from public.chat_media_attachments where id='00000000-0000-4000-9852-000000000101';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9852-000000000002',true);
select set_config('test.media052.report_id',public.findback_submit_message_report(
 '00000000-0000-4000-9852-000000000002','media052-message','OTHER',null,'job locks'),false);
reset role;
commit;

select dblink_connect('media052_claim',format('host=127.0.0.1 port=%s dbname=%s user=postgres password=disposable-local',current_setting('port'),current_database()));
select dblink_connect('media052_other',format('host=127.0.0.1 port=%s dbname=%s user=postgres password=disposable-local',current_setting('port'),current_database()));
create temp table media052_pid as select pid from dblink('media052_other','select pg_backend_pid()') as t(pid integer);
select dblink_exec('media052_claim','begin');
select dblink_exec('media052_claim','set local statement_timeout=5000');
select dblink_exec('media052_claim','set local role service_role');
select set_config('test.media052.job',job,false) from dblink('media052_claim',
 'select public.findback_claim_chat_media_evidence_job()::text') as t(job text);
-- The winning row is still invisible, yet the parent fence excludes a second
-- worker immediately. It must neither block nor construct another destination.
do $$ declare job text; begin
 select t.job into job from dblink('media052_other','select public.findback_claim_chat_media_evidence_job()::text') as t(job text);
 if job is not null then raise exception 'Concurrent worker claimed locked report'; end if;
 if current_setting('test.media052.job')::jsonb->>'reportId' is distinct from current_setting('test.media052.report_id') then
  raise exception 'Claim fixture selected wrong report'; end if;
end $$;

-- A legacy reservation owns its evidence-ID advisory lock while waiting on
-- this report. Finishing the winning job must not try to acquire that ID lock.
select dblink_send_query('media052_other',format(
 'select public.findback_reserve_chat_media_report_evidence(%L,%L,%L,%L)::text',
 '00000000-0000-4000-9852-000000000002',current_setting('test.media052.report_id'),
 '00000000-0000-4000-9852-000000000101',current_setting('test.media052.job')::jsonb->>'id'));
do $$ declare i integer; begin
 for i in 1..100 loop
  exit when exists(select 1 from pg_stat_activity a join media052_pid p on p.pid=a.pid where a.wait_event_type='Lock');
  perform pg_sleep(0.02);
 end loop;
 if not exists(select 1 from pg_stat_activity a join media052_pid p on p.pid=a.pid where a.wait_event_type='Lock') then
  raise exception 'Legacy reserve did not wait on claimed report'; end if;
end $$;
select done from dblink('media052_claim',format(
 'select public.findback_finish_chat_media_evidence_job(%L,%L,%L,%L,%L,%L,500,1280,960)::text',
 current_setting('test.media052.job')::jsonb->>'id',current_setting('test.media052.job')::jsonb->>'generation',
 current_setting('test.media052.job')::jsonb->>'workToken',current_setting('test.media052.job')::jsonb->>'objectKey',repeat('b',64),'image/webp')) as t(done text);
select dblink_exec('media052_claim','commit');
select result from dblink_get_result('media052_other') as t(result text);
select count(*) as drained from dblink_get_result('media052_other') as t(result text);

-- Finish must also wait on report before evidence, matching canonical expiry.
select dblink_exec('media052_claim','begin');
select dblink_exec('media052_claim','set local statement_timeout=5000');
select id from dblink('media052_claim',format('select id from public.content_reports where id=%L for update',current_setting('test.media052.report_id'))) as t(id text);
select dblink_send_query('media052_other',format(
 'select public.findback_finish_chat_media_evidence_job(%L,%L,%L,%L,%L,%L,500,1280,960)::text',
 current_setting('test.media052.job')::jsonb->>'id',current_setting('test.media052.job')::jsonb->>'generation',
 current_setting('test.media052.job')::jsonb->>'workToken',current_setting('test.media052.job')::jsonb->>'objectKey',repeat('b',64),'image/webp'));
do $$ declare i integer; begin
 for i in 1..100 loop
  exit when exists(select 1 from pg_stat_activity a join media052_pid p on p.pid=a.pid where a.wait_event_type='Lock');
  perform pg_sleep(0.02);
 end loop;
 if not exists(select 1 from pg_stat_activity a join media052_pid p on p.pid=a.pid where a.wait_event_type='Lock') then
  raise exception 'Finish did not wait on report'; end if;
 begin
  perform 1 from public.chat_media_report_evidence where id=current_setting('test.media052.job')::jsonb->>'id' for update nowait;
 exception when lock_not_available then raise exception 'Finish locked evidence before report'; end;
end $$;
select result from dblink('media052_claim',format(
 'select public.findback_expire_report_evidence(500,%L)::text',
 (select evidence_expires_at from public.content_reports where id=current_setting('test.media052.report_id')))) as t(result text);
select dblink_exec('media052_claim','rollback');
select result from dblink_get_result('media052_other') as t(result text);
select count(*) as drained from dblink_get_result('media052_other') as t(result text);
select dblink_disconnect('media052_claim');
select dblink_disconnect('media052_other');
do $$ begin
 if (select count(*) from public.chat_media_report_evidence where report_id=current_setting('test.media052.report_id') and state='ATTACHED')<>1 then
  raise exception 'Concurrent operations forked or lost attached evidence'; end if;
end $$;
delete from public.content_reports where id=current_setting('test.media052.report_id');
do $$ declare job jsonb:=current_setting('test.media052.job')::jsonb; begin
 if exists(select 1 from public.chat_media_report_evidence where report_id=current_setting('test.media052.report_id'))
  or exists(select 1 from public.chat_media_report_sources where report_id=current_setting('test.media052.report_id')) then
  raise exception 'Report deletion retained work metadata'; end if;
 begin
  perform public.findback_finish_chat_media_evidence_job(job->>'id',job->>'generation',job->>'workToken',job->>'objectKey',
   job->>'sha256',job->>'mime',(job->>'bytes')::integer,(job->>'width')::integer,(job->>'height')::integer);
  raise exception 'Deleted report work completed';
 exception when insufficient_privilege then null; end;
end $$;
delete from public.chat_conversations where id='media052-conv';
delete from public.users where id in('00000000-0000-4000-9852-000000000001','00000000-0000-4000-9852-000000000002');
delete from public.chat_media_cleanup_queue where media_id in('00000000-0000-4000-9852-000000000101',current_setting('test.media052.job')::jsonb->>'id');
select 'PASS concurrent claim, legacy reserve, job finish and canonical expiry' as result;
