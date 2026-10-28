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
 -- A verified removal becomes a bounded tombstone, not an immediate row delete:
 -- an upload admitted before metadata deletion can still land afterwards.
 if not exists(select 1 from public.chat_media_cleanup_queue where object_key=current_setting('test.media042.deleted_key')
  and removed_at is not null and next_check_at is not null and purge_after is not null
  and next_check_at>=removed_at and purge_after>=next_check_at) then
  raise exception 'Cleanup acknowledgement did not retain a tombstone'; end if;
 if exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Fresh tombstone was immediately re-swept'; end if;
end $$;
set local role service_role;
do $$ begin
 perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9842-000000000101',current_setting('test.media042.deleted_gen'),current_setting('test.media042.deleted_key'));
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.chat_media_cleanup_queue where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Repeated acknowledgement dropped the tombstone'; end if;
end $$;
-- A late write detected after acknowledgement must become due immediately.
set local role service_role;
select set_config('test.media042.recheck',public.findback_chat_media_cleanup_recheck('findback-chat-media','00000000-0000-4000-9842-000000000101',current_setting('test.media042.deleted_gen'),current_setting('test.media042.deleted_key'))::text,true);
do $$ begin
 if current_setting('test.media042.recheck')<>'true' then raise exception 'Late-write re-check lost the tombstone'; end if;
 if not exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Late-write re-check did not authorize a new sweep'; end if;
end $$;
reset role;
update public.chat_media_cleanup_queue set removed_at=clock_timestamp()-interval '8 days',
 next_check_at=clock_timestamp()-interval '7 days',purge_after=clock_timestamp()-interval '1 second'
 where object_key=current_setting('test.media042.deleted_key');
set local role service_role;
do $$ begin
 if not exists(select 1 from public.findback_chat_media_cleanup_candidates(100)
  where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Expired tombstone omitted from purge candidates'; end if;
 perform public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9842-000000000101',current_setting('test.media042.deleted_gen'),current_setting('test.media042.deleted_key'));
end $$;
reset role;
do $$ begin
 if exists(select 1 from public.chat_media_cleanup_queue where object_key=current_setting('test.media042.deleted_key')) then
  raise exception 'Expired tombstone survived purge'; end if;
end $$;
-- A declined acknowledgement must be reported as false, never as success: a
-- tombstone that is not yet due changes nothing.
insert into public.chat_media_cleanup_queue(bucket_id,media_id,generation,object_key,not_before,removed_at,next_check_at,purge_after)
values('findback-chat-media','00000000-0000-4000-9842-000000000103','00000000-0000-4000-9842-000000000203',
 'attachments/00000000-0000-4000-9842-000000000103',clock_timestamp()-interval '1 second',
 clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '6 days');
set local role service_role;
do $$ begin
 if public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9842-000000000103',
  '00000000-0000-4000-9842-000000000203','attachments/00000000-0000-4000-9842-000000000103') is not false then
  raise exception 'Declined acknowledgement was reported as success'; end if;
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.chat_media_cleanup_queue
  where object_key='attachments/00000000-0000-4000-9842-000000000103'
   and next_check_at>clock_timestamp()+interval '30 minutes') then
  raise exception 'Declined acknowledgement still moved the tombstone'; end if;
end $$;

-- Day 6 of the window: the next check must be clamped to the purge instant.
-- A plain "+1 day" here violates the shape constraint (23514) and would fail
-- every acknowledgement for the last day of each tombstone.
update public.chat_media_cleanup_queue set removed_at=clock_timestamp()-interval '6 days',
 next_check_at=clock_timestamp()-interval '1 second',purge_after=clock_timestamp()+interval '23 hours'
 where object_key='attachments/00000000-0000-4000-9842-000000000103';
set local role service_role;
do $$ begin
 if public.findback_chat_media_cleanup_done('findback-chat-media','00000000-0000-4000-9842-000000000103',
  '00000000-0000-4000-9842-000000000203','attachments/00000000-0000-4000-9842-000000000103') is not true then
  raise exception 'Day-6 re-check was not acknowledged'; end if;
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.chat_media_cleanup_queue
  where object_key='attachments/00000000-0000-4000-9842-000000000103'
   and next_check_at=purge_after and purge_after>clock_timestamp()) then
  raise exception 'Day-6 re-check was not clamped to the purge instant'; end if;
end $$;

-- The candidate cursor must let a sweep page past a row that can never be
-- removed. Without it a permanently undeletable row is re-claimed in every
-- batch and starves everything ordered after it.
-- Inserted in reverse key order on purpose: if the candidates query ever lost its
-- ORDER BY, heap order would return ...106 first and the assertions below fail.
insert into public.chat_media_cleanup_queue(bucket_id,media_id,generation,object_key,not_before)
values('findback-chat-media','00000000-0000-4000-9842-000000000106','00000000-0000-4000-9842-000000000206',
 'attachments/00000000-0000-4000-9842-000000000106',clock_timestamp()-interval '1 second'),
('findback-chat-media','00000000-0000-4000-9842-000000000105','00000000-0000-4000-9842-000000000205',
 'attachments/00000000-0000-4000-9842-000000000105',clock_timestamp()-interval '1 second');
-- Precondition, read as the table owner: nothing else that is due may sort
-- before the fixture key, so the ordering assertion cannot pass vacuously.
do $$ begin
 if exists(select 1 from public.chat_media_cleanup_queue q
  where q.not_before<=clock_timestamp()
   and (q.removed_at is null or q.next_check_at<=clock_timestamp() or q.purge_after<=clock_timestamp())
   and (q.bucket_id,q.object_key)<('findback-chat-media','attachments/00000000-0000-4000-9842-000000000105')) then
  raise exception 'Probe precondition failed: a due row sorts before the paging fixture'; end if;
end $$;
set local role service_role;
do $$ begin
 if not exists(select 1 from public.findback_chat_media_cleanup_candidates(1)
  where object_key='attachments/00000000-0000-4000-9842-000000000105') then
  raise exception 'Cleanup candidates are not ordered for keyset paging'; end if;
 if exists(select 1 from public.findback_chat_media_cleanup_candidates(1)
  where object_key='attachments/00000000-0000-4000-9842-000000000106') then
  raise exception 'Cleanup candidate paging returned a row past the limit'; end if;
 if exists(select 1 from public.findback_chat_media_cleanup_candidates(5,'findback-chat-media',
  'attachments/00000000-0000-4000-9842-000000000105')
  where object_key='attachments/00000000-0000-4000-9842-000000000105') then
  raise exception 'Cleanup cursor re-returned the row it had already passed'; end if;
 if not exists(select 1 from public.findback_chat_media_cleanup_candidates(5,'findback-chat-media',
  'attachments/00000000-0000-4000-9842-000000000105')
  where object_key='attachments/00000000-0000-4000-9842-000000000106') then
  raise exception 'Cleanup cursor skipped the row after the undeletable one'; end if;
 begin
  perform 1 from public.findback_chat_media_cleanup_candidates(5,'findback-chat-media',null);
  raise exception 'Incomplete cleanup cursor was accepted';
 exception when invalid_parameter_value then null; end;
end $$;
reset role;

select 'PASS cascade cleanup provenance, grace, tombstone, late-write recheck, declined ack, day-6 clamp and cursor paging' as result;
rollback;
