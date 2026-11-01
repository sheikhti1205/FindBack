-- M7-P repair: report-linked and location payloads are CONTENT.
--
-- Three contracts the M7-P capabilities introduced without honouring:
--   1. an Unsend erased the caption but left the shared coordinates;
--   2. mailbox retention erased the caption but left the coordinates and the
--      report reference;
--   3. the report FK (`on delete set null`) rewrote an accepted message when the
--      referenced report was deleted, so a lost ACK could no longer replay: the
--      retry was refused, and the admitted identity silently changed.
--
-- The fixes stay inside the canonical owners. No delivery, receipt authority,
-- relationship epoch or media behaviour changes. Forward migration only.
begin;

-- ---------------------------------------------------------------------------
-- 1. An accepted message keeps its opaque report reference.
--
--    The reference is admission metadata, not a cascade target. Admission
--    already requires the author to be able to read the report at send time, and
--    every later reader resolves availability live (`findback_can_read_post`).
--    Letting the FK null it out rewrites history and breaks idempotent replay,
--    so the reference is kept and the report is never a delete-time authority.
-- ---------------------------------------------------------------------------
alter table public.chat_messages drop constraint if exists chat_messages_context_report_fkey;

-- ---------------------------------------------------------------------------
-- 1b. An unambiguous, lossless payload identity.
--
--     The M7-P digest concatenated `body || key` with no framing, so a body that
--     contains the delimiter text could serialize identically to a different
--     payload (body "hello|ctx:R" with no report vs body "hello" with report R),
--     and coordinates were rounded to six decimals so two distinct fixes could
--     collide. A replay then falsely acknowledged different content as the same
--     accepted send. The identity is now a length-prefixed, versioned
--     serialization with exact IEEE-754 coordinate bytes; it is a hash, so it
--     survives content erasure without retaining content.
-- ---------------------------------------------------------------------------
alter table public.chat_messages add column payload_identity text;

create function public.findback_chat_payload_identity(
 p_body text,p_type text,p_report text,p_lat double precision,p_lng double precision,p_accuracy double precision
) returns text language sql immutable set search_path=public,pg_temp as $$
 select encode(sha256(convert_to(
  'v2|'||octet_length(p_body)||':'||p_body
  ||'|t:'||p_type||'|r:'||octet_length(coalesce(p_report,''))||':'||coalesce(p_report,'')
  ||'|loc:'||coalesce(encode(float8send(p_lat),'hex'),'-')
  ||','||coalesce(encode(float8send(p_lng),'hex'),'-')
  ||','||coalesce(encode(float8send(p_accuracy),'hex'),'-'),'UTF8')),'hex')
$$;
revoke all on function public.findback_chat_payload_identity(text,text,text,double precision,double precision,double precision)
 from public,anon,authenticated;

-- Upgrade only reconstructable payloads, including the context/location shape
-- introduced by the previous M7-P migration. Verify the stored legacy digest
-- BEFORE deriving identity; otherwise already-erased columns would bind empty
-- content as the original send. Keep payload_digest's historical body-only
-- moderation contract (reporting from durable local history after mailbox TTL).
update public.chat_messages set
 payload_identity=public.findback_chat_payload_identity(body,message_type,context_report_id,
  location_lat,location_lng,location_accuracy_m),
 payload_digest=encode(sha256(convert_to(body,'UTF8')),'hex')
where (message_type<>'TEXT' or btrim(body)<>'')
 and (message_type<>'LOCATION' or (location_lat is not null and location_lng is not null))
 and payload_digest=encode(sha256(convert_to(body
  ||case when message_type='LOCATION' then '|loc:'||to_char(location_lat,'FM999999990.000000')
    ||','||to_char(location_lng,'FM999999990.000000')
    ||','||coalesce(to_char(location_accuracy_m,'FM999999990.000'),'unknown') else '' end
  ||case when context_report_id is not null then '|ctx:'||context_report_id else '' end,'UTF8')),'hex');

-- Already-erased legacy context cannot be reconstructed losslessly from the
-- ambiguous old digest. Leave identity NULL and refuse replay rather than
-- acknowledge changed content. No content is recovered or resurrected. The
-- M7-P context migration is still local/LIVE-PENDING; no hosted context rows
-- exist under this programme. New sends always keep a lossless identity.

-- ---------------------------------------------------------------------------
-- 2. Erasure covers every content column, not only `body`.
--
--    A LOCATION message has an empty caption, so `body=''` erased nothing. A
--    report-linked TEXT kept its context id. Enforcing this in one BEFORE
--    trigger covers every writer (Unsend today, any later erasure path) instead
--    of relying on each call site to remember the column list.
-- ---------------------------------------------------------------------------
create or replace function public.findback_chat_erase_unsent_content()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.unsent_at is not null then
  new.body:='';
  new.context_report_id:=null;
  new.location_lat:=null;
  new.location_lng:=null;
  new.location_accuracy_m:=null;
 end if;
 return new;
end $$;
revoke all on function public.findback_chat_erase_unsent_content() from public,anon,authenticated;

drop trigger if exists chat_messages_erase_unsent_content on public.chat_messages;
create trigger chat_messages_erase_unsent_content
 before insert or update on public.chat_messages
 for each row execute function public.findback_chat_erase_unsent_content();

-- Repair content retained by an Unsend BEFORE this trigger existed as well.
-- The backfill above runs first, while any reconstructable coordinates remain.
update public.chat_messages set body=''
 where unsent_at is not null and (body<>'' or context_report_id is not null
  or location_lat is not null or location_lng is not null or location_accuracy_m is not null);

-- ---------------------------------------------------------------------------
-- 3. Mailbox retention erases the same content set.
-- ---------------------------------------------------------------------------
create or replace function public.findback_cleanup_chat_mailbox()
returns integer language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare n integer;
begin
 delete from public.chat_mailbox where acked_at is not null or expires_at<clock_timestamp();
 get diagnostics n=row_count;
 update public.chat_messages m
  set body='',context_report_id=null,location_lat=null,location_lng=null,location_accuracy_m=null
  where (m.body<>'' or m.context_report_id is not null or m.location_lat is not null
   or m.location_lng is not null or m.location_accuracy_m is not null)
   and not exists(select 1 from public.chat_mailbox b where b.message_id=m.id);
 -- Suppression survives for any still-authorized account, not forever after
 -- every audience account has been removed. Report storage is independent.
 delete from public.chat_state_events e where not exists(select 1 from public.chat_state_audience a where a.event_id=e.id);
 return n;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Replay is decided before admission using the separate payload identity.
--
--    Two changes to `findback_chat_send_internal`, both replay-only:
--      * the replay branch now runs BEFORE the report readability check, so a
--        report that became unreadable (moderated, deleted, author lost access)
--        cannot poison a retry of a message that was already accepted;
--      * identity compares the immutable `payload_identity` instead of re-reading the
--        content columns. After an erasure those columns are empty, so the old
--        column comparison refused a legitimate retry and reported an identity
--        conflict for an identical payload.
--    New work still requires a readable report and the observed epoch.
-- ---------------------------------------------------------------------------
create or replace function public.findback_chat_send_internal(
  p_conversation_id text, p_body text, p_client_message_id text, p_message_type text,
  p_expected_epoch text, p_context jsonb default '{}'::jsonb
) returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype; m public.chat_messages%rowtype;
 v_digest text; v_first boolean; v_epoch text; v_blocked boolean; v_peer text;
 v_report text; v_lat double precision; v_lng double precision; v_accuracy double precision;
  v_identity text;
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
 -- Shape and bounds are payload validity, not visibility: a retry of an
 -- accepted message must clear them without re-reading the report.
 if v_report is not null and p_message_type<>'TEXT' then
  raise exception 'Invalid message' using errcode='22023'; end if;
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
 elsif jsonb_typeof(p_context->'location') is not null then
  raise exception 'Invalid message' using errcode='22023'; end if;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 v_digest:=encode(sha256(convert_to(p_body,'UTF8')),'hex');
 -- Length-prefixed body + exact coordinate bytes: injective over the payload, so
 -- digest equality IS payload equality. No delimiter inside a body can be read
 -- as structure and no two distinct fixes round to the same identity.
 v_identity:=public.findback_chat_payload_identity(p_body,p_message_type,v_report,v_lat,v_lng,v_accuracy);
 select * into m from public.chat_messages where id=p_client_message_id;
 if found then
  -- Replay is state-independent and content-independent: a lost response must
  -- stay retryable after the conversation moves on, after an Unsend, and after
  -- the referenced report disappears. The digest already binds body, type,
  -- report context and coordinates, so an identical payload resolves to the
  -- accepted id while any recast is still a conflict.
  -- Reconstructable legacy rows were backfilled above. A NULL identity is
  -- unrecoverable legacy content, never authority for a digest-only recast.
  if m.sender_id=v_uid and m.conversation_id=c.id and m.message_type=p_message_type
   and m.payload_identity=v_identity then
   return m.id; end if;
  raise exception 'Message identity conflict' using errcode='22023';
 end if;
 -- New work must attach a report the author can still read. Live visibility,
 -- not a copied snapshot: every later reader resolves availability again.
 if v_report is not null and not public.findback_can_read_post(v_report) then
  raise exception 'Report unavailable' using errcode='42501'; end if;
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
 insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,payload_identity,
  first_approach,message_type,receipt_connection_epoch,context_report_id,location_lat,location_lng,location_accuracy_m)
 values(p_client_message_id,c.id,v_uid,p_body,v_digest,v_identity,v_first,p_message_type,
  case when c.state='CONNECTED' then c.receipt_connection_epoch else null end,
  v_report,v_lat,v_lng,v_accuracy);
 -- A withheld (blocked) send still echoes to the author and never occupies the
 -- counterpart's request slot; media reservation refuses it separately.
 perform public.findback_enqueue_chat_mailbox(p_client_message_id);
 return p_client_message_id;
end $$;
revoke all on function public.findback_chat_send_internal(text,text,text,text,text,jsonb)
 from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- 5. An irreversible create is bound to the account that asked for it.
--
--    The client refuses early when the session moved, but that check and the
--    RPC dispatch are two separate reads: the SDK resolves the session again
--    when it sends. These wrappers compare the captured account with the
--    session INSIDE the creating statement, so no window exists between the
--    check and the write. They delegate; they are not a second create owner.
-- ---------------------------------------------------------------------------
create function public.findback_create_post_client_bound(
  p_expected_account text, p_type text, p_title text, p_description text, p_category text,
  p_event_date text, p_latitude double precision default null, p_longitude double precision default null,
  p_location_label text default null, p_youtube_url text default null, p_attachment_key text default null
) returns text language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_expected_account is null or p_expected_account is distinct from auth.uid()::text then
  raise exception 'Your account changed. Sign in again to publish this report.' using errcode='42501';
 end if;
 return public.findback_create_post_client(p_type,p_title,p_description,p_category,p_event_date,
  p_latitude,p_longitude,p_location_label,p_youtube_url,p_attachment_key);
end $$;
revoke all on function public.findback_create_post_client_bound(
  text,text,text,text,text,text,double precision,double precision,text,text,text) from public,anon;
grant execute on function public.findback_create_post_client_bound(
  text,text,text,text,text,text,double precision,double precision,text,text,text) to authenticated;

create function public.findback_create_post_client_multi_bound(
  p_expected_account text, p_type text, p_title text, p_description text, p_category text,
  p_event_date text, p_attachment_keys text[] default '{}',
  p_latitude double precision default null, p_longitude double precision default null,
  p_location_label text default null, p_youtube_url text default null
) returns text language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_expected_account is null or p_expected_account is distinct from auth.uid()::text then
  raise exception 'Your account changed. Sign in again to publish this report.' using errcode='42501';
 end if;
 return public.findback_create_post_client_multi(p_type,p_title,p_description,p_category,p_event_date,
  p_attachment_keys,p_latitude,p_longitude,p_location_label,p_youtube_url);
end $$;
revoke all on function public.findback_create_post_client_multi_bound(
  text,text,text,text,text,text,text[],double precision,double precision,text,text) from public,anon;
grant execute on function public.findback_create_post_client_multi_bound(
  text,text,text,text,text,text,text[],double precision,double precision,text,text) to authenticated;

commit;
