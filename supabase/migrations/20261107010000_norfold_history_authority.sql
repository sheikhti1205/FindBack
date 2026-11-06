-- Peer devices supply content, never identity/publication/suppression authority.
-- No body archive, no receipt grant, no metadata/cursor imported from a peer.
begin;
create function public.findback_chat_history_authority(p_conversation_id text,p_epoch text,
 p_target_account text,p_candidates jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; c public.chat_conversations%rowtype; result jsonb;
begin
 perform public.findback_device_admission();
 select * into c from public.chat_conversations where id=p_conversation_id and u in(user_a,user_b) for update;
 if not found or p_target_account is null or p_target_account not in(c.user_a,c.user_b) then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if p_epoch is distinct from public.findback_chat_relationship_epoch(c) then
  raise exception 'Conversation changed' using errcode='40001'; end if;
 -- Same-account copies may repair their own published history offline from the
 -- correspondent; cross-account recovery never bypasses current block/membership.
 if p_target_account<>u and (c.state<>'CONNECTED' or public.findback_is_blocked_pair(c.user_a,c.user_b)) then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if p_candidates is null or jsonb_typeof(p_candidates)<>'array' then
  raise exception 'Invalid history inventory' using errcode='22023'; end if;
 if jsonb_array_length(p_candidates)>64 then raise exception 'History inventory limit' using errcode='54000'; end if;
 if exists(select 1 from jsonb_array_elements(p_candidates) x where jsonb_typeof(x)<>'object'
  or (x-'messageId'-'payloadIdentity')<>'{}'::jsonb or not(x ?& array['messageId','payloadIdentity'])
  or jsonb_typeof(x->'messageId') is distinct from 'string' or x->>'messageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or jsonb_typeof(x->'payloadIdentity') is distinct from 'string' or x->>'payloadIdentity' !~ '^[0-9a-f]{64}$')
  or (select count(distinct x->>'messageId') from jsonb_array_elements(p_candidates) x)<>jsonb_array_length(p_candidates) then
  raise exception 'Invalid history inventory' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('messageId',m.id,'conversationId',c.id,
  'authorId',m.sender_id,'recipientId',case when m.sender_id=c.user_a then c.user_b else c.user_a end,
  'sequence',m.event_sequence,'messageType',m.message_type,'sentAt',floor(extract(epoch from m.sent_at)*1000)::bigint,
  'payloadIdentity',m.payload_identity) order by x.ordinality),'[]'::jsonb) into result
 from jsonb_array_elements(p_candidates) with ordinality x(value,ordinality)
 join public.chat_messages m on m.id=x.value->>'messageId' and m.conversation_id=c.id
 where m.sender_id in(c.user_a,c.user_b) and m.payload_identity=x.value->>'payloadIdentity'
  and m.unsent_at is null
  and exists(select 1 from public.chat_message_audience a where a.message_id=m.id and a.user_id=u)
  and exists(select 1 from public.chat_message_audience a where a.message_id=m.id and a.user_id=p_target_account)
  and not exists(select 1 from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where e.conversation_id=c.id
    and ((e.kind='UNSEND' and e.message_id=m.id)
     or (a.user_id=u and ((e.kind='DELETE_FOR_ME' and e.message_id=m.id)
      or (e.kind='CLEAR_FOR_ME' and e.through_sequence>=m.event_sequence)))))
   and (m.message_type<>'MEDIA' or exists(select 1 from public.chat_media_attachments a where a.message_id=m.id
    and public.findback_chat_media_visible_internal(u,a.id)));
  -- Target publication is public-to-participants authority; target private
  -- deletion/clear is not. Each importing endpoint rechecks its OWN suppression.
  -- Applying target-private media visibility here would leak the same fact.
 -- Deliberately no body/location/report/receipt/state content. TTL-erased bodies
 -- are accepted if identity survives; legacy-null and inaccessible IDs omitted.
 return result;
end $$;
revoke all on function public.findback_chat_history_authority(text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.findback_chat_history_authority(text,text,text,jsonb) to authenticated;
commit;
