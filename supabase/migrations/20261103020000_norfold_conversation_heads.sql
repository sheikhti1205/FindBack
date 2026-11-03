-- Actor-visible publication order. Legacy global clear/read sequence stays intact.
-- No bodies or copied erasure payloads are retained in the new ledger.
begin;
lock table public.chat_conversations,public.chat_messages,public.chat_message_audience,
 public.chat_state_audience,public.chat_media_attachments in access exclusive mode;

create table public.chat_conversation_heads (
 user_id text not null references public.users(id) on delete cascade,
 conversation_id text not null,
 stream_id text not null default gen_random_uuid()::text,
 position bigint not null default 0 check(position between 0 and 9007199254740991),
 message_head bigint not null default 0,
 state_head bigint not null default 0,
 primary key(user_id,conversation_id),
 check(greatest(message_head,state_head)=position and least(message_head,state_head)>=0)
);
create table public.chat_conversation_log (
 user_id text not null references public.users(id) on delete cascade,
 conversation_id text not null,
 position bigint not null check(position between 1 and 9007199254740991),
 kind text not null check(kind in('MESSAGE','MEDIA','STATE')),
 source_id text not null,
 message_id text,
 published_at timestamptz not null default clock_timestamp(),
 provenance text not null check(provenance in('LIVE','MIGRATED')),
 primary key(user_id,conversation_id,position),
 unique(user_id,conversation_id,kind,source_id)
);
alter table public.chat_conversation_heads enable row level security;
alter table public.chat_conversation_log enable row level security;
revoke all on public.chat_conversation_heads,public.chat_conversation_log from public,anon,authenticated,service_role;

create function public.findback_chat_append_position_internal(p_user text,p_conversation text,p_kind text,
 p_source text,p_message text,p_provenance text default 'LIVE') returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare n bigint;
begin
 -- Existing SEND/remove/media owners already hold this lock. Acquiring it here
 -- also serializes migration/trigger callers; never acquire global state locks.
 perform 1 from public.chat_conversations where id=p_conversation and p_user in(user_a,user_b) for update;
 if not found then return false; end if;
 if exists(select 1 from public.chat_conversation_log where user_id=p_user and conversation_id=p_conversation
  and kind=p_kind and source_id=p_source) then return false; end if;
 insert into public.chat_conversation_heads(user_id,conversation_id) values(p_user,p_conversation) on conflict do nothing;
 update public.chat_conversation_heads set position=position+1,
  message_head=case when p_kind<>'STATE' then position+1 else message_head end,
  state_head=case when p_kind='STATE' then position+1 else state_head end
 where user_id=p_user and conversation_id=p_conversation returning position into n;
 insert into public.chat_conversation_log(user_id,conversation_id,position,kind,source_id,message_id,provenance)
 values(p_user,p_conversation,n,p_kind,p_source,p_message,p_provenance);
 return true;
end $$;

create function public.findback_chat_position_audience() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare m public.chat_messages%rowtype;
begin
 select * into m from public.chat_messages where id=new.message_id;
 if m.sender_id=new.user_id or m.message_type<>'MEDIA' or exists(select 1 from public.chat_media_attachments a
  where a.message_id=m.id and public.findback_chat_media_visible_internal(new.user_id,a.id)) then
  perform public.findback_chat_append_position_internal(new.user_id,m.conversation_id,'MESSAGE',m.id,m.id);
 end if;
 return null;
end $$;
create trigger chat_position_audience after insert on public.chat_message_audience
 for each row execute function public.findback_chat_position_audience();

create function public.findback_chat_position_media() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text; v_conversation text; added boolean;
begin
 if old.state='PENDING' and new.state='ATTACHED' then
  select conversation_id into v_conversation from public.chat_messages where id=new.message_id;
  for u in select user_id from public.chat_message_audience where message_id=new.message_id order by user_id loop
   if public.findback_chat_media_visible_internal(u,new.id) then
    added:=public.findback_chat_append_position_internal(u,v_conversation,'MESSAGE',new.message_id,new.message_id);
    if not added then perform public.findback_chat_append_position_internal(u,v_conversation,'MEDIA',new.id||':'||new.generation,new.message_id); end if;
   end if;
  end loop;
 end if;
 return null;
end $$;
create trigger chat_position_media after update of state on public.chat_media_attachments
 for each row execute function public.findback_chat_position_media();

-- Publication provenance prevents an UNSEND from disclosing a never-published
-- new-era peer photo. Historical uncertainty keeps conservative suppression.
create function public.findback_chat_position_state() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare e public.chat_state_events%rowtype;
begin
 select * into e from public.chat_state_events where id=new.event_id;
 if e.kind='UNSEND' and new.user_id<>e.author_id
  and exists(select 1 from public.chat_conversation_log where user_id=e.author_id
   and conversation_id=e.conversation_id and kind='MESSAGE' and source_id=e.message_id and provenance='LIVE')
  and not exists(select 1 from public.chat_conversation_log where user_id=new.user_id
   and conversation_id=e.conversation_id and kind='MESSAGE' and source_id=e.message_id) then return null; end if;
 perform public.findback_chat_append_position_internal(new.user_id,e.conversation_id,'STATE',e.id,e.message_id);
 return new;
end $$;
create trigger chat_position_state before insert on public.chat_state_audience
 for each row execute function public.findback_chat_position_state();

-- Deterministic NEW stream, not a claim to reconstruct historical commit times.
-- PENDING peer media remains unpublished. No installation receives a baseline.
do $$ declare r record; begin
 for r in select a.user_id,m.* from public.chat_message_audience a join public.chat_messages m on m.id=a.message_id
  where a.user_id=m.sender_id or m.message_type<>'MEDIA' or exists(select 1 from public.chat_media_attachments x
   where x.message_id=m.id and public.findback_chat_media_visible_internal(a.user_id,x.id))
  order by a.user_id,m.conversation_id,m.sent_at,m.id loop
  perform public.findback_chat_append_position_internal(r.user_id,r.conversation_id,'MESSAGE',r.id,r.id,'MIGRATED');
 end loop;
 for r in select a.user_id,e.* from public.chat_state_audience a join public.chat_state_events e on e.id=a.event_id
  order by a.user_id,e.conversation_id,e.event_sequence loop
  perform public.findback_chat_append_position_internal(r.user_id,r.conversation_id,'STATE',r.id,r.message_id,'MIGRATED');
 end loop;
end $$;

create function public.findback_chat_head_internal(p_user text,p_device text,p_conversation text) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations%rowtype; result jsonb;
begin
 if p_user is distinct from auth.uid()::text or not exists(select 1 from public.chat_devices
  where user_id=p_user and device_id=p_device) then raise exception 'Device unavailable' using errcode='42501'; end if;
 select * into c from public.chat_conversations where id=p_conversation and p_user in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 insert into public.chat_conversation_heads(user_id,conversation_id) values(p_user,p_conversation) on conflict do nothing;
 select jsonb_build_object('accountId',p_user,'conversationId',c.id,'streamId',h.stream_id,
  'epoch',public.findback_chat_relationship_epoch(c),'revision',s.revision,
  'position',h.position,'messageHead',h.message_head,'stateHead',h.state_head,
  'serverTime',floor(extract(epoch from clock_timestamp())*1000)::bigint) into result
 from public.chat_conversation_heads h join public.chat_member_state s
  on s.user_id=h.user_id and s.conversation_id=h.conversation_id
 where h.user_id=p_user and h.conversation_id=c.id;
 if result is null then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 return result;
end $$;

-- One mailbox eligibility/envelope owner for legacy SYNC and bounded ranges.
create function public.findback_chat_mailbox_internal(p_device text,p_ids text[]) returns setof jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text;
begin
 if u is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 return query select jsonb_build_object('accountId',u,'deviceId',p_device,'mailboxId',b.id,
  'event',jsonb_build_object('kind','TEXT','eventId',m.id,'sequence',m.event_sequence,
   'serverTime',floor(extract(epoch from m.sent_at)*1000)::bigint,'message',
   jsonb_build_object('id',m.id,'conversationId',c.id,'authorId',m.sender_id,
    'recipientId',case when c.user_a=m.sender_id then c.user_b else c.user_a end,
    'body',m.body,'messageType',m.message_type)
    ||case when m.context_report_id is null then '{}'::jsonb else jsonb_build_object('contextReportId',m.context_report_id) end
    ||case when m.message_type='LOCATION' then jsonb_build_object('location',jsonb_build_object('lat',m.location_lat,'lng',m.location_lng,'accuracy',m.location_accuracy_m)) else '{}'::jsonb end))
 from public.chat_mailbox b join public.chat_devices d on d.id=b.device_id
 join public.chat_messages m on m.id=b.message_id join public.chat_conversations c on c.id=b.conversation_id
 where d.user_id=u and d.device_id=p_device and b.acked_at is null and b.expires_at>clock_timestamp()
  and (p_ids is null or m.id=any(p_ids)) and m.unsent_at is null and (m.body<>'' or m.message_type in('MEDIA','LOCATION'))
  and (m.sender_id=u or not public.findback_is_blocked_pair(c.user_a,c.user_b))
  and (m.sender_id=u or m.message_type<>'MEDIA' or exists(select 1 from public.chat_media_attachments a
   where a.message_id=m.id and public.findback_chat_media_visible_internal(u,a.id)))
 order by m.event_sequence limit 100;
end $$;
create or replace function public.findback_fetch_chat_mailbox(p_device_id text) returns setof jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select * from public.findback_chat_mailbox_internal(p_device_id,null)
$$;

create function public.findback_chat_conversation_sync_internal(p_user text,p_device text,p_head jsonb,p_after bigint)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare h jsonb; target bigint; last_position bigint; messages jsonb; entries jsonb:='[]'::jsonb;
 r record; e public.chat_state_events%rowtype; value jsonb; envelope jsonb; ids text[]; expected_message bigint; expected_state bigint;
begin
 h:=public.findback_chat_head_internal(p_user,p_device,p_head->>'conversationId');
 target:=(p_head->>'position')::bigint;
 if p_after is null or target is null or p_after<0 or p_after>target or target>(h->>'position')::bigint
  or (h-'serverTime'-'position'-'messageHead'-'stateHead') is distinct from
     (p_head-'serverTime'-'position'-'messageHead'-'stateHead') then raise exception 'Conversation changed' using errcode='40001'; end if;
 select coalesce(max(position) filter(where kind<>'STATE'),0),coalesce(max(position) filter(where kind='STATE'),0)
 into expected_message,expected_state from public.chat_conversation_log
 where user_id=p_user and conversation_id=p_head->>'conversationId' and position<=target;
 if expected_message is distinct from (p_head->>'messageHead')::bigint or expected_state is distinct from (p_head->>'stateHead')::bigint then
  raise exception 'Invalid conversation target' using errcode='22023'; end if;
 last_position:=p_after;
 select array_agg(message_id) into ids from (select message_id from public.chat_conversation_log
  where user_id=p_user and conversation_id=p_head->>'conversationId' and position>p_after and position<=target order by position limit 100) page;
 select coalesce(jsonb_agg(x),'[]'::jsonb) into messages from public.findback_chat_mailbox_internal(p_device,coalesce(ids,'{}'::text[])) x;
 for r in select * from public.chat_conversation_log where user_id=p_user and conversation_id=p_head->>'conversationId'
  and position>p_after and position<=target order by position limit 100 loop
  if r.position<>last_position+1 then raise exception 'Conversation range incomplete' using errcode='40001'; end if;
  value:=jsonb_build_object('position',r.position,'kind',r.kind,'sourceId',r.source_id,'messageId',r.message_id,
   'publishedAt',floor(extract(epoch from r.published_at)*1000)::bigint);
  if r.kind='STATE' then
   select s.* into e from public.chat_state_events s join public.chat_state_audience a on a.event_id=s.id
    where s.id=r.source_id and a.user_id=p_user;
   if not found then raise exception 'Message state unavailable' using errcode='40001'; end if;
   value:=value||jsonb_build_object('change',jsonb_build_object('accountId',p_user,'deviceId',p_device,'change',
    jsonb_build_object('eventId',e.id,'sequence',e.event_sequence,'kind',e.kind,'conversationId',e.conversation_id,
     'occurredAt',floor(extract(epoch from e.occurred_at)*1000)::bigint)||case when e.kind='CLEAR_FOR_ME'
     then jsonb_build_object('peerId',e.peer_id,'throughSequence',e.through_sequence)
     else jsonb_build_object('messageId',e.message_id,'authorId',e.author_id,'recipientId',e.recipient_id,'messageSequence',e.message_sequence) end));
  else
   select x into envelope from jsonb_array_elements(messages) x where x#>>'{event,message,id}'=r.message_id;
   value:=value||case when envelope is null then jsonb_build_object('disposition','UNAVAILABLE') else jsonb_build_object('envelope',envelope) end;
  end if;
  entries:=entries||jsonb_build_array(value);last_position:=r.position;
 end loop;
 if last_position<least(target,p_after+100) then raise exception 'Conversation range incomplete' using errcode='40001'; end if;
 return jsonb_build_object('head',p_head||jsonb_build_object('serverTime',h->'serverTime'),
  'afterPosition',p_after,'throughPosition',last_position,'entries',entries);
end $$;

revoke all on function public.findback_chat_append_position_internal(text,text,text,text,text,text),
 public.findback_chat_position_audience(),public.findback_chat_position_media(),public.findback_chat_position_state(),
 public.findback_chat_head_internal(text,text,text),public.findback_chat_mailbox_internal(text,text[]),
 public.findback_chat_conversation_sync_internal(text,text,jsonb,bigint)
 from public,anon,authenticated,service_role;

-- Existing exchange is extended below; no second endpoint or wrapper chain.
create or replace function public.findback_chat_exchange(p_account_id text,p_device_id text,p_action text,p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_result jsonb; v_other text; v_after bigint; v_id text; v_head jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 case p_action
 when 'HEAD' then return public.findback_chat_head_internal(v_uid,p_device_id,p_args->>'conversationId');
 when 'CONVERSATION_SYNC' then return public.findback_chat_conversation_sync_internal(v_uid,p_device_id,p_args->'head',(p_args->>'afterPosition')::bigint);
 when 'REGISTER' then return to_jsonb(public.findback_register_chat_device(p_device_id,p_args->>'platform'));
 when 'VIEWS' then return public.findback_chat_views(p_args->>'afterId');
 when 'PRIVATE' then perform public.findback_chat_private_state(p_args->>'conversationId',p_args->>'operation');
 when 'CREATE' then return to_jsonb(public.findback_create_conversation(p_args->>'otherId'));
 when 'ACCEPT' then perform public.findback_accept_conversation(p_args->>'conversationId',p_args->>'expectedEpoch');
 when 'END' then perform public.findback_end_conversation(p_args->>'conversationId');
 when 'BLOCK' then perform public.findback_block_conversation(p_args->>'conversationId');
 when 'RECEIPTS' then perform public.findback_set_chat_receipts((p_args->>'enabled')::boolean);
 when 'PREFERENCES' then
  select jsonb_build_object('readReceipts',coalesce((select enabled from public.chat_preferences where user_id=v_uid),false),
   'openMessages',coalesce((select open_messages from public.chat_preferences where user_id=v_uid),false)) into v_result;
  return v_result;
 when 'CONTACT_MODE' then
  if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then raise exception 'Preference required' using errcode='22023'; end if;
  insert into public.chat_preferences(user_id,open_messages) values(v_uid,(p_args->>'enabled')::boolean)
   on conflict(user_id) do update set open_messages=excluded.open_messages;
 when 'SEND' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  select case when user_a=v_uid then user_b else user_a end into v_other from public.chat_conversations
   where id=p_args->>'conversationId' and v_uid in(user_a,user_b) for update;
  if not found or (p_args->>'recipientId') is distinct from v_other then raise exception 'Conversation unavailable' using errcode='42501'; end if;
  -- Stable accepted IDs remain replayable after a boundary; immutable payload
  -- validation is still performed by the canonical send owner below.
  if not exists(select 1 from public.chat_messages
   where id=p_args->>'messageId' and conversation_id=p_args->>'conversationId' and sender_id=v_uid) then
   v_head:=public.findback_chat_head_internal(v_uid,p_device_id,p_args->>'conversationId');
   if jsonb_typeof(p_args->'expectedHead') is distinct from 'object'
    or (v_head-'serverTime') is distinct from ((p_args->'expectedHead')-'serverTime') then
    raise exception 'Conversation changed' using errcode='40001'; end if;
  end if;
  return to_jsonb(public.findback_chat_send_internal(p_args->>'conversationId',p_args->>'body',p_args->>'messageId',
   coalesce(p_args->>'messageType','TEXT'),p_args->>'expectedEpoch',
   jsonb_strip_nulls(jsonb_build_object('reportId',p_args->>'contextReportId','location',p_args->'location'))));
 when 'SYNC' then
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_result from public.findback_fetch_chat_mailbox(p_device_id) e;
  return v_result;
 when 'ACK' then perform public.findback_ack_chat_message(p_args->>'mailboxId',p_device_id);
 when 'STATE_SYNC' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then raise exception 'Device unavailable' using errcode='42501'; end if;
  v_after:=(p_args->>'afterSequence')::bigint;
  if v_after is null or v_after<0 or v_after>9007199254740991 then raise exception 'Invalid state cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(page.value order by page.seq),'[]'::jsonb) into v_result from (
   select e.event_sequence as seq,jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'change',
    jsonb_build_object('eventId',e.id,'sequence',e.event_sequence,'kind',e.kind,'conversationId',e.conversation_id,
     'occurredAt',floor(extract(epoch from e.occurred_at)*1000)::bigint)||case when e.kind='CLEAR_FOR_ME'
     then jsonb_build_object('peerId',e.peer_id,'throughSequence',e.through_sequence)
     else jsonb_build_object('messageId',e.message_id,'authorId',e.author_id,'recipientId',e.recipient_id,'messageSequence',e.message_sequence) end) as value
   from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where a.user_id=v_uid and e.event_sequence>v_after order by e.event_sequence limit 100
  ) page;
  return v_result;
 when 'STATE_ACK' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then raise exception 'Device unavailable' using errcode='42501'; end if;
  v_after:=(p_args->>'sequence')::bigint;
  if not exists(select 1 from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where e.id=p_args->>'eventId' and e.event_sequence=v_after and a.user_id=v_uid) then raise exception 'State unavailable' using errcode='42501'; end if;
  update public.chat_devices set state_ack_sequence=greatest(state_ack_sequence,v_after) where user_id=v_uid and device_id=p_device_id;
 when 'UNSEND','DELETE_FOR_ME','CLEAR_FOR_ME' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then raise exception 'Device unavailable' using errcode='42501'; end if;
  v_id:=public.findback_chat_remove(p_action,p_args->>'conversationId',p_args->>'messageId',(p_args->>'throughSequence')::bigint);
  return to_jsonb(v_id);
 else raise exception 'Invalid chat operation' using errcode='22023';
 end case;
 return 'null'::jsonb;
end $$;
commit;
