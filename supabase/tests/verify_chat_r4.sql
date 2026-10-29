-- Integrated R4 acceptance. Synthetic accounts only; the whole file rolls back.
-- Uses the canonical exchange and global block API, never legacy helpers.
-- The runner fails at the end with every violated boundary, not the first one.
begin;
create temp table r4_checks(name text primary key, passed boolean not null) on commit drop;
create function pg_temp.r4_check(p_name text,p_passed boolean) returns void
language sql as $$ insert into r4_checks values(p_name,coalesce(p_passed,false)) $$;
grant all on r4_checks to authenticated;
create function pg_temp.r4_epoch(p_conversation text,p_device text) returns text
language sql as $$
 select e->>'epoch' from jsonb_array_elements(
  public.findback_chat_exchange(auth.uid()::text,p_device,'VIEWS','{}'::jsonb)) e
 where e->>'conversationId'=p_conversation
$$;
grant execute on function pg_temp.r4_epoch(text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Canonical schema and surface
-- ---------------------------------------------------------------------------
select pg_temp.r4_check('canonical modes exclude BLOCKED and ENDED',not exists(
 select 1 from pg_constraint where conrelid='public.chat_conversations'::regclass
 and contype='c' and pg_get_constraintdef(oid) ~ '(BLOCKED|ENDED)'));
select pg_temp.r4_check('exchange has no active historical compatibility chain',
 to_regprocedure('public.findback_chat_exchange_041(text,text,text,jsonb)') is null
 and to_regprocedure('public.findback_send_chat_message_044_internal(text,text,text)') is null
 and to_regprocedure('public.findback_send_chat_message(text,text,text)') is null
 and to_regprocedure('public.findback_send_chat_message(text,text,text,text)') is null);
select pg_temp.r4_check('no redundant server-side client outbox',to_regclass('public.chat_outbox') is null);
select pg_temp.r4_check('one member owner holds projection, private state and receipt progress',
 to_regclass('public.chat_member_state') is not null
 and to_regclass('public.chat_participant_views') is null
 and to_regclass('public.chat_read_progress') is null);
select pg_temp.r4_check('one preferences owner',to_regclass('public.chat_preferences') is not null
 and to_regclass('public.chat_receipt_preferences') is null);
select pg_temp.r4_check('personal suppression uses canonical state events, not a second ledger',
 to_regclass('public.chat_deleted_for_me') is null);
select pg_temp.r4_check('only documented chat RPCs are callable by ordinary accounts',not exists(
 select 1 from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like '%chat%'
 and has_function_privilege('authenticated',p.oid,'execute')
 and p.proname not in('findback_chat_exchange','findback_chat_receipt_view',
  'findback_chat_receipt_observe','findback_reserve_chat_media',
  'findback_fetch_chat_media_delivery','findback_ack_chat_media_delivery')));
select pg_temp.r4_check('private chat tables stay closed to clients',
 not has_table_privilege('authenticated','public.chat_conversations','select')
 and not has_table_privilege('authenticated','public.chat_messages','select')
 and not has_table_privilege('authenticated','public.chat_member_state','select')
 and not has_table_privilege('authenticated','public.chat_media_attachments','select'));

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9940-000000000001','r4_account_a','r4_a@example.invalid','+8801994000001',1,now(),now()),
 ('00000000-0000-4000-9940-000000000002','r4_account_b','r4_b@example.invalid','+8801994000002',1,now(),now()),
 ('00000000-0000-4000-9940-000000000003','r4_outsider','r4_c@example.invalid','+8801994000003',1,now(),now());

-- ---------------------------------------------------------------------------
-- Three installations, one unordered pair
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000001',true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
 '00000000-0000-4000-9940-000000000011','REGISTER','{"platform":"web"}');
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
 '00000000-0000-4000-9940-000000000012','REGISTER','{"platform":"android"}');
select set_config('r4.conversation',public.findback_chat_exchange(
 '00000000-0000-4000-9940-000000000001','00000000-0000-4000-9940-000000000011',
 'CREATE','{"otherId":"00000000-0000-4000-9940-000000000002"}')#>>'{}',true);
select set_config('r4.epoch',pg_temp.r4_epoch(current_setting('r4.conversation'),
 '00000000-0000-4000-9940-000000000011'),true);

do $$
declare denied boolean:=false;
begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
   '00000000-0000-4000-9940-000000000011','CREATE',
   '{"otherId":"00000000-0000-4000-9940-000000000001"}');
 exception when others then denied:=true;
 end;
 perform pg_temp.r4_check('self conversation rejected',denied);
end $$;

-- A stale boundary can never authorize a new send.
do $$
declare denied boolean:=false;
begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
   '00000000-0000-4000-9940-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000002',
   'messageId','00000000-0000-4000-9940-000000000109','body','stale','messageType','TEXT',
   'expectedEpoch',repeat('0',64)));
 exception when others then denied:=true;
 end;
 perform pg_temp.r4_check('stale relationship epoch cannot authorize a send',denied);
end $$;

select public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
 '00000000-0000-4000-9940-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000002',
 'messageId','00000000-0000-4000-9940-000000000101','body','First request text','messageType','TEXT',
 'expectedEpoch',current_setting('r4.epoch')));
select set_config('r4.epoch',pg_temp.r4_epoch(current_setting('r4.conversation'),
 '00000000-0000-4000-9940-000000000011'),true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
 '00000000-0000-4000-9940-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000002',
 'messageId','00000000-0000-4000-9940-000000000102','body','Another request text','messageType','TEXT',
 'expectedEpoch',current_setting('r4.epoch')));

-- Idempotent replay of an already-accepted identity survives a changed epoch.
select pg_temp.r4_check('identical retry stays idempotent across an epoch change',
 public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
  '00000000-0000-4000-9940-000000000011','SEND',jsonb_build_object(
  'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000002',
  'messageId','00000000-0000-4000-9940-000000000101','body','First request text','messageType','TEXT',
  'expectedEpoch',repeat('0',64)))#>>'{}'='00000000-0000-4000-9940-000000000101');

do $$
declare own_accept boolean:=false; media_denied boolean:=false;
begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
   '00000000-0000-4000-9940-000000000011','ACCEPT',jsonb_build_object(
   'conversationId',current_setting('r4.conversation'),'expectedEpoch',current_setting('r4.epoch')));
 exception when others then own_accept:=true;
 end;
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
   '00000000-0000-4000-9940-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000002',
   'messageId','00000000-0000-4000-9940-000000000103','body','','messageType','MEDIA',
   'expectedEpoch',current_setting('r4.epoch')));
 exception when others then media_denied:=true;
 end;
 perform pg_temp.r4_check('initiator cannot accept own request',own_accept);
 perform pg_temp.r4_check('REQUEST media denied',media_denied);
end $$;

-- ---------------------------------------------------------------------------
-- Recipient side
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000002',true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000002',
 '00000000-0000-4000-9940-000000000021','REGISTER','{"platform":"web"}');
select pg_temp.r4_check('unordered pair has one conversation',public.findback_chat_exchange(
 '00000000-0000-4000-9940-000000000002','00000000-0000-4000-9940-000000000021',
 'CREATE','{"otherId":"00000000-0000-4000-9940-000000000001"}')#>>'{}'=current_setting('r4.conversation'));
select set_config('r4.epoch',pg_temp.r4_epoch(current_setting('r4.conversation'),
 '00000000-0000-4000-9940-000000000021'),true);
do $$
declare stale_accept boolean:=false;
begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9940-000000000002',
   '00000000-0000-4000-9940-000000000021','ACCEPT',jsonb_build_object(
   'conversationId',current_setting('r4.conversation'),'expectedEpoch',repeat('1',64)));
 exception when others then stale_accept:=true;
 end;
 perform pg_temp.r4_check('stale ACCEPT cannot accept a newer request epoch',stale_accept);
end $$;
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000002',
 '00000000-0000-4000-9940-000000000021','ACCEPT',jsonb_build_object(
 'conversationId',current_setting('r4.conversation'),'expectedEpoch',current_setting('r4.epoch')));
reset role;

select pg_temp.r4_check('recipient acceptance connects pair',
 (select state='CONNECTED' from public.chat_conversations where id=current_setting('r4.conversation')));
select pg_temp.r4_check('multiple request messages retain stable identity',
 (select count(*)=2 from public.chat_messages where conversation_id=current_setting('r4.conversation')
  and message_type='TEXT'));

-- ---------------------------------------------------------------------------
-- End returns to REQUEST with history; the pre-end boundary cannot send
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000002',true);
select set_config('r4.epoch_before_end',current_setting('r4.epoch'),true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000002',
 '00000000-0000-4000-9940-000000000021','END',jsonb_build_object(
 'conversationId',current_setting('r4.conversation')));
reset role;
select pg_temp.r4_check('end returns the pair to REQUEST and keeps history',
 (select state='REQUEST' from public.chat_conversations where id=current_setting('r4.conversation'))
 and (select count(*)=2 from public.chat_messages where conversation_id=current_setting('r4.conversation')));

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000001',true);
do $$
declare denied boolean:=false;
begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
   '00000000-0000-4000-9940-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000002',
   'messageId','00000000-0000-4000-9940-000000000104','body','stale after end','messageType','TEXT',
   'expectedEpoch',current_setting('r4.epoch_before_end')));
 exception when others then denied:=true;
 end;
 perform pg_temp.r4_check('pre-end boundary cannot authorize a new request send',denied);
end $$;
select set_config('r4.epoch',pg_temp.r4_epoch(current_setting('r4.conversation'),
 '00000000-0000-4000-9940-000000000011'),true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
 '00000000-0000-4000-9940-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000002',
 'messageId','00000000-0000-4000-9940-000000000104','body','fresh request after end','messageType','TEXT',
 'expectedEpoch',current_setting('r4.epoch')));
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000002',true);
select set_config('r4.epoch',pg_temp.r4_epoch(current_setting('r4.conversation'),
 '00000000-0000-4000-9940-000000000021'),true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000002',
 '00000000-0000-4000-9940-000000000021','ACCEPT',jsonb_build_object(
 'conversationId',current_setting('r4.conversation'),'expectedEpoch',current_setting('r4.epoch')));
reset role;
select pg_temp.r4_check('a fresh request reconnects only on explicit acceptance',
 (select state='CONNECTED' from public.chat_conversations where id=current_setting('r4.conversation')));

-- ---------------------------------------------------------------------------
-- Connected media, moderation evidence and per-account erasure
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000001',true);
select set_config('r4.epoch',pg_temp.r4_epoch(current_setting('r4.conversation'),
 '00000000-0000-4000-9940-000000000011'),true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
 '00000000-0000-4000-9940-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000002',
 'messageId','00000000-0000-4000-9940-000000000105','body','','messageType','MEDIA',
 'expectedEpoch',current_setting('r4.epoch')));
reset role;
select pg_temp.r4_check('connected media send is admitted as MEDIA with both participants in the audience',
 (select message_type='MEDIA' from public.chat_messages where id='00000000-0000-4000-9940-000000000105')
 and (select count(*)=2 from public.chat_message_audience where message_id='00000000-0000-4000-9940-000000000105'));

-- Storage itself is owned by the media service; this row is the authorization
-- record every byte read is checked against.
insert into public.chat_media_attachments(id,message_id,author_id,conversation_id,connection_epoch,block_epoch,
 object_key,state,sha256,mime,byte_size,width,height,expires_at)
select '00000000-0000-4000-9940-000000000201','00000000-0000-4000-9940-000000000105',
 '00000000-0000-4000-9940-000000000001',c.id,c.receipt_connection_epoch,c.receipt_block_epoch,
 'chat-media/r4-probe/00000000-0000-4000-9940-000000000201','ATTACHED',repeat('a',64),'image/jpeg',1024,64,64,
 clock_timestamp()+interval '1 hour'
 from public.chat_conversations c where c.id=current_setting('r4.conversation');

select pg_temp.r4_check('media reads are authorized for both participants only',
 public.findback_chat_media_visible_internal('00000000-0000-4000-9940-000000000001','00000000-0000-4000-9940-000000000201')
 and public.findback_chat_media_visible_internal('00000000-0000-4000-9940-000000000002','00000000-0000-4000-9940-000000000201')
 and not public.findback_chat_media_visible_internal('00000000-0000-4000-9940-000000000003','00000000-0000-4000-9940-000000000201'));

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000003',true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000003',
 '00000000-0000-4000-9940-000000000031','REGISTER','{"platform":"web"}');
do $$
declare denied boolean:=false;
begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9940-000000000003',
   '00000000-0000-4000-9940-000000000031','SEND',jsonb_build_object(
   'conversationId',current_setting('r4.conversation'),'recipientId','00000000-0000-4000-9940-000000000001',
   'messageId','00000000-0000-4000-9940-000000000110','body','outsider','messageType','TEXT',
   'expectedEpoch',repeat('2',64)));
  exception when others then denied:=true;
 end;
 perform pg_temp.r4_check('a registered outsider cannot send into the conversation',denied);
end $$;
reset role;

-- Only the author may unsend; a recipient erase is per-account.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000002',true);
do $$
declare denied boolean:=false;
begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9940-000000000002',
   '00000000-0000-4000-9940-000000000021','UNSEND',jsonb_build_object(
   'conversationId',current_setting('r4.conversation'),'messageId','00000000-0000-4000-9940-000000000105'));
  exception when others then denied:=true;
 end;
 perform pg_temp.r4_check('a non-author cannot unsend the message',denied);
end $$;
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000002',
 '00000000-0000-4000-9940-000000000021','DELETE_FOR_ME',jsonb_build_object(
 'conversationId',current_setting('r4.conversation'),'messageId','00000000-0000-4000-9940-000000000105'));
reset role;
select pg_temp.r4_check('delete-for-me hides the media only for the acting account',
 not public.findback_chat_media_visible_internal('00000000-0000-4000-9940-000000000002','00000000-0000-4000-9940-000000000201')
 and public.findback_chat_media_visible_internal('00000000-0000-4000-9940-000000000001','00000000-0000-4000-9940-000000000201')
 and (select count(*)=1 from public.chat_state_events
  where kind='DELETE_FOR_ME' and message_id='00000000-0000-4000-9940-000000000105'));

-- Moderation evidence is captured independently of the attachment row and is
-- erased only by the explicit erasure instant.
insert into public.content_reports(id,reporter_user_id,target_type,target_id,target_message_id,reason,
 evidence_snapshot,evidence_captured_at,evidence_expires_at,created_at,updated_at)
values('00000000-0000-4000-9940-000000000301','00000000-0000-4000-9940-000000000002','MESSAGE',
 '00000000-0000-4000-9940-000000000105','00000000-0000-4000-9940-000000000105','HARASSMENT',
 '{}'::jsonb,now()::text,(now()+interval '30 days')::text,now()::text,now()::text);
select pg_temp.r4_check('reporting a media message captures one evidence source',
 (select count(*)=1 from public.chat_media_report_sources
  where report_id='00000000-0000-4000-9940-000000000301'));

-- The author clears their own view up to the boundary it actually observed. The
-- sequence is captured outside the client role: chat tables stay unreadable, so
-- a real client can only ever send the watermark from its own local history.
select set_config('r4.clear_through',(select max(event_sequence)::text from public.chat_messages
 where conversation_id=current_setting('r4.conversation')),true);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000001',true);
select public.findback_chat_exchange('00000000-0000-4000-9940-000000000001',
 '00000000-0000-4000-9940-000000000011','CLEAR_FOR_ME',jsonb_build_object(
 'conversationId',current_setting('r4.conversation'),
 'throughSequence',current_setting('r4.clear_through')::bigint));
reset role;
select pg_temp.r4_check('clear-for-me erases only the acting account view',
 not public.findback_chat_media_visible_internal('00000000-0000-4000-9940-000000000001','00000000-0000-4000-9940-000000000201')
 and (select count(*)=1 from public.chat_state_events
  where kind='CLEAR_FOR_ME' and actor_id='00000000-0000-4000-9940-000000000001'));

update public.content_reports set evidence_erased_at=now()::text
 where id='00000000-0000-4000-9940-000000000301';
select pg_temp.r4_check('explicit evidence erasure removes the copy and its sources',
 (select count(*)=0 from public.chat_media_report_evidence
  where report_id='00000000-0000-4000-9940-000000000301')
 and (select count(*)=0 from public.chat_media_report_sources
  where report_id='00000000-0000-4000-9940-000000000301'));

-- ---------------------------------------------------------------------------
-- Block is separate from mode and never reconnects on unblock
-- ---------------------------------------------------------------------------
set local role authenticated;
-- Pin the actor: the preceding sections deliberately leave different identities
-- in place, and a block must never be proven with an ambiguous caller.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000002',true);
select public.findback_block_user('00000000-0000-4000-9940-000000000001');
reset role;
select pg_temp.r4_check('block ends the connection without a third mode',
 (select state='REQUEST' from public.chat_conversations where id=current_setting('r4.conversation')));
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9940-000000000002',true);
select public.findback_unblock_user('00000000-0000-4000-9940-000000000001');
reset role;
select pg_temp.r4_check('global unblock does not silently restore CONNECTED',
 (select state='REQUEST' from public.chat_conversations where id=current_setting('r4.conversation')));

do $$
declare failures text;
begin
 select string_agg(name,E'\n' order by name) into failures from r4_checks where not passed;
 if failures is not null then raise exception E'R4 acceptance violations:\n%',failures; end if;
end $$;
select 'PASS R4 relationship, epoch, three-installation and backend surface contract' as result;
rollback;
