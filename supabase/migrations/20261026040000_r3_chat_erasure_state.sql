-- Persistent minimal erasure metadata; ordinary message bodies still use only
-- the temporary mailbox. No generic HISTORY or permanent delivered-body archive.
begin;
create table public.chat_message_audience (
 message_id text not null references public.chat_messages(id) on delete cascade,
 user_id text not null references public.users(id) on delete cascade,
 primary key(message_id,user_id)
);
alter table public.chat_message_audience enable row level security;
revoke all on public.chat_message_audience from public,anon,authenticated;
insert into public.chat_message_audience(message_id,user_id)
select id,sender_id from public.chat_messages
union select b.message_id,d.user_id from public.chat_mailbox b join public.chat_devices d on d.id=b.device_id
on conflict do nothing;

create or replace function public.findback_enqueue_chat_mailbox(p_message_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare m public.chat_messages%rowtype; c public.chat_conversations%rowtype; v_blocked boolean;
begin
 select * into m from public.chat_messages where id=p_message_id;
 if not found then return; end if;
 select * into c from public.chat_conversations where id=m.conversation_id;
 v_blocked:=public.findback_is_blocked_pair(c.user_a,c.user_b);
 insert into public.chat_message_audience(message_id,user_id)
 select m.id,u.id from public.users u where u.id=m.sender_id or (not v_blocked and u.id in(c.user_a,c.user_b))
 on conflict do nothing;
 insert into public.chat_mailbox(device_id,message_id,conversation_id)
 select d.id,m.id,c.id from public.chat_devices d where
  d.user_id=m.sender_id or (not v_blocked and d.user_id in(c.user_a,c.user_b))
 on conflict(device_id,message_id) do nothing;
end $$;

create table public.chat_state_events (
 id text primary key default gen_random_uuid()::text,
 event_sequence bigint generated always as identity unique check(event_sequence<=9007199254740991),
 operation_key text not null unique,
 actor_id text not null,
 conversation_id text not null,
 kind text not null check(kind in('UNSEND','DELETE_FOR_ME','CLEAR_FOR_ME')),
 message_id text,
 author_id text,
 recipient_id text,
 message_sequence bigint,
 peer_id text,
 through_sequence bigint,
 occurred_at timestamptz not null default clock_timestamp(),
 check ((kind='CLEAR_FOR_ME' and message_id is null and author_id is null and recipient_id is null
    and message_sequence is null and peer_id is not null and through_sequence>0)
  or (kind in('UNSEND','DELETE_FOR_ME') and message_id is not null and author_id is not null
    and recipient_id is not null and author_id<>recipient_id and message_sequence>0
    and peer_id is null and through_sequence is null))
);
-- No conversation/message FK: suppression remains useful to a surviving user's
-- backups even after ordinary peer/account/conversation metadata is removed.
create table public.chat_state_audience (
 event_id text not null references public.chat_state_events(id) on delete cascade,
 user_id text not null references public.users(id) on delete cascade,
 primary key(event_id,user_id)
);
create index chat_state_audience_owner on public.chat_state_audience(user_id,event_id);
alter table public.chat_state_events enable row level security;
alter table public.chat_state_audience enable row level security;
revoke all on public.chat_state_events,public.chat_state_audience from public,anon,authenticated;
alter table public.chat_devices add column state_ack_sequence bigint not null default 0;

-- Preserve real prior erasure decisions, not invented delivery provenance.
insert into public.chat_state_events(operation_key,actor_id,conversation_id,kind,message_id,author_id,recipient_id,message_sequence,occurred_at)
select 'UNSEND:'||m.sender_id||':'||m.id,m.sender_id,c.id,'UNSEND',m.id,m.sender_id,
 case when c.user_a=m.sender_id then c.user_b else c.user_a end,m.event_sequence,m.unsent_at
from public.chat_messages m join public.chat_conversations c on c.id=m.conversation_id where m.unsent_at is not null;
insert into public.chat_state_audience(event_id,user_id)
select e.id,a.user_id from public.chat_state_events e join public.chat_message_audience a on a.message_id=e.message_id;
insert into public.chat_state_events(operation_key,actor_id,conversation_id,kind,message_id,author_id,recipient_id,message_sequence,occurred_at)
select 'DELETE_FOR_ME:'||d.user_id||':'||m.id,d.user_id,c.id,'DELETE_FOR_ME',m.id,m.sender_id,
 case when c.user_a=m.sender_id then c.user_b else c.user_a end,m.event_sequence,d.deleted_at
from public.chat_deleted_for_me d join public.chat_messages m on m.id=d.message_id
join public.chat_conversations c on c.id=m.conversation_id where d.user_id in(c.user_a,c.user_b);
insert into public.chat_state_audience(event_id,user_id)
select id,actor_id from public.chat_state_events where kind='DELETE_FOR_ME' on conflict do nothing;

create function public.findback_chat_remove(p_kind text,p_conversation_id text,p_message_id text,p_through bigint)
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
  select least(p_through,coalesce(max(m.event_sequence),0)) into v_through
   from public.chat_messages m join public.chat_message_audience a on a.message_id=m.id
   where m.conversation_id=c.id and a.user_id=v_uid;
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

-- Route the legacy author RPC through the same canonical event owner.
create or replace function public.findback_unsend_chat_message(p_message_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_id text;
begin
 select conversation_id into v_id from public.chat_messages where id=p_message_id;
 perform public.findback_chat_remove('UNSEND',v_id,p_message_id,null);
end $$;

-- Preserve the previous exchange implementation without copying its transitions.
-- It becomes internal only; clients retain the ONE captured-account entry point.
alter function public.findback_chat_exchange(text,text,text,jsonb) rename to findback_chat_exchange_041;
revoke all on function public.findback_chat_exchange_041(text,text,text,jsonb) from public,anon,authenticated;
create function public.findback_chat_exchange(p_account_id text,p_device_id text,p_action text,p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_after bigint; v_id text; result jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 if p_action not in('STATE_SYNC','STATE_ACK','DELETE_FOR_ME','CLEAR_FOR_ME','UNSEND') then
  return public.findback_chat_exchange_041(p_account_id,p_device_id,p_action,p_args);
 end if;
 if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
  raise exception 'Device unavailable' using errcode='42501';
 end if;
 if p_action='STATE_SYNC' then
  v_after:=(p_args->>'afterSequence')::bigint;
  if v_after is null or v_after<0 or v_after>9007199254740991 then raise exception 'Invalid state cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(page.value order by page.seq),'[]'::jsonb) into result from (
   select e.event_sequence as seq,jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'change',
    jsonb_build_object('eventId',e.id,'sequence',e.event_sequence,'kind',e.kind,'conversationId',e.conversation_id,
     'occurredAt',floor(extract(epoch from e.occurred_at)*1000)::bigint) ||
    case when e.kind='CLEAR_FOR_ME' then jsonb_build_object('peerId',e.peer_id,'throughSequence',e.through_sequence)
     else jsonb_build_object('messageId',e.message_id,'authorId',e.author_id,'recipientId',e.recipient_id,'messageSequence',e.message_sequence) end) as value
   from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where a.user_id=v_uid and e.event_sequence>v_after order by e.event_sequence limit 100
  ) page;
  return result;
 elsif p_action='STATE_ACK' then
  v_after:=(p_args->>'sequence')::bigint;
  if not exists(select 1 from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where e.id=p_args->>'eventId' and e.event_sequence=v_after and a.user_id=v_uid) then
   raise exception 'State unavailable' using errcode='42501';
  end if;
  update public.chat_devices set state_ack_sequence=greatest(state_ack_sequence,v_after)
   where user_id=v_uid and device_id=p_device_id;
  return 'null'::jsonb;
 else
  v_id:=public.findback_chat_remove(p_action,p_args->>'conversationId',p_args->>'messageId',(p_args->>'throughSequence')::bigint);
  return to_jsonb(v_id);
 end if;
end $$;
revoke all on function public.findback_chat_exchange(text,text,text,jsonb) from public,anon;
grant execute on function public.findback_chat_exchange(text,text,text,jsonb) to authenticated;

create or replace function public.findback_cleanup_chat_mailbox()
returns integer language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare n integer;
begin
 delete from public.chat_mailbox where acked_at is not null or expires_at<clock_timestamp();
 get diagnostics n=row_count;
 update public.chat_messages m set body='' where body<>'' and not exists(select 1 from public.chat_mailbox b where b.message_id=m.id);
 -- Suppression survives for any still-authorized account, not forever after
 -- every audience account has been removed. Report storage is independent.
 delete from public.chat_state_events e where not exists(select 1 from public.chat_state_audience a where a.event_id=e.id);
 return n;
end $$;
commit;
