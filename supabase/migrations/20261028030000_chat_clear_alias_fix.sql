-- Preserve the canonical erasure function while disambiguating its clear query.
begin;
create or replace function public.findback_chat_remove(p_kind text,p_conversation_id text,p_message_id text,p_through bigint)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype; m public.chat_messages%rowtype;
 v_id text; v_key text; v_peer text; v_through bigint; v_lock text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b);
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 -- Identity sequences are not commit-ordered by themselves. Serialize writes
 -- for every potentially affected account BEFORE assigning an event sequence;
 -- otherwise a later-committing lower sequence could be skipped by a device.
 for v_lock in select u.id from public.users u where u.id=v_uid
  or (p_kind='UNSEND' and u.id in(c.user_a,c.user_b)) order by u.id loop
  perform pg_advisory_xact_lock(hashtextextended('findback-chat-state:'||v_lock,0));
 end loop;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 v_peer:=case when c.user_a=v_uid then c.user_b else c.user_a end;
 if p_kind='CLEAR_FOR_ME' then
  if p_through is null or p_through<1 or p_through>9007199254740991 then
   raise exception 'Invalid clear point' using errcode='22023';
  end if;
  -- The caller selects its locally observed boundary, not a hidden server max.
  -- Store an owner-only watermark; never return activity/count information.
  select least(p_through,coalesce(max(msg.event_sequence),0)) into v_through
   from public.chat_messages msg join public.chat_message_audience a on a.message_id=msg.id
   where msg.conversation_id=c.id and a.user_id=v_uid;
  if v_through=0 then raise exception 'No sent messages to clear' using errcode='22023'; end if;
  v_key:=p_kind||':'||v_uid||':'||c.id||':'||v_through;
  insert into public.chat_state_events(operation_key,actor_id,conversation_id,kind,peer_id,through_sequence)
   values(v_key,v_uid,c.id,p_kind,v_peer,v_through) on conflict(operation_key) do nothing;
 elsif p_kind in('UNSEND','DELETE_FOR_ME') then
  select * into m from public.chat_messages where id=p_message_id and conversation_id=c.id for update;
  if not found or not exists(select 1 from public.chat_message_audience where message_id=m.id and user_id=v_uid)
   or (p_kind='UNSEND' and m.sender_id<>v_uid) then
   raise exception 'Message unavailable' using errcode='42501';
  end if;
  v_key:=p_kind||':'||v_uid||':'||m.id;
  insert into public.chat_state_events(operation_key,actor_id,conversation_id,kind,message_id,author_id,recipient_id,message_sequence,occurred_at)
   values(v_key,v_uid,c.id,p_kind,m.id,m.sender_id,
    case when c.user_a=m.sender_id then c.user_b else c.user_a end,m.event_sequence,
    case when p_kind='UNSEND' then coalesce(m.unsent_at,clock_timestamp()) else clock_timestamp() end)
   on conflict(operation_key) do nothing;
  if p_kind='UNSEND' then
   update public.chat_messages set unsent_at=coalesce(unsent_at,clock_timestamp()),unsent_by=v_uid,body='' where id=m.id;
   delete from public.chat_mailbox where message_id=m.id;
   -- Do not touch independently captured report/evidence storage.
  end if;
 else raise exception 'Invalid chat operation' using errcode='22023';
 end if;
 select id into v_id from public.chat_state_events where operation_key=v_key;
 if p_kind='UNSEND' then
  insert into public.chat_state_audience(event_id,user_id)
   select v_id,user_id from public.chat_message_audience where message_id=m.id on conflict do nothing;
 else
  insert into public.chat_state_audience(event_id,user_id) values(v_id,v_uid) on conflict do nothing;
 end if;
 return v_id;
end $$;
revoke all on function public.findback_chat_remove(text,text,text,bigint) from public,anon,authenticated;
commit;
