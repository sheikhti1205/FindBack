-- M7-P bounded capabilities on the canonical R4 message owner:
--   * report-linked contact context (nullable, live-read, never a snapshot);
--   * connected-only one-time static location as a typed message.
-- Delivery, receipt authority, relationship epochs and media stay unchanged.
begin;
alter table public.chat_messages add column context_report_id text;
alter table public.chat_messages add column location_lat double precision;
alter table public.chat_messages add column location_lng double precision;
alter table public.chat_messages add column location_accuracy_m double precision;

-- Metadata-only additions first; the scans run in the second transaction where
-- VALIDATE takes only SHARE UPDATE EXCLUSIVE (see 20261028070000 rationale).
alter table public.chat_messages add constraint chat_messages_context_report_fkey
 foreign key (context_report_id) references public.item_posts(id) on delete set null not valid;
alter table public.chat_messages add constraint chat_messages_context_type_check
 check (context_report_id is null or message_type='TEXT') not valid;
alter table public.chat_messages add constraint chat_messages_location_check
 check ((location_lat is null and location_lng is null and location_accuracy_m is null)
   or (message_type='LOCATION' and location_lat is not null and location_lng is not null
    and location_lat between -90 and 90 and location_lng between -180 and 180
    and (location_accuracy_m is null or (location_accuracy_m>0 and location_accuracy_m<=100000)))) not valid;
alter table public.chat_messages drop constraint chat_messages_message_type_check;
alter table public.chat_messages add constraint chat_messages_message_type_check
 check (message_type in ('TEXT','MEDIA','LOCATION')) not valid;
commit;
begin;
alter table public.chat_messages validate constraint chat_messages_message_type_check;
alter table public.chat_messages validate constraint chat_messages_context_type_check;
alter table public.chat_messages validate constraint chat_messages_location_check;
alter table public.chat_messages validate constraint chat_messages_context_report_fkey;

-- ---------------------------------------------------------------------------
-- 1. Admission: one optional bounded context payload on the existing send path.
--
--    The payload is a typed column set, never raw JSON inside `body`. Replay
--    identity covers the whole payload, so a retry cannot be recast to another
--    report or another coordinate. Legacy TEXT/MEDIA sends keep the historical
--    sha256(body) digest, so queued retries stay idempotent.
-- ---------------------------------------------------------------------------
drop function public.findback_chat_send_internal(text,text,text,text,text);
create function public.findback_chat_send_internal(
  p_conversation_id text, p_body text, p_client_message_id text, p_message_type text,
  p_expected_epoch text, p_context jsonb default '{}'::jsonb
) returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype; m public.chat_messages%rowtype;
 v_digest text; v_first boolean; v_epoch text; v_blocked boolean; v_peer text;
 v_report text; v_lat double precision; v_lng double precision; v_accuracy double precision;
 v_key text:='';
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_message_type is null or p_message_type not in ('TEXT','MEDIA','LOCATION') then
  raise exception 'Invalid message type' using errcode='22023'; end if;
 if p_client_message_id is null
  or p_client_message_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
  raise exception 'Invalid message' using errcode='22023'; end if;
 p_body:=coalesce(p_body,'');
 if length(p_body)>100000 or (p_message_type='TEXT' and btrim(p_body)='') then
  raise exception 'Invalid message' using errcode='22023'; end if;
 if p_context is null or jsonb_typeof(p_context)<>'object' then
  raise exception 'Invalid message' using errcode='22023'; end if;
 v_report:=nullif(p_context->>'reportId','');
 if v_report is not null then
  if p_message_type<>'TEXT' then raise exception 'Invalid message' using errcode='22023'; end if;
  -- Live visibility, not a copied snapshot: an author who can no longer read the
  -- report cannot attach it, and every later reader resolves availability again.
  if not public.findback_can_read_post(v_report) then
   raise exception 'Report unavailable' using errcode='42501'; end if;
 end if;
 if p_message_type='LOCATION' then
  if jsonb_typeof(p_context->'location') is distinct from 'object' then
   raise exception 'Location required' using errcode='22023'; end if;
  v_lat:=(p_context->'location'->>'lat')::double precision;
  v_lng:=(p_context->'location'->>'lng')::double precision;
  v_accuracy:=(p_context->'location'->>'accuracy')::double precision;
   if v_lat is null or v_lng is null
   or v_lat not between -90 and 90 or v_lng not between -180 and 180
   or v_accuracy<=0 or v_accuracy>100000 then
   raise exception 'Location required' using errcode='22023'; end if;
  v_key:='|loc:'||to_char(v_lat,'FM999999990.000000')||','||to_char(v_lng,'FM999999990.000000')
    ||','||coalesce(to_char(v_accuracy,'FM999999990.000'),'unknown');
 elsif jsonb_typeof(p_context->'location') is not null then
  raise exception 'Invalid message' using errcode='22023'; end if;
 if v_report is not null then v_key:=v_key||'|ctx:'||v_report; end if;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 v_digest:=encode(sha256(convert_to(p_body||v_key,'UTF8')),'hex');
 select * into m from public.chat_messages where id=p_client_message_id;
 if found then
  -- Replay is state-independent: a lost response must stay retryable after the
  -- conversation moves on, but the identity (sender, conversation, body, type,
  -- report context and location) must match exactly.
  if m.sender_id=v_uid and m.conversation_id=c.id and m.payload_digest=v_digest
   and m.message_type=p_message_type and m.context_report_id is not distinct from v_report
   and m.location_lat is not distinct from v_lat and m.location_lng is not distinct from v_lng
   and m.location_accuracy_m is not distinct from v_accuracy then return m.id; end if;
  raise exception 'Message identity conflict' using errcode='22023';
 end if;
 -- New work must bind to the boundary the client actually observed. A retry of
 -- an already-accepted message returned above and stays idempotent.
 if p_expected_epoch is null
  or p_expected_epoch is distinct from public.findback_chat_relationship_epoch(c) then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state not in ('REQUEST','CONNECTED') then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 -- MEDIA and LOCATION are connection-only capabilities; neither is request-stage.
 if p_message_type in ('MEDIA','LOCATION') and c.state<>'CONNECTED' then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state='REQUEST' and c.initiated_by is not null and c.initiated_by<>v_uid then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 v_peer:=case when c.user_a=v_uid then c.user_b else c.user_a end;
 v_blocked:=public.findback_is_blocked_pair(c.user_a,c.user_b);
 v_first:=false;
 if c.state='REQUEST' then
  -- The request identity is created with the conversation and regenerated at
  -- every boundary, so a second queued text in the same request stays valid.
  v_epoch:=c.request_epoch;
  if v_epoch is null then
   v_epoch:=gen_random_uuid()::text;
   update public.chat_conversations set request_epoch=v_epoch where id=c.id;
  end if;
  v_first:=not v_blocked and not c.request_nudged;
  perform public.findback_chat_publish_member(c.id,v_uid,'REQUEST','OUTGOING',v_epoch);
  if not v_blocked then
   if exists(select 1 from public.chat_preferences where user_id=v_peer and open_messages) then
    -- Opt-in authorizes this actual contact only; it never bulk-accepts pairs.
    update public.chat_conversations set state='CONNECTED',initiated_by=v_uid,request_epoch=v_epoch,
     request_nudged=true,updated_at=clock_timestamp() where id=c.id;
    perform public.findback_chat_publish_member(c.id,v_uid,'CONNECTED','NONE',null);
    perform public.findback_chat_publish_member(c.id,v_peer,'CONNECTED','NONE',null);
   else
    update public.chat_conversations set initiated_by=v_uid,request_epoch=v_epoch,request_nudged=true
     where id=c.id;
    perform public.findback_chat_publish_member(c.id,v_peer,'REQUEST','INCOMING',v_epoch);
   end if;
  end if;
 end if;
 -- The message that triggers open-inbox auto-connect stays request-origin, so it
 -- never becomes receipt-eligible in the new connection.
 insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,first_approach,
  message_type,receipt_connection_epoch,context_report_id,location_lat,location_lng,location_accuracy_m)
 values(p_client_message_id,c.id,v_uid,p_body,v_digest,v_first,p_message_type,
  case when c.state='CONNECTED' then c.receipt_connection_epoch else null end,
  v_report,v_lat,v_lng,v_accuracy);
 -- A withheld (blocked) send still echoes to the author and never occupies the
 -- counterpart's request slot; media reservation refuses it separately.
 perform public.findback_enqueue_chat_mailbox(p_client_message_id);
 return p_client_message_id;
end $$;

-- Recreated functions start PUBLIC-executable; the canonical exchange is the
-- only caller, so close it exactly as the R4 sweep did.
revoke all on function public.findback_chat_send_internal(text,text,text,text,text,jsonb)
 from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- 2. The authorized mailbox carries the context id and bounded coordinates.
--    A location message has no caption, so an empty body must still deliver.
-- ---------------------------------------------------------------------------
create or replace function public.findback_fetch_chat_mailbox(p_device_id text)
returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 return query select jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'mailboxId',b.id,
  'event',jsonb_build_object('kind','TEXT','eventId',m.id,'sequence',m.event_sequence,'message',
   jsonb_build_object('id',m.id,'conversationId',c.id,'authorId',m.sender_id,
    'recipientId',case when c.user_a=m.sender_id then c.user_b else c.user_a end,
    'body',m.body,'messageType',m.message_type)
    || case when m.context_report_id is null then '{}'::jsonb
       else jsonb_build_object('contextReportId',m.context_report_id) end
    || case when m.message_type='LOCATION' then jsonb_build_object('location',
        jsonb_build_object('lat',m.location_lat,'lng',m.location_lng,'accuracy',m.location_accuracy_m))
       else '{}'::jsonb end))
 from public.chat_mailbox b join public.chat_devices d on d.id=b.device_id
 join public.chat_messages m on m.id=b.message_id join public.chat_conversations c on c.id=b.conversation_id
 where d.user_id=v_uid and d.device_id=p_device_id and b.acked_at is null and b.expires_at>clock_timestamp()
  and m.unsent_at is null and (m.body<>'' or m.message_type in ('MEDIA','LOCATION'))
  and (m.sender_id=v_uid or not public.findback_is_blocked_pair(c.user_a,c.user_b))
 order by m.event_sequence limit 100;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The one canonical exchange forwards the bounded payload. Every other
--    branch is unchanged from 20261029020000.
-- ---------------------------------------------------------------------------
create or replace function public.findback_chat_exchange(
  p_account_id text,p_device_id text,p_action text,p_args jsonb
) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_result jsonb; v_other text; v_after bigint; v_id text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 case p_action
 when 'REGISTER' then return to_jsonb(public.findback_register_chat_device(p_device_id,p_args->>'platform'));
 when 'VIEWS' then return public.findback_chat_views(p_args->>'afterId');
 when 'PRIVATE' then perform public.findback_chat_private_state(p_args->>'conversationId',p_args->>'operation');
 when 'CREATE' then return to_jsonb(public.findback_create_conversation(p_args->>'otherId'));
 when 'ACCEPT' then perform public.findback_accept_conversation(p_args->>'conversationId',p_args->>'expectedEpoch');
 when 'END' then perform public.findback_end_conversation(p_args->>'conversationId');
 when 'BLOCK' then perform public.findback_block_conversation(p_args->>'conversationId');
 when 'RECEIPTS' then perform public.findback_set_chat_receipts((p_args->>'enabled')::boolean);
 when 'PREFERENCES' then
  select jsonb_build_object(
   'readReceipts',coalesce((select enabled from public.chat_preferences where user_id=v_uid),false),
   'openMessages',coalesce((select open_messages from public.chat_preferences where user_id=v_uid),false)) into v_result;
  return v_result;
 when 'CONTACT_MODE' then
  if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then
   raise exception 'Preference required' using errcode='22023'; end if;
  insert into public.chat_preferences(user_id,open_messages) values(v_uid,(p_args->>'enabled')::boolean)
   on conflict(user_id) do update set open_messages=excluded.open_messages;
 when 'SEND' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  select case when user_a=v_uid then user_b else user_a end into v_other from public.chat_conversations
   where id=p_args->>'conversationId' and v_uid in(user_a,user_b) for update;
  if not found or (p_args->>'recipientId') is distinct from v_other then
   raise exception 'Conversation unavailable' using errcode='42501'; end if;
  return to_jsonb(public.findback_chat_send_internal(p_args->>'conversationId',p_args->>'body',
   p_args->>'messageId',coalesce(p_args->>'messageType','TEXT'),p_args->>'expectedEpoch',
   jsonb_strip_nulls(jsonb_build_object('reportId',p_args->>'contextReportId','location',p_args->'location'))));
 when 'SYNC' then
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_result from public.findback_fetch_chat_mailbox(p_device_id) e;
  return v_result;
 when 'ACK' then perform public.findback_ack_chat_message(p_args->>'mailboxId',p_device_id);
 when 'STATE_SYNC' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  v_after:=(p_args->>'afterSequence')::bigint;
  if v_after is null or v_after<0 or v_after>9007199254740991 then
   raise exception 'Invalid state cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(page.value order by page.seq),'[]'::jsonb) into v_result from (
   select e.event_sequence as seq,jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'change',
    jsonb_build_object('eventId',e.id,'sequence',e.event_sequence,'kind',e.kind,'conversationId',e.conversation_id,
     'occurredAt',floor(extract(epoch from e.occurred_at)*1000)::bigint) ||
    case when e.kind='CLEAR_FOR_ME' then jsonb_build_object('peerId',e.peer_id,'throughSequence',e.through_sequence)
     else jsonb_build_object('messageId',e.message_id,'authorId',e.author_id,'recipientId',e.recipient_id,
      'messageSequence',e.message_sequence) end) as value
   from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where a.user_id=v_uid and e.event_sequence>v_after order by e.event_sequence limit 100
  ) page;
  return v_result;
 when 'STATE_ACK' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  v_after:=(p_args->>'sequence')::bigint;
  if not exists(select 1 from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where e.id=p_args->>'eventId' and e.event_sequence=v_after and a.user_id=v_uid) then
   raise exception 'State unavailable' using errcode='42501'; end if;
  update public.chat_devices set state_ack_sequence=greatest(state_ack_sequence,v_after)
   where user_id=v_uid and device_id=p_device_id;
 when 'UNSEND','DELETE_FOR_ME','CLEAR_FOR_ME' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  v_id:=public.findback_chat_remove(p_action,p_args->>'conversationId',p_args->>'messageId',
   (p_args->>'throughSequence')::bigint);
  return to_jsonb(v_id);
 else raise exception 'Invalid chat operation' using errcode='22023';
 end case;
 return 'null'::jsonb;
end $$;

comment on column public.chat_messages.context_report_id is
 'Live-read report reference for report-linked contact. Only the id is stored; availability is resolved per reader, never snapshotted.';
comment on column public.chat_messages.location_lat is
 'One-time static location on a LOCATION message. No tracking, no request-stage share.';
commit;
