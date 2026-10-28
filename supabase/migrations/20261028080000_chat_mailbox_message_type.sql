-- Carry the server-owned message discriminator through the participant-authorized
-- mailbox. Event kind remains TEXT for backward-compatible message delivery;
-- message.messageType is the authoritative TEXT/MEDIA classification.
begin;
create or replace function public.findback_fetch_chat_mailbox(p_device_id text)
returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 return query select jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'mailboxId',b.id,
  'event',jsonb_build_object('kind','TEXT','eventId',m.id,'sequence',m.event_sequence,'message',
   jsonb_build_object('id',m.id,'conversationId',c.id,'authorId',m.sender_id,
    'recipientId',case when c.user_a=m.sender_id then c.user_b else c.user_a end,
    'body',m.body,'messageType',m.message_type)))
 from public.chat_mailbox b join public.chat_devices d on d.id=b.device_id
 join public.chat_messages m on m.id=b.message_id join public.chat_conversations c on c.id=b.conversation_id
 where d.user_id=v_uid and d.device_id=p_device_id and b.acked_at is null and b.expires_at>clock_timestamp()
  and m.unsent_at is null and (m.body<>'' or m.message_type='MEDIA')
  and (m.sender_id=v_uid or not public.findback_is_blocked_pair(c.user_a,c.user_b))
 order by m.event_sequence limit 100;
end $$;
commit;
