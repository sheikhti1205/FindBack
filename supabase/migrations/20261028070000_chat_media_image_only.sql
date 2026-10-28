-- Image-only sends reuse the existing delivery and receipt machinery.
begin;
-- chat_messages is never pruned, so a validating ADD CONSTRAINT would scan the
-- whole table while holding ACCESS EXCLUSIVE, blocking every chat read and write
-- for longer as the table grows. The swap is therefore split across two
-- transactions: the drop and the NOT VALID add are metadata-only, and the scan
-- runs in a separate transaction where VALIDATE takes only SHARE UPDATE
-- EXCLUSIVE. Keeping the VALIDATE in this transaction would defeat that, because
-- PostgreSQL holds every lock taken in a transaction until it commits.
alter table public.chat_messages drop constraint chat_messages_message_type_check;
alter table public.chat_messages add constraint chat_messages_message_type_check
 check (message_type in ('TEXT','MEDIA')) not valid;
commit;
begin;
alter table public.chat_messages validate constraint chat_messages_message_type_check;

-- Replace the three-argument wrapper: the default preserves three-argument calls
-- without PostgreSQL's ambiguity between overlapping defaulted overloads.
drop function public.findback_send_chat_message(text,text,text);
-- A media row may initially have no attachment: reservation/commit follow it.
create function public.findback_send_chat_message(p_conversation_id text,p_body text,p_client_message_id text,p_message_type text default 'TEXT')
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype; m public.chat_messages%rowtype; v_digest text;
 existed boolean; v_id text; v_type text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_message_type is null or p_message_type not in ('TEXT','MEDIA') then
  raise exception 'Invalid message type' using errcode='22023'; end if;
 if p_message_type='TEXT' then
  select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
  if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
  select message_type into v_type from public.chat_messages where id=p_client_message_id;
  existed:=found;
  -- The type is part of the message identity in both directions: a MEDIA id must
  -- not be acknowledged as a TEXT send. The legacy path below only compares the
  -- digest, so the check has to happen here.
  if existed and v_type is distinct from 'TEXT' then
   raise exception 'Message identity conflict' using errcode='22023';
  end if;
  v_id:=public.findback_send_chat_message_044_internal(p_conversation_id,p_body,p_client_message_id);
  if not existed and c.state='CONNECTED' and c.receipt_connection_epoch is not null then
   update public.chat_messages set receipt_connection_epoch=c.receipt_connection_epoch where id=v_id;
  end if;
  return v_id;
 end if;
 -- An image-only client may omit the body instead of sending an empty string;
 -- null and '' are the same message, so a retry of either matches the stored row.
 p_body:=coalesce(p_body,'');
 if length(p_body)>100000 or p_client_message_id is null
  or p_client_message_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
  raise exception 'Invalid message' using errcode='22023'; end if;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 v_digest:=encode(sha256(convert_to(p_body,'UTF8')),'hex');
 select * into m from public.chat_messages where id=p_client_message_id;
 if found then
  -- Replay is state-independent, matching the TEXT path: a client that lost the
  -- response must still be able to retry after the conversation moves on. The
  -- type must match too, or a TEXT id could be acknowledged as a MEDIA send.
  if m.sender_id=v_uid and m.conversation_id=c.id and m.payload_digest=v_digest
   and m.message_type='MEDIA' then return m.id; end if;
  raise exception 'Message identity conflict' using errcode='22023';
 end if;
 -- 42501 matches the existing unavailable-conversation authorization boundary.
 -- This gate is for new sends only; a replay above has already returned.
 if c.state<>'CONNECTED' then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,first_approach,message_type,receipt_connection_epoch)
 values(p_client_message_id,c.id,v_uid,p_body,v_digest,false,'MEDIA',c.receipt_connection_epoch);
 perform public.findback_enqueue_chat_mailbox(p_client_message_id);
 return p_client_message_id;
end $$;
revoke all on function public.findback_send_chat_message(text,text,text,text) from public,anon,authenticated;

-- Preserve the outer erasure exchange; update only its delegated SEND dispatch.
create or replace function public.findback_chat_exchange_041(p_account_id text,p_device_id text,p_action text,p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_result jsonb; v_other text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 case p_action
 when 'REGISTER' then return to_jsonb(public.findback_register_chat_device(p_device_id,p_args->>'platform'));
 when 'VIEWS' then return public.findback_chat_views(p_args->>'afterId');
 when 'PRIVATE' then perform public.findback_chat_private_state(p_args->>'conversationId',p_args->>'operation');
 when 'CREATE' then return to_jsonb(public.findback_create_conversation(p_args->>'otherId'));
 when 'ACCEPT' then perform public.findback_accept_conversation(p_args->>'conversationId');
 when 'END' then perform public.findback_end_conversation(p_args->>'conversationId');
 when 'BLOCK' then perform public.findback_block_conversation(p_args->>'conversationId');
 when 'RECEIPTS' then perform public.findback_set_chat_receipts((p_args->>'enabled')::boolean);
 when 'PREFERENCES' then
  select jsonb_build_object(
   'readReceipts',coalesce((select enabled from public.chat_receipt_preferences where user_id=v_uid),false),
   'openMessages',coalesce((select open_messages from public.chat_receipt_preferences where user_id=v_uid),false)) into v_result;
  return v_result;
 when 'CONTACT_MODE' then
  if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then
   raise exception 'Preference required' using errcode='22023';
  end if;
  insert into public.chat_receipt_preferences(user_id,open_messages) values(v_uid,(p_args->>'enabled')::boolean)
   on conflict(user_id) do update set open_messages=excluded.open_messages;
 when 'READ' then perform public.findback_mark_chat_read(p_args->>'messageId');
 when 'SEND' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501';
  end if;
  select case when user_a=v_uid then user_b else user_a end into v_other from public.chat_conversations
   where id=p_args->>'conversationId' and v_uid in(user_a,user_b) for update;
  if not found or (p_args->>'recipientId') is distinct from v_other then
   raise exception 'Conversation unavailable' using errcode='42501';
  end if;
  return to_jsonb(public.findback_send_chat_message(p_args->>'conversationId',p_args->>'body',p_args->>'messageId',coalesce(p_args->>'messageType','TEXT')));
 when 'SYNC' then
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_result from public.findback_fetch_chat_mailbox(p_device_id) e;
  return v_result;
 when 'ACK' then perform public.findback_ack_chat_message(p_args->>'mailboxId',p_device_id);
 else raise exception 'Invalid chat operation' using errcode='22023';
 end case;
 return 'null'::jsonb;
end $$;
-- Preserve the consumed TEXT envelope; attachment delivery correlates by message id.
-- Cleanup already skips empty bodies, so image-only rows need no cleanup change.
create or replace function public.findback_fetch_chat_mailbox(p_device_id text)
returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 return query select jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'mailboxId',b.id,
  'event',jsonb_build_object('kind','TEXT','eventId',m.id,'sequence',m.event_sequence,'message',
   jsonb_build_object('id',m.id,'conversationId',c.id,'authorId',m.sender_id,
    'recipientId',case when c.user_a=m.sender_id then c.user_b else c.user_a end,'body',m.body)))
 from public.chat_mailbox b join public.chat_devices d on d.id=b.device_id
 join public.chat_messages m on m.id=b.message_id join public.chat_conversations c on c.id=b.conversation_id
 where d.user_id=v_uid and d.device_id=p_device_id and b.acked_at is null and b.expires_at>clock_timestamp()
  and m.unsent_at is null and (m.body<>'' or m.message_type='MEDIA')
  and (m.sender_id=v_uid or not public.findback_is_blocked_pair(c.user_a,c.user_b))
 order by m.event_sequence limit 100;
end $$;
commit;
