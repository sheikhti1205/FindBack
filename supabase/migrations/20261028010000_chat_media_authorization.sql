-- Private chat media foundation. No direct client Storage operation is allowed:
-- the authenticated media gateway must verify bytes and call the service-only
-- commit/read boundaries below. This migration alone does not enable media UI.
begin;
create table public.chat_media_attachments (
 id text primary key check(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 message_id text not null references public.chat_messages(id) on delete cascade,
 author_id text not null references public.users(id) on delete cascade,
 conversation_id text not null references public.chat_conversations(id) on delete cascade,
 connection_epoch text not null,
 block_epoch text not null,
 generation text not null default gen_random_uuid()::text,
 object_key text not null unique,
 state text not null default 'PENDING' check(state in('PENDING','ATTACHED')),
 sha256 text check(sha256 ~ '^[0-9a-f]{64}$'),
 mime text check(mime in('image/jpeg','image/png','image/webp')),
 byte_size integer check(byte_size between 1 and 20971520),
 width integer check(width between 1 and 8192),
 height integer check(height between 1 and 8192),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '1 hour',
 check((state='PENDING' and sha256 is null and mime is null and byte_size is null and width is null and height is null)
  or (state='ATTACHED' and sha256 is not null and mime is not null and byte_size is not null and width is not null and height is not null))
);
create index chat_media_message_idx on public.chat_media_attachments(message_id);
create index chat_media_expiry_idx on public.chat_media_attachments(expires_at);
alter table public.chat_media_attachments enable row level security;
revoke all on public.chat_media_attachments from public,anon,authenticated,service_role;
-- Survives every ordinary FK cascade, with no user/conversation foreign keys.
-- Storage deletion is API-first. Keep the opaque key until the worker confirms
-- removal; wait an hour for already-admitted, bounded gateway uploads to finish.
create table public.chat_media_cleanup_queue (
 id bigint generated always as identity primary key,
 bucket_id text not null check(bucket_id in('findback-chat-media','findback-chat-moderation-evidence')),
 media_id text not null,
 generation text not null,
 object_key text not null,
 reason text not null default 'METADATA_DELETE' check(reason in('EXPIRED','COMMIT_FAILED','METADATA_DELETE','GENERATION_REPLACED','EVIDENCE_EXPIRED')),
 queued_at timestamptz not null default clock_timestamp(),
 not_before timestamptz not null default clock_timestamp()+interval '1 hour',
 unique(bucket_id,object_key,generation)
);
alter table public.chat_media_cleanup_queue enable row level security;
revoke all on public.chat_media_cleanup_queue from public,anon,authenticated,service_role;
create function public.findback_chat_media_queue_deleted() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.chat_media_cleanup_queue(bucket_id,media_id,generation,object_key)
 values('findback-chat-media',old.id,old.generation,old.object_key)
 on conflict(bucket_id,object_key,generation) do nothing;
 return old;
end $$;
revoke all on function public.findback_chat_media_queue_deleted() from public,anon,authenticated,service_role;
create trigger chat_media_preserve_cleanup before delete on public.chat_media_attachments
 for each row execute function public.findback_chat_media_queue_deleted();
-- Restrictive, so an unrelated broad permissive Storage policy cannot admit
-- private objects. No signed URLs/list/upsert/download for ordinary clients.
create policy findback_chat_media_gateway_only on storage.objects as restrictive
 for all to anon,authenticated using(bucket_id<>'findback-chat-media')
 with check(bucket_id<>'findback-chat-media');
create policy findback_chat_evidence_gateway_only on storage.objects as restrictive
 for all to anon,authenticated using(bucket_id<>'findback-chat-moderation-evidence')
 with check(bucket_id<>'findback-chat-moderation-evidence');

-- A pure eligibility predicate, intentionally private. Public endpoints must
-- bind p_actor to their verified JWT; callers cannot choose somebody else's ID.
create function public.findback_chat_media_visible_internal(p_actor text,p_attachment text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.chat_media_attachments a
  join public.chat_messages m on m.id=a.message_id
  join public.chat_conversations c on c.id=a.conversation_id
  join public.chat_message_audience u on u.message_id=m.id and u.user_id=p_actor
  where a.id=p_attachment and a.state='ATTACHED' and a.expires_at>statement_timestamp()
   and p_actor in(c.user_a,c.user_b) and m.unsent_at is null
   and not public.findback_is_blocked_pair(c.user_a,c.user_b)
   and not exists(select 1 from public.chat_state_events e where e.actor_id=p_actor and e.conversation_id=c.id
    and ((e.kind='DELETE_FOR_ME' and e.message_id=m.id) or (e.kind='CLEAR_FOR_ME' and e.through_sequence>=m.event_sequence))))
$$;
revoke all on function public.findback_chat_media_visible_internal(text,text) from public,anon,authenticated,service_role;

create function public.findback_reserve_chat_media(p_account_id text,p_message_id text,p_attachment_id text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype; m public.chat_messages%rowtype;
 a public.chat_media_attachments%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is distinct from v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 if p_attachment_id is null or p_attachment_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception 'Invalid media identity' using errcode='22023'; end if;
 -- Serialize identity reuse across conversations/accounts as well as retries.
 perform pg_advisory_xact_lock(hashtextextended('chat-media-id:'||p_attachment_id,0));
 select cv.* into c from public.chat_conversations cv join public.chat_messages msg on msg.conversation_id=cv.id
  where msg.id=p_message_id and v_uid in(cv.user_a,cv.user_b) for update of cv;
 if not found then raise exception 'Media unavailable' using errcode='42501'; end if;
 select * into m from public.chat_messages where id=p_message_id;
 if m.sender_id<>v_uid or m.unsent_at is not null or c.state<>'CONNECTED'
  or m.receipt_connection_epoch is distinct from c.receipt_connection_epoch
  or c.receipt_connection_epoch is null or public.findback_is_blocked_pair(c.user_a,c.user_b)
  or exists(select 1 from public.chat_state_events e where e.actor_id=v_uid and e.conversation_id=c.id
   and ((e.kind='DELETE_FOR_ME' and e.message_id=m.id) or (e.kind='CLEAR_FOR_ME' and e.through_sequence>=m.event_sequence))) then
  raise exception 'Media unavailable' using errcode='42501'; end if;
 select * into a from public.chat_media_attachments where id=p_attachment_id for update;
 if found then
  if a.message_id<>m.id or a.author_id<>v_uid then
   raise exception 'Media unavailable' using errcode='42501'; end if;
  if a.state='ATTACHED' then
   if a.expires_at<=clock_timestamp() then raise exception 'Media unavailable' using errcode='42501'; end if;
   return a.id;
  end if;
  if a.connection_epoch is distinct from c.receipt_connection_epoch
     or a.block_epoch is distinct from c.receipt_block_epoch
     or a.expires_at<=clock_timestamp() then
   insert into public.chat_media_cleanup_queue(bucket_id,media_id,generation,object_key,reason)
   values('findback-chat-media',a.id,a.generation,a.object_key,'GENERATION_REPLACED')
   on conflict(bucket_id,object_key,generation) do nothing;
   update public.chat_media_attachments set
    connection_epoch=c.receipt_connection_epoch,block_epoch=c.receipt_block_epoch,
    generation=gen_random_uuid()::text,object_key='attachments/'||gen_random_uuid()::text,
    created_at=clock_timestamp(),expires_at=clock_timestamp()+interval '1 hour'
    where id=a.id;
  end if;
  return a.id;
 end if;
 -- Limit both per-message fanout and staged account work. The conversation lock
 -- serializes the former; account-wide admission is advisory-serialized.
 perform pg_advisory_xact_lock(hashtextextended('chat-media-reserve:'||v_uid,0));
 if (select count(*) from public.chat_media_attachments where message_id=m.id)>=4
  or (select count(*) from public.chat_media_attachments where author_id=v_uid and state='PENDING' and expires_at>clock_timestamp())>=8 then
  raise exception 'Media limit reached' using errcode='54000'; end if;
 insert into public.chat_media_attachments(id,message_id,author_id,conversation_id,connection_epoch,block_epoch,object_key)
 values(p_attachment_id,m.id,v_uid,c.id,c.receipt_connection_epoch,c.receipt_block_epoch,'attachments/'||gen_random_uuid()::text);
 return p_attachment_id;
end $$;
revoke all on function public.findback_reserve_chat_media(text,text,text) from public,anon;
grant execute on function public.findback_reserve_chat_media(text,text,text) to authenticated;

-- Return only to the verified gateway, never via a client RPC or signed URL.
-- The pair lock matches End/block/unsend. Holding it in SQL defines the admission
-- point; it does not promise to retract bytes already delivered by the gateway.
create function public.findback_chat_media_upload_target(p_actor text,p_attachment_id text)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a public.chat_media_attachments%rowtype; c public.chat_conversations%rowtype; m public.chat_messages%rowtype;
begin
 select cv.* into c from public.chat_conversations cv join public.chat_media_attachments x on x.conversation_id=cv.id
  where x.id=p_attachment_id for update of cv;
 if not found then raise exception 'Media unavailable' using errcode='42501'; end if;
 select * into a from public.chat_media_attachments where id=p_attachment_id for update;
 select * into m from public.chat_messages where id=a.message_id;
 if a.author_id is distinct from p_actor or a.expires_at<=clock_timestamp() or m.unsent_at is not null
  or c.state<>'CONNECTED' or c.receipt_connection_epoch is distinct from a.connection_epoch
  or c.receipt_block_epoch is distinct from a.block_epoch or public.findback_is_blocked_pair(c.user_a,c.user_b)
  or exists(select 1 from public.chat_state_events e where e.actor_id=p_actor and e.conversation_id=c.id
   and ((e.kind='DELETE_FOR_ME' and e.message_id=m.id) or (e.kind='CLEAR_FOR_ME' and e.through_sequence>=m.event_sequence))) then
  raise exception 'Media unavailable' using errcode='42501'; end if;
  return jsonb_build_object('bucket','findback-chat-media','id',a.id,'generation',a.generation,
   'objectKey',a.object_key,'expiresAt',a.expires_at);
end $$;
revoke all on function public.findback_chat_media_upload_target(text,text) from public,anon,authenticated;
grant execute on function public.findback_chat_media_upload_target(text,text) to service_role;

-- p_sha/mime/dimensions/size are assertions by the trusted byte-processing
-- gateway, NOT client claims. Storage upload must be immutable (upsert false).
-- Bind the generation actually uploaded. A late old upload/cleanup cannot
-- mutate a fresh reservation even if the caller reuses its attachment UUID.
create function public.findback_commit_chat_media(p_actor text,p_attachment_id text,p_generation text,p_object_key text,p_sha text,p_mime text,p_bytes integer,p_width integer,p_height integer)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a public.chat_media_attachments%rowtype;
begin
 perform public.findback_chat_media_upload_target(p_actor,p_attachment_id);
 select * into a from public.chat_media_attachments where id=p_attachment_id for update;
 if a.generation is distinct from p_generation or a.object_key is distinct from p_object_key then
  raise exception 'Media unavailable' using errcode='42501'; end if;
 if a.state='ATTACHED' then
  if a.sha256 is distinct from p_sha or a.mime is distinct from p_mime or a.byte_size is distinct from p_bytes
   or a.width is distinct from p_width or a.height is distinct from p_height then
   raise exception 'Media unavailable' using errcode='42501'; end if;
  return;
 end if;
 update public.chat_media_attachments set state='ATTACHED',sha256=p_sha,mime=p_mime,byte_size=p_bytes,width=p_width,height=p_height,
  expires_at=clock_timestamp()+interval '30 days' where id=p_attachment_id;
end $$;
revoke all on function public.findback_commit_chat_media(text,text,text,text,text,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.findback_commit_chat_media(text,text,text,text,text,text,integer,integer,integer) to service_role;

create function public.findback_read_chat_media(p_actor text,p_attachment_id text)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare c_id text; a public.chat_media_attachments%rowtype;
begin
 select conversation_id into c_id from public.chat_media_attachments where id=p_attachment_id;
 perform 1 from public.chat_conversations where id=c_id for update;
 if not public.findback_chat_media_visible_internal(p_actor,p_attachment_id) then return null; end if;
 select * into a from public.chat_media_attachments where id=p_attachment_id;
 return jsonb_build_object('bucket','findback-chat-media','id',a.id,'messageId',a.message_id,
  'generation',a.generation,'objectKey',a.object_key,'sha256',a.sha256,
  'mime',a.mime,'bytes',a.byte_size,'width',a.width,'height',a.height,'expiresAt',a.expires_at);
end $$;
revoke all on function public.findback_read_chat_media(text,text) from public,anon,authenticated;
grant execute on function public.findback_read_chat_media(text,text) to service_role;

-- Capture the exact attached-media set in the report INSERT transaction. This
-- table deliberately has no attachment FK or reporter identity: later unsend,
-- metadata deletion and account deletion cannot rewrite report provenance.
create table public.chat_media_report_sources (
 report_id text not null references public.content_reports(id) on delete cascade,
 source_attachment_id text not null,
 source_message_id text not null,
 source_generation text not null,
 source_object_key text not null,
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 mime text not null check(mime in('image/jpeg','image/png','image/webp')),
 byte_size integer not null check(byte_size between 1 and 20971520),
 width integer not null check(width between 1 and 8192),
 height integer not null check(height between 1 and 8192),
 captured_at timestamptz not null default clock_timestamp(),
 primary key(report_id,source_attachment_id)
);
alter table public.chat_media_report_sources enable row level security;
revoke all on public.chat_media_report_sources from public,anon,authenticated,service_role;

-- One immutable source identity is shared by report capture and API-first
-- cleanup, including after FK cascades remove ordinary attachment metadata.
create function public.findback_chat_media_source_lock_key(p_id text,p_generation text,p_key text)
returns bigint language sql immutable set search_path=public,pg_temp as $$
 select hashtextextended('chat-media-source:'||jsonb_build_array(p_id,p_generation,p_key)::text,0)
$$;
revoke all on function public.findback_chat_media_source_lock_key(text,text,text) from public,anon,authenticated,service_role;

create function public.findback_capture_chat_media_report_sources() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare source record;
begin
 if new.target_type='MESSAGE' then
  if current_setting('transaction_isolation')<>'read committed' then
   raise exception 'Media capture requires READ COMMITTED' using errcode='25001';
  end if;
  for source in select a.id,a.generation,a.object_key from public.chat_media_attachments a
   where a.message_id=new.target_id and a.state='ATTACHED' and a.expires_at>clock_timestamp()
   order by a.id,a.generation,a.object_key
  loop
   perform pg_advisory_xact_lock(public.findback_chat_media_source_lock_key(source.id,source.generation,source.object_key));
   -- A separate volatile statement obtains a fresh READ COMMITTED snapshot
   -- after waiting. Never capture an expired/deleted pre-lock row. The lock
   -- remains held until the report and its sources become visible together.
   insert into public.chat_media_report_sources(report_id,source_attachment_id,source_message_id,
    source_generation,source_object_key,sha256,mime,byte_size,width,height)
   select new.id,a.id,a.message_id,a.generation,a.object_key,a.sha256,a.mime,a.byte_size,a.width,a.height
    from public.chat_media_attachments a
    where a.id=source.id and a.generation=source.generation and a.object_key=source.object_key
     and a.message_id=new.target_id and a.state='ATTACHED' and a.expires_at>clock_timestamp();
  end loop;
 end if;
 return new;
end $$;
revoke all on function public.findback_capture_chat_media_report_sources() from public,anon,authenticated,service_role;
create trigger chat_media_capture_report_sources after insert on public.content_reports
 for each row execute function public.findback_capture_chat_media_report_sources();

-- A report's media copy has a different owner and lifetime from ordinary chat
-- media. It is never linked by an FK to the attachment row: unsend, ordinary
-- expiry and attachment deletion cannot erase captured moderation evidence.
create table public.chat_media_report_evidence (
 id text primary key check(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 report_id text not null references public.content_reports(id) on delete cascade,
 source_attachment_id text not null,
 source_message_id text not null,
 generation text not null default gen_random_uuid()::text,
 object_key text not null unique,
 state text not null default 'PENDING' check(state in('PENDING','ATTACHED')),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 mime text not null check(mime in('image/jpeg','image/png','image/webp')),
 byte_size integer not null check(byte_size between 1 and 20971520),
 width integer not null check(width between 1 and 8192),
 height integer not null check(height between 1 and 8192),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 unique(report_id,source_attachment_id)
);
create index chat_media_report_evidence_expiry_idx on public.chat_media_report_evidence(expires_at);
alter table public.chat_media_report_evidence enable row level security;
revoke all on public.chat_media_report_evidence from public,anon,authenticated,service_role;

create function public.findback_chat_media_queue_evidence_deleted() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.chat_media_cleanup_queue(bucket_id,media_id,generation,object_key,reason)
 values('findback-chat-moderation-evidence',old.id,old.generation,old.object_key,'EVIDENCE_EXPIRED')
 on conflict(bucket_id,object_key,generation) do nothing;
 return old;
end $$;
revoke all on function public.findback_chat_media_queue_evidence_deleted() from public,anon,authenticated,service_role;
create trigger chat_media_evidence_preserve_cleanup before delete on public.chat_media_report_evidence
 for each row execute function public.findback_chat_media_queue_evidence_deleted();

create function public.findback_chat_media_expire_report_copy() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if old.evidence_erased_at is null and new.evidence_erased_at is not null then
  delete from public.chat_media_report_evidence where report_id=new.id;
  delete from public.chat_media_report_sources where report_id=new.id;
 end if;
 return new;
end $$;
revoke all on function public.findback_chat_media_expire_report_copy() from public,anon,authenticated,service_role;
create trigger chat_media_evidence_expiry after update of evidence_erased_at on public.content_reports
 for each row execute function public.findback_chat_media_expire_report_copy();

-- Called only by the trusted gateway. While linked, p_actor is the authenticated
-- reporter; after account unlinking, NULL denotes service-owned queued work. It
-- returns both private object paths without exposing either bucket to a client.
create function public.findback_reserve_chat_media_report_evidence(
 p_actor text,p_report_id text,p_source_attachment_id text,p_evidence_id text
) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare r public.content_reports%rowtype; s public.chat_media_report_sources%rowtype;
 e public.chat_media_report_evidence%rowtype;
begin
 if p_evidence_id is null or p_evidence_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception 'Invalid media identity' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('chat-media-evidence-id:'||p_evidence_id,0));
 select * into r from public.content_reports where id=p_report_id for update;
 if not found or r.target_type<>'MESSAGE'
   or r.evidence_erased_at is not null or r.evidence_expires_at::timestamptz<=clock_timestamp() then
  raise exception 'Report evidence unavailable' using errcode='42501'; end if;
 -- Before unlinking, the gateway must carry the authenticated reporter. After
 -- unlinking, only the service-owned NULL authority may continue captured work;
 -- accepting another user id would turn it into a guessable bearer authority.
 if (r.reporter_user_id is null and p_actor is not null)
    or (r.reporter_user_id is not null and r.reporter_user_id is distinct from p_actor) then
  raise exception 'Report evidence unavailable' using errcode='42501'; end if;
 select * into s from public.chat_media_report_sources where report_id=r.id
  and source_attachment_id=p_source_attachment_id for update;
 if not found then raise exception 'Report evidence unavailable' using errcode='42501'; end if;
 select * into e from public.chat_media_report_evidence
  where report_id=r.id and source_attachment_id=s.source_attachment_id for update;
 if found then
   if e.id is distinct from p_evidence_id then
    raise exception 'Report evidence unavailable' using errcode='42501'; end if;
 else
   insert into public.chat_media_report_evidence(id,report_id,source_attachment_id,source_message_id,
    object_key,sha256,mime,byte_size,width,height,expires_at)
   values(p_evidence_id,r.id,s.source_attachment_id,s.source_message_id,'evidence/'||gen_random_uuid()::text,
    s.sha256,s.mime,s.byte_size,s.width,s.height,r.evidence_expires_at::timestamptz)
   returning * into e;
  end if;
  return jsonb_build_object('id',e.id,'generation',e.generation,
   'sourceBucket','findback-chat-media','sourceObjectKey',s.source_object_key,
  'bucket','findback-chat-moderation-evidence','objectKey',e.object_key,
  'sha256',e.sha256,'mime',e.mime,'bytes',e.byte_size,'width',e.width,'height',e.height,
  'expiresAt',e.expires_at);
end $$;
revoke all on function public.findback_reserve_chat_media_report_evidence(text,text,text,text) from public,anon,authenticated;
grant execute on function public.findback_reserve_chat_media_report_evidence(text,text,text,text) to service_role;

create function public.findback_commit_chat_media_report_evidence(
 p_evidence_id text,p_generation text,p_object_key text,p_sha text,p_mime text,
 p_bytes integer,p_width integer,p_height integer
) returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare e public.chat_media_report_evidence%rowtype; r public.content_reports%rowtype; v_report_id text;
begin
 -- Read the immutable parent key without a row lock, then use the same
 -- report -> evidence order as reservation and report expiry.
 select report_id into v_report_id from public.chat_media_report_evidence where id=p_evidence_id;
 if not found then raise exception 'Report evidence unavailable' using errcode='42501'; end if;
 select * into r from public.content_reports where id=v_report_id for update;
 if not found or r.evidence_erased_at is not null then
  raise exception 'Report evidence unavailable' using errcode='42501'; end if;
 select * into e from public.chat_media_report_evidence where id=p_evidence_id and report_id=r.id for update;
 if not found or e.expires_at<=clock_timestamp()
   or e.generation is distinct from p_generation or e.object_key is distinct from p_object_key
  or e.sha256 is distinct from p_sha or e.mime is distinct from p_mime or e.byte_size is distinct from p_bytes
  or e.width is distinct from p_width or e.height is distinct from p_height then
  raise exception 'Report evidence unavailable' using errcode='42501'; end if;
 if e.state='PENDING' then update public.chat_media_report_evidence set state='ATTACHED' where id=e.id; end if;
end $$;
revoke all on function public.findback_commit_chat_media_report_evidence(text,text,text,text,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.findback_commit_chat_media_report_evidence(text,text,text,text,text,integer,integer,integer) to service_role;

create function public.findback_read_chat_media_report_evidence(p_actor text,p_evidence_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare e public.chat_media_report_evidence%rowtype;
begin
 if not exists(select 1 from public.user_roles ur where ur.user_id=p_actor and ur.role='ADMIN')
  and not exists(select 1 from public.user_roles ur join public.user_role_capabilities uc on uc.user_id=ur.user_id
   where ur.user_id=p_actor and ur.role='MODERATOR' and uc.capability='reports_review') then
  raise exception 'Report evidence unavailable' using errcode='42501'; end if;
 select * into e from public.chat_media_report_evidence where id=p_evidence_id and state='ATTACHED'
  and expires_at>statement_timestamp();
 if not found then return null; end if;
 return jsonb_build_object('bucket','findback-chat-moderation-evidence','id',e.id,'reportId',e.report_id,
  'generation',e.generation,'objectKey',e.object_key,'sha256',e.sha256,'mime',e.mime,
  'bytes',e.byte_size,'width',e.width,'height',e.height,'expiresAt',e.expires_at);
end $$;
revoke all on function public.findback_read_chat_media_report_evidence(text,text) from public,anon,authenticated;
grant execute on function public.findback_read_chat_media_report_evidence(text,text) to service_role;

-- Cleanup is storage-API-first and idempotent. These return opaque server paths
-- only to a trusted worker; they never DELETE storage.objects directly. Expiry
-- is monotone: an expired reservation cannot be finalized or extended. The
-- gateway MUST cap an upload below one hour, including its Storage write.
create function public.findback_chat_media_source_cleanup_blocked(
 p_media_id text,p_generation text,p_object_key text
) returns boolean language sql volatile security definer set search_path=public,pg_temp as $$
 -- A queued stale record must never override live exact-generation metadata.
 select exists(select 1 from public.chat_media_attachments a
  where a.id=p_media_id and a.generation=p_generation and a.object_key=p_object_key
   and a.expires_at>clock_timestamp()-interval '1 hour') or exists(
  select 1 from public.chat_media_report_sources s
  join public.content_reports r on r.id=s.report_id
  where s.source_attachment_id=p_media_id and s.source_generation=p_generation
   and s.source_object_key=p_object_key and r.evidence_erased_at is null
   and r.evidence_expires_at::timestamptz>clock_timestamp()
   and not exists(
    select 1 from public.chat_media_report_evidence e
    where e.report_id=s.report_id and e.source_attachment_id=s.source_attachment_id
     and e.state='ATTACHED' and e.expires_at>clock_timestamp()
     and e.sha256=s.sha256 and e.mime=s.mime and e.byte_size=s.byte_size
     and e.width=s.width and e.height=s.height
   )
 )
$$;
revoke all on function public.findback_chat_media_source_cleanup_blocked(text,text,text) from public,anon,authenticated,service_role;

create function public.findback_chat_media_cleanup_candidates(p_limit integer default 100)
returns table(bucket_id text,media_id text,generation text,object_key text)
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare due record; emitted integer:=0; cap integer:=greatest(0,least(coalesce(p_limit,100),100));
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'Media cleanup requires READ COMMITTED' using errcode='25001';
 end if;
 if cap=0 then return; end if;
 for due in select d.bucket_id,d.media_id,d.generation,d.object_key from (
  select 'findback-chat-media'::text as bucket_id,a.id as media_id,a.generation,a.object_key
   from public.chat_media_attachments a where a.expires_at<=clock_timestamp()-interval '1 hour'
  union
  select q.bucket_id,q.media_id,q.generation,q.object_key from public.chat_media_cleanup_queue q
   where q.not_before<=clock_timestamp()
 ) d order by d.bucket_id,d.object_key
 loop
  if due.bucket_id='findback-chat-media' then
   if not pg_try_advisory_xact_lock(public.findback_chat_media_source_lock_key(due.media_id,due.generation,due.object_key)) then
    continue;
   end if;
   -- Check only after the common fence. In-flight captures either hold it or
   -- are now committed/visible. Later captures re-read expired/deleted metadata
   -- and cannot add a new source after this pre-Storage authorization.
   if public.findback_chat_media_source_cleanup_blocked(due.media_id,due.generation,due.object_key) then continue; end if;
  end if;
  bucket_id:=due.bucket_id; media_id:=due.media_id; generation:=due.generation; object_key:=due.object_key;
  return next;
  emitted:=emitted+1;
  if emitted>=cap then return; end if;
 end loop;
end
$$;
revoke all on function public.findback_chat_media_cleanup_candidates(integer) from public,anon,authenticated;
grant execute on function public.findback_chat_media_cleanup_candidates(integer) to service_role;
create function public.findback_chat_media_cleanup_done(
 p_bucket_id text,p_media_id text,p_generation text,p_object_key text
)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'Media cleanup requires READ COMMITTED' using errcode='25001';
 end if;
 if p_bucket_id not in('findback-chat-media','findback-chat-moderation-evidence') then
  raise exception 'Unknown media bucket' using errcode='22023'; end if;
 if p_bucket_id='findback-chat-media' then
  if not pg_try_advisory_xact_lock(public.findback_chat_media_source_lock_key(p_media_id,p_generation,p_object_key)) then return; end if;
  if public.findback_chat_media_source_cleanup_blocked(p_media_id,p_generation,p_object_key) then return; end if;
 end if;
 if not exists(select 1 from public.chat_media_attachments a where p_bucket_id='findback-chat-media'
   and a.id=p_media_id and a.generation=p_generation and a.object_key=p_object_key
   and a.expires_at<=clock_timestamp()-interval '1 hour')
  and not exists(select 1 from public.chat_media_cleanup_queue q where q.bucket_id=p_bucket_id
   and q.media_id=p_media_id and q.generation=p_generation and q.object_key=p_object_key
   and q.not_before<=clock_timestamp()) then return; end if;
 delete from public.chat_media_attachments where p_bucket_id='findback-chat-media'
  and id=p_media_id and generation=p_generation and object_key=p_object_key
  and expires_at<=clock_timestamp()-interval '1 hour';
 delete from public.chat_media_cleanup_queue where bucket_id=p_bucket_id and media_id=p_media_id
  and generation=p_generation and object_key=p_object_key;
end
$$;
revoke all on function public.findback_chat_media_cleanup_done(text,text,text,text) from public,anon,authenticated;
grant execute on function public.findback_chat_media_cleanup_done(text,text,text,text) to service_role;
commit;
