-- LOCAL milestone WIP: device authority and canonical Chat/media/push admission.
-- Runtime key enrollment and authenticated peer execution remain required before
-- milestone acceptance/publication. Earlier applied migrations remain immutable.
begin;

alter table public.chat_devices
 add column public_key text check(public_key ~ '^04[0-9a-f]{128}$'),
 add column auth_session_id uuid,
 add column enrollment_generation uuid,
 add column revoked_at timestamptz;

-- Retained even after an installation is removed/rebound. A session cannot mint
-- device aliases, and its denial does not depend on the caller's device argument.
create table public.chat_device_sessions(
 session_id uuid primary key,
 user_id text not null references public.users(id) on delete cascade,
 device_id text not null,
 generation uuid not null,
 bound_at timestamptz not null default clock_timestamp(),
 revoked_at timestamptz
);
create index chat_device_sessions_installation on public.chat_device_sessions(user_id,device_id);
create table public.chat_device_challenges(
 id uuid primary key default gen_random_uuid(),
 user_id text not null references public.users(id) on delete cascade,
 session_id uuid not null,
 device_id text not null,
 public_key text not null check(public_key ~ '^04[0-9a-f]{128}$'),
 device_name text not null,
 platform text not null check(platform in('web','android','ios')),
 nonce text not null,
 issued_ms bigint not null,
 expires_ms bigint not null,
 consumed_at timestamptz
);
create index chat_device_challenges_rate on public.chat_device_challenges(user_id,issued_ms);
alter table public.chat_device_sessions enable row level security;
alter table public.chat_device_challenges enable row level security;
revoke all on public.chat_device_sessions,public.chat_device_challenges from public,anon,authenticated,service_role;

alter table public.device_tokens
 add column installation_id text,
 add column auth_session_id uuid,
 add column enrollment_generation uuid;

-- Global lock order: account authority, THEN existing conversation/pair locks.
-- Shared ordinary admission; exclusive enrollment/rebind/revoke. Stable advisory
-- key exists even for absent/future device/fence rows. Hash collision only reduces
-- concurrency; it cannot admit unauthorized work.
create function public.findback_device_lock_internal(p_uid text,p_exclusive boolean) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$ begin
 if p_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_exclusive then perform pg_advisory_xact_lock(hashtextextended('norfold-authority:'||p_uid,0));
 else perform pg_advisory_xact_lock_shared(hashtextextended('norfold-authority:'||p_uid,0)); end if;
end $$;

create function public.findback_device_session_internal() returns uuid
language plpgsql stable security definer set search_path=public,pg_temp as $$ declare s text:=auth.jwt()->>'session_id'; begin
 if s is null or s !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
  raise exception 'Session unavailable' using errcode='42501'; end if;
 return s::uuid;
end $$;

-- Private authority primitive. Service callers must supply only server-verified
-- context. Callers hold shared/exclusive account lock before invoking it.
create function public.findback_device_context_internal(p_uid text,p_session uuid,p_device text,p_enroll boolean default false)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare b public.chat_device_sessions%rowtype; d public.chat_devices%rowtype;
begin
 if p_uid is null or p_session is null or exists(select 1 from public.account_deletion_fences where user_id=p_uid)
  or not exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id
   join public.users a on a.id=u.id::text where s.id=p_session and s.user_id::text=p_uid
   and u.deleted_at is null and (u.banned_until is null or u.banned_until<=clock_timestamp())) then
  raise exception 'Session unavailable' using errcode='42501'; end if;
 select * into b from public.chat_device_sessions where session_id=p_session;
 if found and (b.user_id<>p_uid or b.revoked_at is not null or (p_device is not null and b.device_id<>p_device)) then
  raise exception 'Device unavailable' using errcode='42501'; end if;
 if b.session_id is not null then
  select * into d from public.chat_devices where user_id=p_uid and device_id=b.device_id;
  if not found or d.revoked_at is not null or d.auth_session_id is distinct from p_session
   or d.enrollment_generation is distinct from b.generation or d.public_key is null then
   raise exception 'Device unavailable' using errcode='42501'; end if;
 elsif not p_enroll then raise exception 'Device enrollment required' using errcode='42501'; end if;
 return jsonb_build_object('accountId',p_uid,'sessionId',p_session,'deviceId',b.device_id,'generation',b.generation);
end $$;

create function public.findback_device_admission(p_device_id text default null) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$ declare u text:=auth.uid()::text; begin
 perform public.findback_device_lock_internal(u,false);
 return public.findback_device_context_internal(u,public.findback_device_session_internal(),p_device_id);
end $$;

-- JWT-authorized issuance is NOT key-possession verification. The Edge verifier
-- checks a domain-separated signature; only its service-only commit enrolls.
create function public.findback_device_enrollment_challenge(p_device_id text,p_public_key text,p_name text,p_platform text)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; s uuid; d public.chat_devices%rowtype; c public.chat_device_challenges%rowtype;
 n bigint:=floor(extract(epoch from clock_timestamp())*1000); label text:=btrim(p_name);
begin
  perform public.findback_device_lock_internal(u,true); n:=floor(extract(epoch from clock_timestamp())*1000); s:=public.findback_device_session_internal();
 perform public.findback_device_context_internal(u,s,p_device_id,true);
 if p_device_id is null or p_device_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or p_public_key is null or p_public_key !~ '^04[0-9a-f]{128}$' or label is null or length(label) not between 1 and 64
  or label ~ '[[:cntrl:]]' or p_platform is null or p_platform not in('web','android','ios') then
  raise exception 'Invalid device' using errcode='22023'; end if;
 select * into d from public.chat_devices where user_id=u and device_id=p_device_id;
 if found and (d.revoked_at is not null or (d.public_key is not null and d.public_key<>p_public_key)) then
  raise exception 'Device unavailable' using errcode='42501'; end if;
 delete from public.chat_device_challenges where user_id=u and expires_ms<n-86400000;
 if (select count(*) from public.chat_device_challenges where user_id=u and issued_ms>n-60000)>=20
  or (select count(*) from public.chat_device_challenges where session_id=s and expires_ms>n and consumed_at is null)>=5 then
  raise exception 'Please try again shortly' using errcode='54000'; end if;
 insert into public.chat_device_challenges(user_id,session_id,device_id,public_key,device_name,platform,nonce,issued_ms,expires_ms)
 values(u,s,p_device_id,p_public_key,label,p_platform,encode(extensions.gen_random_bytes(32),'hex'),n,n+60000) returning * into c;
 return jsonb_build_object('challengeId',c.id,'accountId',u,'sessionId',s,'deviceId',p_device_id,
  'publicKey',c.public_key,'nonce',c.nonce,'issuedAt',c.issued_ms,'expiresAt',c.expires_ms);
end $$;

create function public.findback_device_enrollment_proof(p_challenge uuid) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; s uuid; c public.chat_device_challenges%rowtype;
begin
 perform public.findback_device_lock_internal(u,false); s:=public.findback_device_session_internal();
 select * into c from public.chat_device_challenges where id=p_challenge and user_id=u and session_id=s;
 if not found or c.consumed_at is not null or c.expires_ms<=floor(extract(epoch from clock_timestamp())*1000) then
  raise exception 'Device proof unavailable' using errcode='42501'; end if;
 perform public.findback_device_context_internal(u,s,c.device_id,true);
 return jsonb_build_object('challengeId',c.id,'accountId',u,'sessionId',s,'deviceId',c.device_id,
  'publicKey',c.public_key,'nonce',c.nonce,'issuedAt',c.issued_ms,'expiresAt',c.expires_ms);
end $$;

create function public.findback_device_enrollment_commit(p_uid text,p_session uuid,p_challenge uuid)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare c public.chat_device_challenges%rowtype; d public.chat_devices%rowtype; g uuid:=gen_random_uuid();
 n bigint:=floor(extract(epoch from clock_timestamp())*1000);
begin
  perform public.findback_device_lock_internal(p_uid,true);
  n:=floor(extract(epoch from clock_timestamp())*1000);
 select * into c from public.chat_device_challenges where id=p_challenge and user_id=p_uid and session_id=p_session for update;
 if not found or c.consumed_at is not null or c.expires_ms<=n then raise exception 'Device proof unavailable' using errcode='42501'; end if;
 perform public.findback_device_context_internal(p_uid,p_session,c.device_id,true);
 select * into d from public.chat_devices where user_id=p_uid and device_id=c.device_id for update;
 if found and (d.revoked_at is not null or (d.public_key is not null and d.public_key<>c.public_key)) then
  raise exception 'Device unavailable' using errcode='42501'; end if;
 if d.id is null and (select count(*) from public.chat_devices where user_id=p_uid and revoked_at is null)>=20 then
  raise exception 'Too many devices' using errcode='54000'; end if;
 -- Same-session retries/heartbeats preserve generation. Rebind atomically fences
 -- every historical old session; key itself is never overwritten or rotated.
 if d.auth_session_id=p_session then g:=d.enrollment_generation;
 else
  update public.chat_device_sessions set revoked_at=coalesce(revoked_at,clock_timestamp())
   where user_id=p_uid and device_id=c.device_id and session_id<>p_session;
  delete from public.device_tokens where user_id=p_uid and installation_id=c.device_id;
 end if;
 insert into public.chat_devices(user_id,device_id,device_name,platform,public_key,auth_session_id,enrollment_generation)
 values(p_uid,c.device_id,c.device_name,c.platform,c.public_key,p_session,g)
 on conflict(user_id,device_id) do update set device_name=excluded.device_name,platform=excluded.platform,
  public_key=coalesce(chat_devices.public_key,excluded.public_key),auth_session_id=excluded.auth_session_id,
  enrollment_generation=excluded.enrollment_generation,last_seen_at=clock_timestamp();
 insert into public.chat_device_sessions(session_id,user_id,device_id,generation) values(p_session,p_uid,c.device_id,g)
 on conflict(session_id) do nothing;
 update public.chat_device_challenges set consumed_at=clock_timestamp() where id=c.id;
 return public.findback_device_context_internal(p_uid,p_session,c.device_id);
end $$;

create function public.findback_devices(p_action text,p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; s uuid; ctx jsonb; target text:=p_args->>'deviceId'; label text:=btrim(p_args->>'name'); r jsonb;
begin
 perform public.findback_device_lock_internal(u,p_action<>'LIST'); s:=public.findback_device_session_internal();
 ctx:=public.findback_device_context_internal(u,s,null);
 if p_args is null or jsonb_typeof(p_args)<>'object' then raise exception 'Invalid device action' using errcode='22023'; end if;
 if p_action='LIST' then
  if p_args<>'{}'::jsonb then raise exception 'Invalid device action' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('deviceId',device_id,'name',coalesce(device_name,'Device'),
   'platform',platform,'lastSeenAt',floor(extract(epoch from last_seen_at)*1000),
   'current',device_id=ctx->>'deviceId') order by last_seen_at desc),'[]'::jsonb) into r
   from public.chat_devices where user_id=u and revoked_at is null and public_key is not null;
  return r;
 elsif p_action in('RENAME','REVOKE') then
  if target is null or not exists(select 1 from public.chat_devices where user_id=u and device_id=target and revoked_at is null)
   then raise exception 'Device unavailable' using errcode='42501'; end if;
  if p_action='RENAME' then
   if (p_args-'deviceId'-'name')<>'{}'::jsonb or jsonb_typeof(p_args->'name')<>'string'
    or label is null or length(label) not between 1 and 64 or label ~ '[[:cntrl:]]' then raise exception 'Invalid device name' using errcode='22023'; end if;
   update public.chat_devices set device_name=label where user_id=u and device_id=target;
  else
   if (p_args-'deviceId')<>'{}'::jsonb then raise exception 'Invalid device action' using errcode='22023'; end if;
   update public.chat_devices set revoked_at=clock_timestamp(),push_token=null where user_id=u and device_id=target;
   update public.chat_device_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where user_id=u and device_id=target;
   update public.chat_device_challenges set consumed_at=coalesce(consumed_at,clock_timestamp()) where user_id=u and device_id=target;
   delete from public.device_tokens where user_id=u and installation_id=target;
  end if;
  return '{}'::jsonb;
 end if;
 raise exception 'Invalid device action' using errcode='22023';
end $$;

revoke all on function public.findback_device_lock_internal(text,boolean),public.findback_device_session_internal(),
 public.findback_device_context_internal(text,uuid,text,boolean),public.findback_device_admission(text),
 public.findback_device_enrollment_proof(uuid),
 public.findback_device_enrollment_challenge(text,text,text,text),public.findback_device_enrollment_commit(text,uuid,uuid),
 public.findback_devices(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.findback_device_admission(text),public.findback_device_enrollment_challenge(text,text,text,text),
 public.findback_device_enrollment_proof(uuid),public.findback_devices(text,jsonb) to authenticated;
grant execute on function public.findback_device_enrollment_commit(text,uuid,uuid) to service_role;

-- No direct table/RealtIme grants: SDP/ICE must be fetched through current
-- endpoint admission, not cached account-only channel authorization.
create table public.chat_peer_sessions(
 id uuid primary key default gen_random_uuid(),
 user_id text not null references public.users(id) on delete cascade,
 initiator_device text not null, target_device text not null,
 initiator_session uuid not null, target_session uuid not null,
 initiator_generation uuid not null, target_generation uuid not null,
 nonce text not null,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '60 seconds',
 check(initiator_device<>target_device)
);
create index chat_peer_sessions_rate on public.chat_peer_sessions(user_id,created_at);
create table public.chat_peer_signals(
 session_id uuid not null references public.chat_peer_sessions(id) on delete cascade,
 position integer not null check(position between 1 and 64),
 sender_session uuid not null,
 type text not null check(type in('offer','answer','candidate')),
 data jsonb not null,
 primary key(session_id,position)
);
alter table public.chat_peer_sessions enable row level security;
alter table public.chat_peer_signals enable row level security;
revoke all on public.chat_peer_sessions,public.chat_peer_signals from public,anon,authenticated,service_role;

create function public.findback_peer_signal(p_action text,p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; s uuid; ctx jsonb; peer jsonb; c public.chat_peer_sessions%rowtype; d public.chat_devices%rowtype;
 t text:=p_args->>'targetDeviceId'; sid text:=p_args->>'sessionId'; kind text:=p_args->>'type'; payload jsonb:=p_args->'data';
 n integer; after_position integer; signals jsonb; r jsonb;
begin
 perform public.findback_device_lock_internal(u,p_action='OPEN'); s:=public.findback_device_session_internal();
 ctx:=public.findback_device_context_internal(u,s,null);
 if p_args is null or jsonb_typeof(p_args)<>'object' then raise exception 'Invalid signaling' using errcode='22023'; end if;
 if p_action='OPEN' then
  if (p_args-'targetDeviceId')<>'{}'::jsonb or t is null or t=ctx->>'deviceId' then raise exception 'Invalid peer' using errcode='22023'; end if;
  select * into d from public.chat_devices where user_id=u and device_id=t and revoked_at is null and public_key is not null;
  if not found then raise exception 'Peer unavailable' using errcode='42501'; end if;
  peer:=public.findback_device_context_internal(u,d.auth_session_id,t);
  delete from public.chat_peer_sessions where user_id=u and expires_at<clock_timestamp()-interval '1 day';
  if (select count(*) from public.chat_peer_sessions where user_id=u and created_at>clock_timestamp()-interval '1 minute')>=16 then
   raise exception 'Please try again shortly' using errcode='54000'; end if;
  insert into public.chat_peer_sessions(user_id,initiator_device,target_device,initiator_session,target_session,initiator_generation,target_generation,nonce)
  values(u,ctx->>'deviceId',t,s,d.auth_session_id,(ctx->>'generation')::uuid,d.enrollment_generation,
   encode(extensions.gen_random_bytes(32),'hex')) returning * into c;
 else
  if sid is null or sid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   raise exception 'Peer unavailable' using errcode='42501'; end if;
  select * into c from public.chat_peer_sessions where id=sid::uuid and user_id=u
   and s in(initiator_session,target_session) and expires_at>clock_timestamp() for update;
  if not found then raise exception 'Peer unavailable' using errcode='42501'; end if;
 end if;
 -- Both current immutable endpoints/generations are checked on EVERY operation.
 peer:=public.findback_device_context_internal(u,c.initiator_session,c.initiator_device);
 if (peer->>'generation')::uuid is distinct from c.initiator_generation then raise exception 'Peer unavailable' using errcode='42501'; end if;
 peer:=public.findback_device_context_internal(u,c.target_session,c.target_device);
 if (peer->>'generation')::uuid is distinct from c.target_generation then raise exception 'Peer unavailable' using errcode='42501'; end if;
 select * into d from public.chat_devices where user_id=u and device_id=case when s=c.initiator_session then c.target_device else c.initiator_device end;
 r:=jsonb_build_object('accountId',u,'sessionId',c.id,'initiatorDeviceId',c.initiator_device,'targetDeviceId',c.target_device,
  'peerPublicKey',d.public_key,'nonce',c.nonce,'issuedAt',floor(extract(epoch from c.created_at)*1000),
  'expiresAt',floor(extract(epoch from c.expires_at)*1000));
 if p_action='OPEN' then return r;
 elsif p_action='CLOSE' then
  if (p_args-'sessionId')<>'{}'::jsonb then raise exception 'Invalid signaling' using errcode='22023'; end if;
  delete from public.chat_peer_sessions where id=c.id; return '{}'::jsonb;
 elsif p_action='READ' then
  if (p_args-'sessionId'-'after')<>'{}'::jsonb or jsonb_typeof(p_args->'after') is distinct from 'number'
   or (p_args->>'after') !~ '^[0-9]{1,2}$' then raise exception 'Invalid signaling cursor' using errcode='22023'; end if;
  after_position:=(p_args->>'after')::integer;
  if after_position>64 then raise exception 'Invalid signaling cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('position',position,'type',type,'data',data) order by position),'[]'::jsonb)
   into signals from public.chat_peer_signals where session_id=c.id and position>after_position and sender_session<>s;
  return r||jsonb_build_object('signals',signals);
 elsif p_action='WRITE' then
  if kind='offer' and s<>c.initiator_session or kind='answer' and s<>c.target_session then
   raise exception 'Signaling role unavailable' using errcode='42501'; end if;
  if (p_args-'sessionId'-'type'-'data')<>'{}'::jsonb or kind is null or kind not in('offer','answer','candidate')
   or payload is null or jsonb_typeof(payload)<>'object' then raise exception 'Invalid signaling' using errcode='22023'; end if;
  if kind in('offer','answer') then
   if (payload-'sdp')<>'{}'::jsonb or jsonb_typeof(payload->'sdp') is distinct from 'string'
    or length(payload->>'sdp') not between 1 and 65536 or left(payload->>'sdp',3)<>'v=0'
    or payload->>'sdp' !~ 'a=fingerprint:sha-256 [0-9A-Fa-f:]+' then raise exception 'Invalid session description' using errcode='22023'; end if;
   if exists(select 1 from public.chat_peer_signals where session_id=c.id and type=kind)
    or kind='answer' and not exists(select 1 from public.chat_peer_signals where session_id=c.id and type='offer') then
    raise exception 'Signaling already changed' using errcode='42501'; end if;
  else
   if (payload-'candidate'-'sdpMid'-'sdpMLineIndex')<>'{}'::jsonb or not (payload ?& array['candidate','sdpMid','sdpMLineIndex'])
    or jsonb_typeof(payload->'candidate') is distinct from 'string' or length(payload->>'candidate')>2048
    or (payload->>'candidate'<>'' and payload->>'candidate' !~ '^candidate:')
    or jsonb_typeof(payload->'sdpMid') not in('string','null') or length(payload->>'sdpMid')>64
    or jsonb_typeof(payload->'sdpMLineIndex') not in('number','null')
    or (payload->>'sdpMLineIndex' is not null and payload->>'sdpMLineIndex' !~ '^([0-9]|1[0-6])$') then
    raise exception 'Invalid ICE candidate' using errcode='22023'; end if;
  end if;
  select coalesce(max(position),0)+1 into n from public.chat_peer_signals where session_id=c.id;
  if n>64 or (select coalesce(sum(octet_length(data::text)),0) from public.chat_peer_signals where session_id=c.id)+octet_length(payload::text)>196608 then
   raise exception 'Signaling limit reached' using errcode='54000'; end if;
  insert into public.chat_peer_signals values(c.id,n,s,kind,payload); return jsonb_build_object('position',n);
 end if;
 raise exception 'Invalid signaling action' using errcode='22023';
end $$;
revoke all on function public.findback_peer_signal(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.findback_peer_signal(text,jsonb) to authenticated;

-- Preserve canonical Chat behavior behind ONE admission boundary. Renamed
-- implementations retain their bodies/dependencies but have no callable role
-- grants. This avoids maintaining copied versions of exchange/receipt logic.
do $$ declare f record; legacy text; begin
 for f in select * from (values
  ('findback_chat_exchange','text,text,text,jsonb','p_account_id text,p_device_id text,p_action text,p_args jsonb','jsonb','$1,$2,$3,$4','p_device_id'),
  ('findback_chat_receipt_view','text,text,text,jsonb','p_account_id text,p_device_id text,p_conversation_id text,p_message_ids jsonb','jsonb','$1,$2,$3,$4','p_device_id'),
  ('findback_chat_receipt_observe','text,text,text,text,text','p_account_id text,p_device_id text,p_conversation_id text,p_context text,p_message_id text','boolean','$1,$2,$3,$4,$5','p_device_id'),
  ('findback_chat_set_muted','text,text,text,boolean','p_account_id text,p_device_id text,p_conversation_id text,p_muted boolean','boolean','$1,$2,$3,$4','p_device_id'),
  ('findback_reserve_chat_media','text,text,text','p_account_id text,p_message_id text,p_attachment_id text','text','$1,$2,$3','null'),
  ('findback_fetch_chat_media_delivery','text,text','p_account_id text,p_device_id text','jsonb','$1,$2','p_device_id'),
  ('findback_ack_chat_media_delivery','text,text,text','p_account_id text,p_device_id text,p_attachment_id text','integer','$1,$2,$3','p_device_id'),
  ('findback_unregister_device_token_client','text','p_token text','integer','$1','null')
 ) x(name,types,params,result,args,device) loop
  legacy:=f.name||'_authority_legacy_internal';
  execute format('alter function public.%I(%s) rename to %I',f.name,f.types,legacy);
  execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',legacy,f.types);
  execute format('create function public.%I(%s) returns %s language plpgsql volatile security definer set search_path=public,pg_temp as $body$ begin
   perform public.findback_device_admission(%s); return public.%I(%s); end $body$',f.name,f.params,f.result,f.device,legacy,f.args);
  execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',f.name,f.types);
  execute format('grant execute on function public.%I(%s) to authenticated',f.name,f.types);
 end loop;
end $$;

-- REGISTER still returns the canonical device row ID, but can only heartbeat
-- an already key-enrolled installation. No revoked/unbound alias is recreated.
create or replace function public.findback_register_chat_device(p_device_id text,p_platform text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$ declare r text; begin
 perform public.findback_device_admission(p_device_id);
 if p_platform is null or p_platform not in('android','web','ios') then raise exception 'Invalid device' using errcode='22023'; end if;
 update public.chat_devices set last_seen_at=clock_timestamp() where user_id=auth.uid()::text and device_id=p_device_id returning id into r;
 return r;
end $$;

-- User-scoped target reads preserve JWT/session context. The trusted gateway
-- remains the ONLY committer of verified bytes; clients cannot certify hashes.
create function public.findback_chat_media_target_client(p_attachment_id text,p_mode text) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$ declare u text:=auth.uid()::text; begin
 perform public.findback_device_admission();
 if p_mode='READ' then return public.findback_read_chat_media(u,p_attachment_id);
 elsif p_mode='UPLOAD' then return public.findback_chat_media_upload_target(u,p_attachment_id);
 end if;
 raise exception 'Invalid media action' using errcode='22023';
end $$;
create function public.findback_commit_chat_media_for_device(p_actor text,p_session uuid,p_device text,p_enrollment uuid,
 p_attachment_id text,p_generation text,p_object_key text,p_sha text,p_mime text,p_bytes integer,p_width integer,p_height integer)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$ declare ctx jsonb; begin
 perform public.findback_device_lock_internal(p_actor,false);
 ctx:=public.findback_device_context_internal(p_actor,p_session,p_device);
 if p_enrollment is null or p_enrollment is distinct from (ctx->>'generation')::uuid then raise exception 'Device unavailable' using errcode='42501'; end if;
 perform public.findback_commit_chat_media(p_actor,p_attachment_id,p_generation,p_object_key,p_sha,p_mime,p_bytes,p_width,p_height);
end $$;
revoke all on function public.findback_chat_media_target_client(text,text),
 public.findback_commit_chat_media_for_device(text,uuid,text,uuid,text,text,text,text,text,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.findback_chat_media_target_client(text,text) to authenticated;
grant execute on function public.findback_commit_chat_media_for_device(text,uuid,text,uuid,text,text,text,text,text,integer,integer,integer) to service_role;

-- Keep token ownership's single canonical upsert. Bind every refreshed token to
-- its immutable current session/installation/generation in that transaction.
alter function public.findback_register_device_token_client(text,text) rename to findback_register_device_token_client_authority_legacy_internal;
revoke all on function public.findback_register_device_token_client_authority_legacy_internal(text,text) from public,anon,authenticated,service_role;
create function public.findback_register_device_token_client(p_token text,p_platform text) returns void
language plpgsql volatile security definer set search_path=public,pg_temp as $$ declare ctx jsonb; begin
 ctx:=public.findback_device_admission();
 perform public.findback_register_device_token_client_authority_legacy_internal(p_token,p_platform);
 update public.device_tokens set installation_id=ctx->>'deviceId',auth_session_id=(ctx->>'sessionId')::uuid,
  enrollment_generation=(ctx->>'generation')::uuid where user_id=auth.uid()::text and token=p_token;
end $$;
revoke all on function public.findback_register_device_token_client(text,text) from public,anon,authenticated,service_role;
grant execute on function public.findback_register_device_token_client(text,text) to authenticated;

-- A service-side send admission, not an everlasting grant. The dispatch owner
-- rechecks after OAuth immediately before FCM. Already admitted sends cannot be
-- recalled. Missing/legacy bindings are never dispatch-eligible.
create function public.findback_device_push_allowed(p_user text,p_token text) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$ declare d public.device_tokens%rowtype; ctx jsonb; begin
 if p_user is null then return false; end if;
 perform public.findback_device_lock_internal(p_user,false);
 select * into d from public.device_tokens where user_id=p_user and token=p_token;
 if not found or d.installation_id is null or d.auth_session_id is null or d.enrollment_generation is null then return false; end if;
 begin ctx:=public.findback_device_context_internal(p_user,d.auth_session_id,d.installation_id);
 exception when insufficient_privilege then return false; end;
 return d.enrollment_generation=(ctx->>'generation')::uuid;
end $$;
alter function public.findback_chat_external_wake_delivery(text,text,text) rename to findback_chat_external_wake_delivery_authority_legacy_internal;
revoke all on function public.findback_chat_external_wake_delivery_authority_legacy_internal(text,text,text) from public,anon,authenticated,service_role;
create function public.findback_chat_external_wake_delivery(p_wake_id text,p_device_id text,p_claim_token text) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$ declare d public.device_tokens%rowtype; begin
 select * into d from public.device_tokens where id=p_device_id;
 if not found or not public.findback_device_push_allowed(d.user_id,d.token) then return null; end if;
 return public.findback_chat_external_wake_delivery_authority_legacy_internal(p_wake_id,p_device_id,p_claim_token);
end $$;
revoke all on function public.findback_device_push_allowed(text,text),public.findback_chat_external_wake_delivery(text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.findback_device_push_allowed(text,text),public.findback_chat_external_wake_delivery(text,text,text) to service_role;
commit;
