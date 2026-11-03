-- Synthetic disposable SQL contract: a report-linked or location message is
-- CONTENT. Content must not outlive its temporary mailboxes (or an Unsend), and
-- an accepted message's identity must stay replayable after the report it
-- references disappears. No hosted identity or credential.
begin;
-- Current-client admission; canonical immutable-payload checks are unchanged.
create function pg_temp.ready_send(p_account text,p_device text,p_action text,p_args jsonb)
returns jsonb language plpgsql as $$ begin
 return public.findback_chat_exchange(p_account,p_device,p_action,p_args||jsonb_build_object('expectedHead',
  public.findback_chat_exchange(p_account,p_device,'HEAD',jsonb_build_object('conversationId',p_args->>'conversationId'))));
end $$;
grant execute on function pg_temp.ready_send(text,text,text,jsonb) to authenticated;
insert into public.users(id,username,email,phone,created_at,updated_at) values
 ('00000000-0000-4000-9900-000000000001','era_author','era_a@example.invalid','+100009900001',now(),now()),
 ('00000000-0000-4000-9900-000000000002','era_peer','era_b@example.invalid','+100009900002',now(),now());
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,latitude,longitude,
 location_label,created_at,updated_at)
values('00000000-0000-4000-9900-000000000101','00000000-0000-4000-9900-000000000001','FOUND',
 'Green scarf','Found a green scarf','OTHER','OPEN','2026-10-30',null,null,null,
 '2026-10-30T00:00:00Z','2026-10-30T00:00:00Z');

create function pg_temp.era_view(p_device text) returns jsonb language sql as $$
 select value from jsonb_array_elements(public.findback_chat_exchange(auth.uid()::text,p_device,'VIEWS','{}')) value
 where value->>'conversationId'=current_setting('era.conversation')
$$;
grant execute on function pg_temp.era_view(text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000002',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9900-000000000021','REGISTER','{"platform":"android"}');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9900-000000000011','REGISTER','{"platform":"web"}');
select set_config('era.conversation',public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9900-000000000011',
 'CREATE','{"otherId":"00000000-0000-4000-9900-000000000002"}')#>>'{}',true);
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
 'messageId','00000000-0000-4000-9900-000000000201','body','Is this your scarf?','messageType','TEXT',
 'contextReportId','00000000-0000-4000-9900-000000000101',
 'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));

-- Connect, then share one explicit static location.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000002',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9900-000000000021','ACCEPT',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000021')->>'epoch'));
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
 'messageId','00000000-0000-4000-9900-000000000202','body','','messageType','LOCATION',
 'location',jsonb_build_object('lat',23.8103,'lng',90.4125,'accuracy',25),
 'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
reset role;

-- ---------------------------------------------------------------------------
-- 1. Unsend erases every content column, not only the caption. A LOCATION has
--    an empty caption, so erasing `body` alone retains the coordinates.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9900-000000000011','UNSEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'messageId','00000000-0000-4000-9900-000000000202'));
reset role;
do $$ declare m public.chat_messages%rowtype; begin
 select * into m from public.chat_messages where id='00000000-0000-4000-9900-000000000202';
 assert m.unsent_at is not null,'unsend is recorded';
 assert m.location_lat is null and m.location_lng is null and m.location_accuracy_m is null,
  'unsend erases the shared coordinates';
 assert m.body='','unsend erases the caption';
end $$;

-- ---------------------------------------------------------------------------
-- 2. Mailbox retention erases every content column. An expired mailbox must not
--    leave the coordinates behind once no mailbox still holds the message.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
 'messageId','00000000-0000-4000-9900-000000000203','body','','messageType','LOCATION',
 'location',jsonb_build_object('lat',23.82,'lng',90.42,'accuracy',null),
 'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
reset role;
update public.chat_mailbox set expires_at=clock_timestamp()-interval '1 minute'
 where message_id='00000000-0000-4000-9900-000000000203';
select public.findback_cleanup_chat_mailbox();
do $$ declare m public.chat_messages%rowtype; begin
 select * into m from public.chat_messages where id='00000000-0000-4000-9900-000000000203';
 assert m.location_lat is null and m.location_lng is null and m.location_accuracy_m is null,
  'retention erases the shared coordinates';
 assert not exists(select 1 from public.chat_mailbox where message_id=m.id),'mailbox is gone';
end $$;

-- ---------------------------------------------------------------------------
-- 3. Deleting a referenced report must not rewrite an accepted message. A lost
--    ACK then replays the SAME payload and must return the same id.
-- ---------------------------------------------------------------------------
delete from public.item_posts where id='00000000-0000-4000-9900-000000000101';
do $$ declare m public.chat_messages%rowtype; begin
 select * into m from public.chat_messages where id='00000000-0000-4000-9900-000000000201';
 assert m.context_report_id='00000000-0000-4000-9900-000000000101',
  'an accepted message keeps its opaque report reference after the report is deleted';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
do $$ declare v_id text; begin
 v_id:=pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
  'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
  'messageId','00000000-0000-4000-9900-000000000201','body','Is this your scarf?','messageType','TEXT',
  'contextReportId','00000000-0000-4000-9900-000000000101',
  'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'))#>>'{}';
 assert v_id='00000000-0000-4000-9900-000000000201','an identical retry after report deletion stays idempotent';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 4. A report that became unreadable must not poison an accepted retry, while
--    NEW work attaching that report is still refused.
-- ---------------------------------------------------------------------------
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,latitude,longitude,
 location_label,created_at,updated_at)
values('00000000-0000-4000-9900-000000000102','00000000-0000-4000-9900-000000000002','FOUND',
 'Later hidden','Moderated away','OTHER','OPEN','2026-10-30',null,null,null,
 '2026-10-30T00:00:00Z','2026-10-30T00:00:00Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
 'messageId','00000000-0000-4000-9900-000000000204','body','About the second report','messageType','TEXT',
 'contextReportId','00000000-0000-4000-9900-000000000102',
 'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
reset role;
update public.item_posts set moderation_visibility='HIDDEN' where id='00000000-0000-4000-9900-000000000102';
set local role authenticated;
do $$ declare v_id text; begin
 v_id:=pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
  'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
  'messageId','00000000-0000-4000-9900-000000000204','body','About the second report','messageType','TEXT',
  'contextReportId','00000000-0000-4000-9900-000000000102',
  'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'))#>>'{}';
 assert v_id='00000000-0000-4000-9900-000000000204','an accepted retry survives a later-hidden report';
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
   'messageId','00000000-0000-4000-9900-000000000205','body','New work on a hidden report','messageType','TEXT',
   'contextReportId','00000000-0000-4000-9900-000000000102',
   'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
  raise exception 'new work attached an unreadable report';
 exception when insufficient_privilege then null; end;
end $$;

-- 5. An exact retry after content erasure still resolves to the accepted id and
--    does not resurrect erased content.
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
 'messageId','00000000-0000-4000-9900-000000000202','body','','messageType','LOCATION',
 'location',jsonb_build_object('lat',23.8103,'lng',90.4125,'accuracy',25),
 'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
reset role;
do $$ declare m public.chat_messages%rowtype; begin
 select * into m from public.chat_messages where id='00000000-0000-4000-9900-000000000202';
 assert m.unsent_at is not null,'a retry cannot clear an unsend';
 assert m.location_lat is null,'a retry cannot resurrect erased coordinates';
end $$;
-- ---------------------------------------------------------------------------
-- 6. A DIFFERENT payload under an already-used id is a conflict, never a replay.
--    The legacy digest joined body and context with a bare delimiter, so a body
--    containing that delimiter could serialize like another payload. Identity is
--    now length-prefixed and must refuse the recast.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
 'messageId','00000000-0000-4000-9900-000000000206',
 'body','hello|ctx:00000000-0000-4000-9900-000000000102','messageType','TEXT',
 'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
do $$ begin
 perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
  'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
  'messageId','00000000-0000-4000-9900-000000000206','body','hello','messageType','TEXT',
  'contextReportId','00000000-0000-4000-9900-000000000102',
  'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
 raise exception 'a delimiter recast was accepted as a replay';
exception when invalid_parameter_value then null; end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 7. Coordinates are identity too, at full precision. Two fixes that differ
--    below the old six-decimal rounding must not share an accepted id.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
 'messageId','00000000-0000-4000-9900-000000000207','body','','messageType','LOCATION',
 'location',jsonb_build_object('lat',23.8103001,'lng',90.4125001,'accuracy',25.0001),
 'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
do $$ begin
 perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
  'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
  'messageId','00000000-0000-4000-9900-000000000207','body','','messageType','LOCATION',
  'location',jsonb_build_object('lat',23.8103002,'lng',90.4125001,'accuracy',25.0001),
  'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
 raise exception 'a sub-rounding latitude change was accepted as a replay';
exception when invalid_parameter_value then null; end $$;
do $$ begin
 perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
  'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
  'messageId','00000000-0000-4000-9900-000000000207','body','','messageType','LOCATION',
  'location',jsonb_build_object('lat',23.8103001,'lng',90.4125001,'accuracy',25.0002),
  'expectedEpoch',pg_temp.era_view('00000000-0000-4000-9900-000000000011')->>'epoch'));
 raise exception 'a sub-rounding accuracy change was accepted as a replay';
exception when invalid_parameter_value then null; end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 8. A report-linked message is still reportable. The digest now covers the
--    whole payload, so a body-hash check refused every context message; the
--    check binds to the delivered body instead. A mismatched body still fails.
-- ---------------------------------------------------------------------------
-- Exercise the SAME recasts after canonical erasure, not only while plaintext
-- columns remain. Require the identity-conflict error, not merely invalid shape.
update public.chat_mailbox set expires_at=clock_timestamp()-interval '1 minute'
 where message_id in('00000000-0000-4000-9900-000000000206','00000000-0000-4000-9900-000000000207');
select public.findback_cleanup_chat_mailbox();
create function pg_temp.era_expect_conflict(p_id text,p_body text,p_type text,p_extra jsonb)
 returns boolean language plpgsql as $$ declare message text; begin
 perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',
  jsonb_build_object('conversationId',current_setting('era.conversation'),
   'recipientId','00000000-0000-4000-9900-000000000002','messageId',p_id,'body',p_body,'messageType',p_type)||p_extra);
 raise exception 'changed payload acknowledged as accepted';
 exception when invalid_parameter_value then
  get stacked diagnostics message=message_text;
  assert message='Message identity conflict','recast must fail at exact identity, not admission';
  return true;
end $$;
grant execute on function pg_temp.era_expect_conflict(text,text,text,jsonb) to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000001',true);
select pg_temp.era_expect_conflict('00000000-0000-4000-9900-000000000206','hello','TEXT',
 '{"contextReportId":"00000000-0000-4000-9900-000000000102"}');
select pg_temp.era_expect_conflict('00000000-0000-4000-9900-000000000206','different body','TEXT','{}');
select pg_temp.era_expect_conflict('00000000-0000-4000-9900-000000000206',
 'hello|ctx:00000000-0000-4000-9900-000000000102','MEDIA','{}');
select pg_temp.era_expect_conflict('00000000-0000-4000-9900-000000000207','','LOCATION',
 '{"location":{"lat":23.8103002,"lng":90.4125001,"accuracy":25.0001}}');
select pg_temp.era_expect_conflict('00000000-0000-4000-9900-000000000207','','LOCATION',
 '{"location":{"lat":23.8103001,"lng":90.4125002,"accuracy":25.0001}}');
select pg_temp.era_expect_conflict('00000000-0000-4000-9900-000000000207','','LOCATION',
 '{"location":{"lat":23.8103001,"lng":90.4125001,"accuracy":25.0002}}');
select pg_temp.era_expect_conflict('00000000-0000-4000-9900-000000000207','','LOCATION',
 '{"location":{"lat":23.8103001,"lng":90.4125001,"accuracy":null}}');
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9900-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('era.conversation'),'recipientId','00000000-0000-4000-9900-000000000002',
 'messageId','00000000-0000-4000-9900-000000000207','body','','messageType','LOCATION',
 'location',jsonb_build_object('lat',23.8103001,'lng',90.4125001,'accuracy',25.0001)));
reset role;

-- Ordinary mailbox expiry must not prevent a recipient reporting content held
-- in durable local history. Only bounded report evidence is reintroduced.
update public.chat_mailbox set acked_at=clock_timestamp()
 where message_id='00000000-0000-4000-9900-000000000204';
select public.findback_cleanup_chat_mailbox();
do $$ begin
 assert (select body='' and context_report_id is null from public.chat_messages
  where id='00000000-0000-4000-9900-000000000204'),'all-ACK clears context and body';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9900-000000000002',true);
do $$ declare v_id text; begin
 v_id:=public.findback_submit_message_report(auth.uid()::text,
  '00000000-0000-4000-9900-000000000204','OTHER',null,'About the second report');
 assert v_id is not null,'a report-linked message can be reported';
 begin
  perform public.findback_submit_message_report(auth.uid()::text,
   '00000000-0000-4000-9900-000000000203','OTHER',null,'a body that was never delivered');
  raise exception 'a mismatched body was accepted as the report subject';
 exception when no_data_found then null; end;
end $$;
reset role;

select 'chat content erasure + immutable retry SQL assertions passed' as result;
rollback;
