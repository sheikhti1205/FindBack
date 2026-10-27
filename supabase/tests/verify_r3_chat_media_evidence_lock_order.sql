-- Two independent sessions verify that reserve and commit both wait on the
-- parent report before taking source/evidence row locks. This prevents the
-- report -> evidence expiry path from deadlocking against either operation.
create extension if not exists dblink;
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9849-000000000001','media049_a','media049_a@example.invalid','+8801984900001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9849-000000000002','media049_b','media049_b@example.invalid','+8801984900002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media049-conv','00000000-0000-4000-9849-000000000001','00000000-0000-4000-9849-000000000002','CONNECTED','00000000-0000-4000-9849-000000000001','media049-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,receipt_connection_epoch) values
 ('media049-message','media049-conv','00000000-0000-4000-9849-000000000001','lock order',encode(sha256(convert_to('lock order','UTF8')),'hex'),'media049-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media049-message','00000000-0000-4000-9849-000000000001'),
 ('media049-message','00000000-0000-4000-9849-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9849-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9849-000000000001','media049-message','00000000-0000-4000-9849-000000000101');
reset role;
select set_config('test.media049.source_key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9849-000000000101'),false);
select set_config('test.media049.source_gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9849-000000000101'),false);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9849-000000000001','00000000-0000-4000-9849-000000000101',current_setting('test.media049.source_gen'),current_setting('test.media049.source_key'),repeat('e',64),'image/webp',500,1280,960);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9849-000000000002',true);
select set_config('test.media049.report_id',public.findback_submit_message_report(
 '00000000-0000-4000-9849-000000000002','media049-message','OTHER',null,'lock order'),false);
reset role;
set local role service_role;
select set_config('test.media049.reservation',(public.findback_reserve_chat_media_report_evidence(
 '00000000-0000-4000-9849-000000000002',current_setting('test.media049.report_id'),
 '00000000-0000-4000-9849-000000000101','00000000-0000-4000-9849-000000000201'))::text,false);
reset role;
select set_config('test.media049.evidence_key',current_setting('test.media049.reservation')::jsonb->>'objectKey',false);
select set_config('test.media049.evidence_gen',current_setting('test.media049.reservation')::jsonb->>'generation',false);
commit;

select dblink_connect('media049_blocker',format(
 'host=127.0.0.1 port=%s dbname=%s user=postgres password=disposable-local',current_setting('port'),current_database()));
select dblink_connect('media049_worker',format(
 'host=127.0.0.1 port=%s dbname=%s user=postgres password=disposable-local',current_setting('port'),current_database()));
select dblink_connect('media049_commit',format(
 'host=127.0.0.1 port=%s dbname=%s user=postgres password=disposable-local',current_setting('port'),current_database()));
create temp table media049_worker_pid(kind text primary key,pid integer);
insert into media049_worker_pid
 select 'reserve',pid from dblink('media049_worker','select pg_backend_pid()') as t(pid integer)
 union all
 select 'commit',pid from dblink('media049_commit','select pg_backend_pid()') as t(pid integer);

-- Case 1: concurrent reserve retry and commit must both wait on the report;
-- neither may hold source/evidence while the parent lock is unavailable.
select dblink_exec('media049_blocker','begin');
select id from dblink('media049_blocker',format(
 'select id from public.content_reports where id=%L for update',current_setting('test.media049.report_id'))) as t(id text);
select dblink_send_query('media049_worker',format(
 'select public.findback_reserve_chat_media_report_evidence(%L,%L,%L,%L)::text',
 '00000000-0000-4000-9849-000000000002',current_setting('test.media049.report_id'),
 '00000000-0000-4000-9849-000000000101','00000000-0000-4000-9849-000000000201'));
select dblink_send_query('media049_commit',format(
 'select public.findback_commit_chat_media_report_evidence(%L,%L,%L,%L,%L,%s,%s,%s)::text',
 '00000000-0000-4000-9849-000000000201',current_setting('test.media049.evidence_gen'),current_setting('test.media049.evidence_key'),
 repeat('e',64),'image/webp',500,1280,960));
do $$ declare i integer; begin
 for i in 1..100 loop
  exit when (select count(*) from pg_stat_activity a join media049_worker_pid p on p.pid=a.pid
   where a.wait_event_type='Lock')=2;
  perform pg_sleep(0.02);
 end loop;
 if (select count(*) from pg_stat_activity a join media049_worker_pid p on p.pid=a.pid
   where a.wait_event_type='Lock')<>2 then
  raise exception 'Reserve and commit did not both wait on the report lock';
 end if;
 begin
  perform 1 from public.chat_media_report_sources where report_id=current_setting('test.media049.report_id')
   and source_attachment_id='00000000-0000-4000-9849-000000000101' for update nowait;
  perform 1 from public.chat_media_report_evidence where id='00000000-0000-4000-9849-000000000201' for update nowait;
 exception when lock_not_available then
  raise exception 'Reserve locked source/evidence before report';
 end;
end $$;
select dblink_exec('media049_blocker','commit');
select result from dblink_get_result('media049_worker') as t(result text);
select count(*) as drained from dblink_get_result('media049_worker') as t(result text);
select result from dblink_get_result('media049_commit') as t(result text);
select count(*) as drained from dblink_get_result('media049_commit') as t(result text);

-- Case 2: exercise the canonical expiry path while an idempotent commit waits.
-- Rolling expiry back restores the evidence, allowing the waiting commit to
-- finish; the old evidence -> report order deadlocks inside the expiry trigger.
select dblink_exec('media049_blocker','begin');
select id from dblink('media049_blocker',format(
 'select id from public.content_reports where id=%L for update',current_setting('test.media049.report_id'))) as t(id text);
select dblink_send_query('media049_commit',format(
 'select public.findback_commit_chat_media_report_evidence(%L,%L,%L,%L,%L,%s,%s,%s)::text',
 '00000000-0000-4000-9849-000000000201',current_setting('test.media049.evidence_gen'),current_setting('test.media049.evidence_key'),
 repeat('e',64),'image/webp',500,1280,960));
do $$ declare i integer; begin
 for i in 1..100 loop
  exit when exists(select 1 from pg_stat_activity a join media049_worker_pid p on p.pid=a.pid
   where p.kind='commit' and a.wait_event_type='Lock');
  perform pg_sleep(0.02);
 end loop;
 if not exists(select 1 from pg_stat_activity a join media049_worker_pid p on p.pid=a.pid
   where p.kind='commit' and a.wait_event_type='Lock') then
  raise exception 'Commit worker did not wait on the report lock';
 end if;
 begin
  perform 1 from public.chat_media_report_evidence where id='00000000-0000-4000-9849-000000000201' for update nowait;
 exception when lock_not_available then
  raise exception 'Commit locked evidence before report';
 end;
end $$;
select result from dblink('media049_blocker',format(
 'select public.findback_expire_report_evidence(500,%L)::text',
 (select evidence_expires_at from public.content_reports where id=current_setting('test.media049.report_id'))
)) as t(result text);
select dblink_exec('media049_blocker','rollback');
select result from dblink_get_result('media049_commit') as t(result text);
select count(*) as drained from dblink_get_result('media049_commit') as t(result text);
select dblink_disconnect('media049_commit');
select dblink_disconnect('media049_worker');
select dblink_disconnect('media049_blocker');

do $$ begin
 if not exists(select 1 from public.chat_media_report_evidence
  where id='00000000-0000-4000-9849-000000000201' and state='ATTACHED') then
  raise exception 'Commit did not complete after rolled-back concurrent expiry';
 end if;
 if (select evidence_erased_at from public.content_reports where id=current_setting('test.media049.report_id')) is not null then
  raise exception 'Rolled-back concurrent expiry persisted';
 end if;
end $$;
select 'PASS reserve, commit, and expiry use report-first lock order' as result;
