-- One admitted transport, restricted to one conversation even for own devices.
-- Legacy same-account signaling remains compatible; no public table grants.
begin;
alter table public.chat_peer_sessions
 add column target_user_id text references public.users(id) on delete cascade,
 add column conversation_id text,
 add column conversation_epoch text;
update public.chat_peer_sessions set target_user_id=user_id;
create index chat_peer_sessions_incoming on public.chat_peer_sessions(target_session,expires_at);

create function public.findback_history_peer_context_internal(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; s uuid:=public.findback_device_session_internal();
 p public.chat_peer_sessions%rowtype; c public.chat_conversations%rowtype; ctx jsonb; a text; peer_user text; peer_device text;
begin
 select * into p from public.chat_peer_sessions where id=p_id and conversation_id is not null
  and ((user_id=u and initiator_session=s) or (target_user_id=u and target_session=s));
 if not found then raise exception 'Peer unavailable' using errcode='42501'; end if;
 for a in select distinct x from unnest(array[p.user_id,p.target_user_id]) x order by x loop
  perform public.findback_device_lock_internal(a,false);
 end loop;
 ctx:=public.findback_device_context_internal(p.user_id,p.initiator_session,p.initiator_device);
 if (ctx->>'generation')::uuid is distinct from p.initiator_generation then raise exception 'Peer unavailable' using errcode='42501'; end if;
 ctx:=public.findback_device_context_internal(p.target_user_id,p.target_session,p.target_device);
 if (ctx->>'generation')::uuid is distinct from p.target_generation then raise exception 'Peer unavailable' using errcode='42501'; end if;
 select * into c from public.chat_conversations where id=p.conversation_id
  and p.user_id in(user_a,user_b) and p.target_user_id in(user_a,user_b) for update;
 if not found or p.conversation_epoch is distinct from public.findback_chat_relationship_epoch(c)
  or (p.user_id<>p.target_user_id and (c.state<>'CONNECTED' or public.findback_is_blocked_pair(c.user_a,c.user_b))) then
  raise exception 'Peer unavailable' using errcode='42501'; end if;
 select * into p from public.chat_peer_sessions where id=p_id and expires_at>clock_timestamp() for update;
 if not found then raise exception 'Peer unavailable' using errcode='42501'; end if;
 peer_user:=case when s=p.initiator_session then p.target_user_id else p.user_id end;
 peer_device:=case when s=p.initiator_session then p.target_device else p.initiator_device end;
 return jsonb_build_object('accountId',u,'peerAccountId',peer_user,'conversationId',p.conversation_id,'epoch',p.conversation_epoch,
  'sessionId',p.id,'initiatorDeviceId',p.initiator_device,'targetDeviceId',p.target_device,
  'peerPublicKey',(select public_key from public.chat_devices where user_id=peer_user and device_id=peer_device),
  'nonce',p.nonce,'issuedAt',floor(extract(epoch from p.created_at)*1000),'expiresAt',floor(extract(epoch from p.expires_at)*1000));
end $$;
revoke all on function public.findback_history_peer_context_internal(uuid) from public,anon,authenticated,service_role;

create function public.findback_history_peer(p_action text,p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; s uuid; ctx jsonb; c public.chat_conversations%rowtype; p public.chat_peer_sessions%rowtype;
 d public.chat_devices%rowtype; r jsonb; result jsonb:='[]'; item record; t text:=p_args->>'targetDeviceId';
 target_user text:=p_args->>'peerAccountId'; cid text:=p_args->>'conversationId'; sid uuid;
 kind text:=p_args->>'type'; data jsonb:=p_args->'data'; n integer; after_position integer;
begin
 if p_args is null or jsonb_typeof(p_args)<>'object' then raise exception 'Invalid signaling' using errcode='22023'; end if;
 if p_action in('DISCOVER','PENDING','OPEN') then
  ctx:=public.findback_device_admission();s:=(ctx->>'sessionId')::uuid;
  update public.chat_devices set last_seen_at=clock_timestamp() where user_id=u and device_id=ctx->>'deviceId';
  if p_action='PENDING' then
   if p_args<>'{}'::jsonb then raise exception 'Invalid signaling' using errcode='22023'; end if;
   for item in select id from public.chat_peer_sessions where target_user_id=u and target_session=s
    and target_device=ctx->>'deviceId' and conversation_id is not null and expires_at>clock_timestamp()
    order by created_at limit 16 loop
    begin
     r:=public.findback_history_peer_context_internal(item.id);
     result:=result||jsonb_build_array(jsonb_build_object('sessionId',item.id,'peerAccountId',r->>'peerAccountId',
      'targetDeviceId',r->>'initiatorDeviceId','conversationId',r->>'conversationId','epoch',r->>'epoch'));
    exception when insufficient_privilege then null;
    end;
   end loop;
   return result;
  end if;
  select * into c from public.chat_conversations where id=cid and u in(user_a,user_b) for update;
  if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
  if p_action='DISCOVER' then
   if (p_args-'conversationId')<>'{}'::jsonb then raise exception 'Invalid signaling' using errcode='22023'; end if;
   select coalesce(jsonb_agg(jsonb_build_object('peerAccountId',x.user_id,'targetDeviceId',x.device_id,
    'conversationId',c.id,'epoch',public.findback_chat_relationship_epoch(c)) order by x.user_id,x.device_id),'[]') into result
   from (select d.user_id,d.device_id from public.chat_devices d
    join public.chat_device_sessions b on b.session_id=d.auth_session_id and b.user_id=d.user_id and b.device_id=d.device_id
     and b.generation=d.enrollment_generation and b.revoked_at is null
    join auth.sessions a on a.id=d.auth_session_id and a.user_id::text=d.user_id
    join auth.users au on au.id=a.user_id and au.deleted_at is null and (au.banned_until is null or au.banned_until<=clock_timestamp())
    where d.user_id in(c.user_a,c.user_b) and d.revoked_at is null and d.public_key is not null
     and d.last_seen_at>clock_timestamp()-interval '2 minutes'
     and d.auth_session_id<>s and d.device_id<>ctx->>'deviceId'
     and not exists(select 1 from public.account_deletion_fences where user_id=d.user_id)
     and (d.user_id=u or (c.state='CONNECTED' and not public.findback_is_blocked_pair(c.user_a,c.user_b)))
    order by d.last_seen_at desc limit 40) x;
   return result;
  end if;
  if (p_args-'conversationId'-'epoch'-'peerAccountId'-'targetDeviceId')<>'{}'::jsonb
   or p_args->>'epoch' is distinct from public.findback_chat_relationship_epoch(c)
   or target_user is null or target_user not in(c.user_a,c.user_b) or t is null or t=ctx->>'deviceId'
   or (target_user<>u and (c.state<>'CONNECTED' or public.findback_is_blocked_pair(c.user_a,c.user_b))) then
   raise exception 'Peer unavailable' using errcode='42501'; end if;
  perform public.findback_device_lock_internal(target_user,false);
  select * into d from public.chat_devices where user_id=target_user and device_id=t and revoked_at is null and public_key is not null;
  if not found then raise exception 'Peer unavailable' using errcode='42501'; end if;
  perform public.findback_device_context_internal(target_user,d.auth_session_id,t);
  -- An exclusive rate lock only, never account enrollment/revocation authority.
  perform pg_advisory_xact_lock(hashtextextended('norfold-history-open:'||u,0));
  delete from public.chat_peer_sessions where user_id=u and expires_at<clock_timestamp()-interval '1 day';
  if (select count(*) from public.chat_peer_sessions where user_id=u and created_at>clock_timestamp()-interval '1 minute')>=16 then
   raise exception 'Please try again shortly' using errcode='54000'; end if;
  insert into public.chat_peer_sessions(user_id,target_user_id,conversation_id,conversation_epoch,
   initiator_device,target_device,initiator_session,target_session,initiator_generation,target_generation,nonce,expires_at)
   values(u,target_user,c.id,public.findback_chat_relationship_epoch(c),ctx->>'deviceId',t,s,d.auth_session_id,
    (ctx->>'generation')::uuid,d.enrollment_generation,encode(extensions.gen_random_bytes(32),'hex'),clock_timestamp()+interval '120 seconds')
   returning id into sid;
  return public.findback_history_peer_context_internal(sid);
 end if;
 begin sid:=(p_args->>'sessionId')::uuid; exception when invalid_text_representation then raise exception 'Peer unavailable' using errcode='42501'; end;
 if sid is null then raise exception 'Peer unavailable' using errcode='42501'; end if;
 r:=public.findback_history_peer_context_internal(sid);
 s:=public.findback_device_session_internal();
 select * into p from public.chat_peer_sessions where id=sid;
 if p_action in('CHECK','CLOSE') then
  if (p_args-'sessionId')<>'{}'::jsonb then raise exception 'Invalid signaling' using errcode='22023'; end if;
  if p_action='CLOSE' then delete from public.chat_peer_sessions where id=sid;return '{}'::jsonb;end if;
  return r;
 elsif p_action='READ' then
  if (p_args-'sessionId'-'after')<>'{}'::jsonb or jsonb_typeof(p_args->'after') is distinct from 'number'
   or p_args->>'after' !~ '^[0-9]{1,2}$' then raise exception 'Invalid signaling cursor' using errcode='22023';end if;
  after_position:=(p_args->>'after')::integer;
  if after_position>64 then raise exception 'Invalid signaling cursor' using errcode='22023';end if;
   return r||jsonb_build_object('signals',(select coalesce(jsonb_agg(jsonb_build_object('position',ps.position,'type',ps.type,'data',ps.data) order by ps.position),'[]')
   from public.chat_peer_signals ps where ps.session_id=sid and ps.position>after_position and ps.sender_session<>s));
 elsif p_action='WRITE' then
  if kind='offer' and s<>p.initiator_session or kind='answer' and s<>p.target_session then
   raise exception 'Signaling role unavailable' using errcode='42501'; end if;
  if (p_args-'sessionId'-'type'-'data')<>'{}'::jsonb or kind is null or kind not in('offer','answer','candidate')
   or data is null or jsonb_typeof(data)<>'object' then raise exception 'Invalid signaling' using errcode='22023'; end if;
  if kind in('offer','answer') then
   if (data-'sdp')<>'{}'::jsonb or jsonb_typeof(data->'sdp') is distinct from 'string'
    or length(data->>'sdp') not between 1 and 65536 or left(data->>'sdp',3)<>'v=0'
    or data->>'sdp' !~ 'a=fingerprint:sha-256 [0-9A-Fa-f:]+' then raise exception 'Invalid session description' using errcode='22023'; end if;
   if exists(select 1 from public.chat_peer_signals where session_id=sid and type=kind)
    or kind='answer' and not exists(select 1 from public.chat_peer_signals where session_id=sid and type='offer') then
    raise exception 'Signaling already changed' using errcode='42501'; end if;
  elsif (data-'candidate'-'sdpMid'-'sdpMLineIndex')<>'{}'::jsonb or not(data ?& array['candidate','sdpMid','sdpMLineIndex'])
   or jsonb_typeof(data->'candidate') is distinct from 'string' or length(data->>'candidate')>2048
   or (data->>'candidate'<>'' and data->>'candidate' !~ '^candidate:')
   or jsonb_typeof(data->'sdpMid') not in('string','null') or length(data->>'sdpMid')>64
   or jsonb_typeof(data->'sdpMLineIndex') not in('number','null')
   or (data->>'sdpMLineIndex' is not null and data->>'sdpMLineIndex' !~ '^([0-9]|1[0-6])$') then
   raise exception 'Invalid ICE candidate' using errcode='22023'; end if;
  select coalesce(max(position),0)+1 into n from public.chat_peer_signals where session_id=sid;
   if n>64 or (select coalesce(sum(octet_length(ps.data::text)),0) from public.chat_peer_signals ps where ps.session_id=sid)+octet_length(data::text)>196608 then
   raise exception 'Signaling limit reached' using errcode='54000'; end if;
  insert into public.chat_peer_signals values(sid,n,s,kind,data); return jsonb_build_object('position',n);
 end if;
 raise exception 'Invalid signaling action' using errcode='22023';
end $$;
revoke all on function public.findback_history_peer(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.findback_history_peer(text,jsonb) to authenticated;

-- Atomic page admission: target generation/revocation and content visibility
-- remain locked/rechecked in the SAME transaction, not two independent RPCs.
create function public.findback_peer_history_authority(p_session_id uuid,p_candidates jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare ctx jsonb; begin
 ctx:=public.findback_history_peer_context_internal(p_session_id);
 return public.findback_chat_history_authority(ctx->>'conversationId',ctx->>'epoch',ctx->>'peerAccountId',p_candidates);
end $$;
revoke all on function public.findback_peer_history_authority(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.findback_peer_history_authority(uuid,jsonb) to authenticated;
commit;
