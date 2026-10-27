-- A real report transaction has captured media but has not committed. Cleanup
-- must not authorize API-first source deletion while that snapshot is invisible.
create extension if not exists dblink;
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9850-000000000001','media050_a','media050_a@example.invalid','+8801985000001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9850-000000000002','media050_b','media050_b@example.invalid','+8801985000002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media050-conv','00000000-0000-4000-9850-000000000001','00000000-0000-4000-9850-000000000002','CONNECTED','00000000-0000-4000-9850-000000000001','media050-epoch');
insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,receipt_connection_epoch) values
 ('media050-message','media050-conv','00000000-0000-4000-9850-000000000001','capture race',encode(sha256(convert_to('capture race','UTF8')),'hex'),'media050-epoch');
insert into public.chat_message_audience(message_id,user_id) values
 ('media050-message','00000000-0000-4000-9850-000000000001'),
 ('media050-message','00000000-0000-4000-9850-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9850-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9850-000000000001','media050-message','00000000-0000-4000-9850-000000000101');
reset role;
select public.findback_commit_chat_media('00000000-0000-4000-9850-000000000001',id,generation,object_key,repeat('f',64),'image/webp',500,1280,960)
 from public.chat_media_attachments where id='00000000-0000-4000-9850-000000000101';
commit;

select dblink_connect('media050_report',format(
 'host=127.0.0.1 port=%s dbname=%s user=postgres password=disposable-local',current_setting('port'),current_database()));
select dblink_exec('media050_report','begin');
select dblink_exec('media050_report','set local role authenticated');
select value from dblink('media050_report',
 $$select set_config('request.jwt.claim.sub','00000000-0000-4000-9850-000000000002',true)$$) as t(value text);
select set_config('test.media050.report_id',id,false) from dblink('media050_report',
 $$select public.findback_submit_message_report('00000000-0000-4000-9850-000000000002','media050-message','OTHER',null,'capture race')$$) as t(id text);
select dblink_exec('media050_report','reset role');
do $$ declare n bigint; begin
 select t.n into n from dblink('media050_report',format(
  'select count(*) from public.chat_media_report_sources where report_id=%L',current_setting('test.media050.report_id'))) as t(n bigint);
 if n<>1 then raise exception 'Fixture did not capture exactly one source'; end if;
end $$;
do $$ begin
 if exists(select 1 from public.chat_media_report_sources where report_id=current_setting('test.media050.report_id')) then
  raise exception 'Fixture report snapshot must still be invisible to cleanup';
 end if;
end $$;

-- Model ordinary TTL expiry after report capture, before its transaction ends.
update public.chat_media_attachments set expires_at=clock_timestamp()-interval '2 hours'
 where id='00000000-0000-4000-9850-000000000101';
do $$ begin
 if exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where media_id='00000000-0000-4000-9850-000000000101') then
  raise exception 'RED: cleanup authorized source deletion while report snapshot is uncommitted';
 end if;
end $$;
select public.findback_chat_media_cleanup_done('findback-chat-media',id,generation,object_key)
 from public.chat_media_attachments where id='00000000-0000-4000-9850-000000000101';
do $$ begin
 if not exists(select 1 from public.chat_media_attachments where id='00000000-0000-4000-9850-000000000101') then
  raise exception 'Cleanup acknowledgement erased a source while capture remained uncommitted';
 end if;
end $$;

select dblink_exec('media050_report','commit');
select dblink_disconnect('media050_report');
do $$ begin
 if not exists(select 1 from public.chat_media_report_sources where report_id=current_setting('test.media050.report_id')) then
  raise exception 'Canonical report did not preserve captured source';
 end if;
 if exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where media_id='00000000-0000-4000-9850-000000000101') then
  raise exception 'Committed uncopied snapshot did not protect source';
 end if;
end $$;

-- Reverse schedule: a report SELECT has seen a live source but must wait for
-- the shared fence. Expiry wins, cleanup is authorized, then capture must read
-- fresh metadata rather than insert the row saved before waiting.
update public.chat_media_attachments set expires_at=clock_timestamp()+interval '1 day'
 where id='00000000-0000-4000-9850-000000000101';
select dblink_connect('media050_late',format(
 'host=127.0.0.1 port=%s dbname=%s user=postgres password=disposable-local',current_setting('port'),current_database()));
select dblink_exec('media050_late','begin');
select dblink_exec('media050_late','set local role authenticated');
select value from dblink('media050_late',
 $$select set_config('request.jwt.claim.sub','00000000-0000-4000-9850-000000000001',true)$$) as t(value text);
create temp table media050_pid as select pid from dblink('media050_late','select pg_backend_pid()') as t(pid integer);
begin;
select pg_advisory_xact_lock(public.findback_chat_media_source_lock_key(id,generation,object_key))
 from public.chat_media_attachments where id='00000000-0000-4000-9850-000000000101';
select dblink_send_query('media050_late',
 $$select public.findback_submit_message_report('00000000-0000-4000-9850-000000000001','media050-message','OTHER',null,'capture race')$$);
do $$ declare i integer; begin
 for i in 1..100 loop
  exit when exists(select 1 from pg_stat_activity a join media050_pid p on p.pid=a.pid where a.wait_event_type='Lock');
  perform pg_sleep(0.02);
 end loop;
 if not exists(select 1 from pg_stat_activity a join media050_pid p on p.pid=a.pid where a.wait_event_type='Lock') then
  raise exception 'Capture did not wait on the shared source fence';
 end if;
end $$;
-- The earlier report remains an independent protection. Erase it canonically
-- before authorizing source deletion in this reverse-order case.
select public.findback_expire_report_evidence(500,evidence_expires_at)
 from public.content_reports where id=current_setting('test.media050.report_id');
update public.chat_media_attachments set expires_at=clock_timestamp()-interval '2 hours'
 where id='00000000-0000-4000-9850-000000000101';
do $$ begin
 if not exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where media_id='00000000-0000-4000-9850-000000000101') then
  raise exception 'Expiry-winning schedule did not authorize cleanup';
 end if;
end $$;
commit;
select set_config('test.media050.late_report_id',id,false) from dblink_get_result('media050_late') as t(id text);
select count(*) as drained from dblink_get_result('media050_late') as t(id text);
select dblink_exec('media050_late','commit');
select dblink_disconnect('media050_late');
do $$ begin
 if exists(select 1 from public.chat_media_report_sources where report_id=current_setting('test.media050.late_report_id')) then
  raise exception 'Late capture retained a stale pre-fence source after cleanup authorization';
 end if;
end $$;
-- Frozen transaction snapshots cannot satisfy the fresh post-fence read
-- contract. Fail closed rather than silently authorize from stale snapshots.
delete from public.content_reports where id=current_setting('test.media050.late_report_id');
begin isolation level repeatable read;
do $$ begin
 begin
  perform * from public.findback_chat_media_cleanup_candidates(100);
  raise exception 'RED: cleanup accepted a frozen transaction snapshot';
 exception when sqlstate '25001' then null; end;
 begin
  perform public.findback_chat_media_cleanup_done('findback-chat-media','missing','missing','missing');
  raise exception 'Cleanup acknowledgement accepted a frozen transaction snapshot';
 exception when sqlstate '25001' then null; end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9850-000000000001',true);
do $$ begin
 begin
  perform public.findback_submit_message_report('00000000-0000-4000-9850-000000000001','media050-message','OTHER',null,'capture race');
  raise exception 'Report capture accepted a frozen transaction snapshot';
 exception when sqlstate '25001' then null; end;
end $$;
rollback;
delete from public.content_reports where id in(current_setting('test.media050.report_id'),current_setting('test.media050.late_report_id'));
delete from public.chat_conversations where id='media050-conv';
delete from public.users where id in('00000000-0000-4000-9850-000000000001','00000000-0000-4000-9850-000000000002');
delete from public.chat_media_cleanup_queue where media_id='00000000-0000-4000-9850-000000000101';
select 'PASS in-flight report capture fences source cleanup' as result;
