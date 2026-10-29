-- Chat R4 consolidation (forward-only; historical migrations stay immutable).
--
-- Canonical contract: `CHAT-R4-CANONICAL.md` / owner packet 01.
--   * conversation mode is REQUEST | CONNECTED only; blocking is the app-wide
--     directional user_blocks relation and never a conversation mode;
--   * one member-state owner per (conversation,user) for projection, private
--     dismiss/hide and receipt progress;
--   * one preferences owner; no server-side client outbox; no second
--     personal-deletion ledger (chat_state_events already owns it);
--   * one canonical exchange RPC with no `_041`/`_044_internal` chain.
--
-- This migration refuses to run if any chat row, private chat Storage object or
-- message-moderation record exists. Production emptiness was re-verified before
-- authoring, but the gate is the authority: if data appeared, preserve it and
-- write a non-destructive migration instead of deleting it here.
begin;

-- ---------------------------------------------------------------------------
-- 1. Safety gate
-- ---------------------------------------------------------------------------
do $$
declare
  v_tables text[] := array[
    'chat_conversations','chat_devices','chat_messages','chat_mailbox','chat_outbox',
    'chat_state_events','chat_state_audience','chat_message_audience','chat_participant_views',
    'chat_read_progress','chat_receipt_preferences','chat_deleted_for_me','chat_external_wakes',
    'chat_external_wake_devices','chat_media_attachments','chat_media_cleanup_queue',
    'chat_media_delivery_receipts','chat_media_report_sources','chat_media_report_evidence'];
  v_table text;
  v_n bigint;
  v_found text[] := '{}';
begin
  foreach v_table in array v_tables loop
    if to_regclass('public.'||v_table) is null then
      raise exception 'Chat R4 consolidation expected legacy table public.%', v_table using errcode='P0001';
    end if;
    execute format('select count(*) from public.%I', v_table) into v_n;
    if v_n > 0 then v_found := v_found || (v_table||'='||v_n); end if;
  end loop;
  select count(*) into v_n from storage.objects
   where bucket_id in ('findback-chat-media','findback-chat-moderation-evidence');
  if v_n > 0 then v_found := v_found || ('chat_storage_objects='||v_n); end if;
  select count(*) into v_n from public.content_reports
   where target_type = 'MESSAGE' or target_message_id is not null;
  if v_n > 0 then v_found := v_found || ('message_reports='||v_n); end if;
  -- A view or publication over chat tables would make a destructive reset
  -- rewrite another owner's object; refuse instead of dropping through it.
  select count(*) into v_n from pg_views
   where schemaname not in ('pg_catalog','information_schema')
     and definition ~* '\mchat_(conversations|messages|mailbox|devices|state_events)\M';
  if v_n > 0 then v_found := v_found || ('dependent_views='||v_n); end if;
  select count(*) into v_n from pg_publication_tables where tablename like 'chat\_%';
  if v_n > 0 then v_found := v_found || ('chat_publications='||v_n); end if;
  if array_length(v_found, 1) > 0 then
    raise exception 'Chat R4 consolidation refused: production chat data/evidence exists (%)',
      array_to_string(v_found, ', ') using errcode='P0001';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Retire legacy triggers that live on non-chat tables
-- ---------------------------------------------------------------------------
drop trigger if exists chat_block_fence on public.user_blocks;
drop trigger if exists chat_own_block_view on public.user_blocks;
drop trigger if exists chat_receipt_block_transition on public.user_blocks;
drop trigger if exists chat_wake_block_boundary on public.user_blocks;
drop trigger if exists chat_media_capture_report_sources on public.content_reports;
drop trigger if exists chat_media_evidence_expiry on public.content_reports;

-- ---------------------------------------------------------------------------
-- 3. Conversation vocabulary: REQUEST | CONNECTED only
-- ---------------------------------------------------------------------------
alter table public.chat_conversations drop constraint if exists chat_conversations_state_check;
update public.chat_conversations
  set state = 'REQUEST', initiated_by = null, request_nudged = false
  where state in ('BLOCKED','ENDED');
alter table public.chat_conversations
  add constraint chat_conversations_state_check check (state in ('REQUEST','CONNECTED'));
alter table public.chat_conversations drop column if exists ended_at;
alter table public.chat_conversations drop column if exists ended_by;

-- ---------------------------------------------------------------------------
-- 4. Remove duplicated truths
-- ---------------------------------------------------------------------------
-- The durable outbox is client-local; a server copy could only diverge from it.
drop table public.chat_outbox;
-- Personal deletion is already a chat_state_events kind; a second ledger would
-- let the two disagree after replay/restore.
drop table public.chat_deleted_for_me;

-- One member-state owner: viewer projection + private hide/decline + receipt
-- progress. Replaces chat_participant_views and chat_read_progress.
create table public.chat_member_state (
  conversation_id text not null references public.chat_conversations(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  mode text not null default 'REQUEST' check (mode in ('REQUEST','CONNECTED')),
  request_direction text not null default 'NONE' check (request_direction in ('NONE','INCOMING','OUTGOING')),
  request_epoch text,
  hidden boolean not null default false,
  declined boolean not null default false,
  revision bigint not null default 1 check (revision > 0 and revision <= 9007199254740991),
  read_context text,
  read_through bigint not null default 0 check (read_through >= 0 and read_through <= 9007199254740991),
  primary key (conversation_id, user_id),
  check (mode <> 'CONNECTED' or request_direction = 'NONE')
);
create index chat_member_state_owner on public.chat_member_state(user_id, conversation_id);
alter table public.chat_member_state enable row level security;
revoke all on public.chat_member_state from public, anon, authenticated;

drop table public.chat_participant_views;
drop table public.chat_read_progress;

-- One preferences owner (renamed in place, so the consent-epoch trigger and
-- column defaults stay intact).
alter table public.chat_receipt_preferences rename to chat_preferences;

-- ---------------------------------------------------------------------------
-- 5. Canonical internal owners
-- ---------------------------------------------------------------------------
create or replace function public.findback_chat_publish_member(
  p_id text, p_user text, p_mode text, p_direction text, p_epoch text
) returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.chat_conversations where id=p_id and p_user in(user_a,user_b)) then
    raise exception 'Conversation unavailable' using errcode='42501';
  end if;
  insert into public.chat_member_state(conversation_id,user_id,mode,request_direction,request_epoch)
  values(p_id,p_user,p_mode,p_direction,p_epoch)
  on conflict(conversation_id,user_id) do update set
    mode=excluded.mode, request_direction=excluded.request_direction, request_epoch=excluded.request_epoch,
    declined=case when chat_member_state.request_epoch is distinct from excluded.request_epoch then false
      else chat_member_state.declined end,
    revision=chat_member_state.revision+1
  where (chat_member_state.mode,chat_member_state.request_direction,chat_member_state.request_epoch)
    is distinct from (excluded.mode,excluded.request_direction,excluded.request_epoch);
end $$;

-- A pure eligibility predicate for private media. Bind p_actor to a verified JWT.
create or replace function public.findback_chat_media_visible_internal(p_actor text,p_attachment text)
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

-- Opaque relationship epoch: changes on every mode, request, connection or
-- block boundary. A queued send/accept binds to the epoch it observed, so stale
-- intent cannot be silently recast into a newer request/connection.
create function public.findback_chat_relationship_epoch(c public.chat_conversations)
returns text language sql immutable set search_path=public,pg_temp as $$
 select encode(sha256(convert_to(
  c.state||':'||coalesce(c.request_epoch,'-')||':'||coalesce(c.receipt_connection_epoch,'-')
  ||':'||c.receipt_block_epoch,'UTF8')),'hex')
$$;
revoke all on function public.findback_chat_relationship_epoch(public.chat_conversations) from public,anon,authenticated;

-- Single message admission for TEXT and MEDIA. Identity includes the type, so a
-- MEDIA id can never be acknowledged as TEXT (or the reverse).
create function public.findback_chat_send_internal(
  p_conversation_id text, p_body text, p_client_message_id text, p_message_type text, p_expected_epoch text
) returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype; m public.chat_messages%rowtype;
 v_digest text; v_first boolean; v_epoch text; v_blocked boolean; v_peer text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_message_type is null or p_message_type not in ('TEXT','MEDIA') then
  raise exception 'Invalid message type' using errcode='22023'; end if;
 if p_client_message_id is null
  or p_client_message_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
  raise exception 'Invalid message' using errcode='22023'; end if;
 p_body:=coalesce(p_body,'');
 if length(p_body)>100000 or (p_message_type='TEXT' and btrim(p_body)='') then
  raise exception 'Invalid message' using errcode='22023'; end if;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 v_digest:=encode(sha256(convert_to(p_body,'UTF8')),'hex');
 select * into m from public.chat_messages where id=p_client_message_id;
 if found then
  -- Replay is state-independent: a lost response must stay retryable after the
  -- conversation moves on, but the identity (sender, conversation, body, type)
  -- must match exactly.
  if m.sender_id=v_uid and m.conversation_id=c.id and m.payload_digest=v_digest
   and m.message_type=p_message_type then return m.id; end if;
  raise exception 'Message identity conflict' using errcode='22023';
 end if;
 -- New work must bind to the boundary the client actually observed. A retry of
 -- an already-accepted message returned above and stays idempotent.
 if p_expected_epoch is null
  or p_expected_epoch is distinct from public.findback_chat_relationship_epoch(c) then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state not in ('REQUEST','CONNECTED') then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if p_message_type='MEDIA' and c.state<>'CONNECTED' then
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
 insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,first_approach,
  message_type,receipt_connection_epoch)
 values(p_client_message_id,c.id,v_uid,p_body,v_digest,v_first,p_message_type,
  case when c.state='CONNECTED' then c.receipt_connection_epoch else null end);
 -- A withheld (blocked) send still echoes to the author and never occupies the
 -- counterpart's request slot; media reservation refuses it separately.
 perform public.findback_enqueue_chat_mailbox(p_client_message_id);
 return p_client_message_id;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Canonical relationship RPCs (internal; reached only via the exchange)
-- ---------------------------------------------------------------------------
create or replace function public.findback_create_conversation(p_other_user text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_other_user is null or p_other_user=v_uid or not exists(select 1 from public.users where id=p_other_user) then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 insert into public.chat_conversations(user_a,user_b,initiated_by,request_epoch)
  values(v_uid,p_other_user,null,gen_random_uuid()::text)
  on conflict(least(user_a,user_b),greatest(user_a,user_b)) do nothing;
 select * into c from public.chat_conversations where
  (user_a=v_uid and user_b=p_other_user) or (user_b=v_uid and user_a=p_other_user) for update;
 -- CREATE never reveals a new approach to the other account.
 if c.state not in ('REQUEST','CONNECTED') then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 insert into public.chat_member_state(conversation_id,user_id,mode)
 values(c.id,v_uid,case when c.state='CONNECTED' then 'CONNECTED' else 'REQUEST' end) on conflict do nothing;
 return c.id;
end $$;

drop function if exists public.findback_accept_conversation(text);
create function public.findback_accept_conversation(p_conv_id text,p_expected_epoch text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_conv_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 -- A stale ACCEPT cannot accept a replacement request epoch.
 if p_expected_epoch is null
  or p_expected_epoch is distinct from public.findback_chat_relationship_epoch(c) then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state<>'REQUEST' or c.initiated_by is null or c.initiated_by=v_uid
  or c.initiated_by not in(c.user_a,c.user_b)
  or not exists(select 1 from public.chat_member_state where conversation_id=c.id and user_id=v_uid
   and request_direction='INCOMING') then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 -- Withhold contact without turning a hidden block into an ACCEPT error oracle.
 if public.findback_is_blocked_pair(c.user_a,c.user_b) then return; end if;
 update public.chat_conversations set state='CONNECTED',updated_at=clock_timestamp() where id=c.id;
 perform public.findback_chat_publish_member(c.id,c.user_a,'CONNECTED','NONE',null);
 perform public.findback_chat_publish_member(c.id,c.user_b,'CONNECTED','NONE',null);
 update public.chat_member_state set hidden=false,declined=false,revision=revision+1
  where conversation_id=c.id and user_id=v_uid and (hidden or declined);
end $$;

create or replace function public.findback_end_conversation(p_conv_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_conv_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state<>'CONNECTED' then raise exception 'Conversation is not CONNECTED' using errcode='P0001'; end if;
 -- End never appoints the peer as the next requester: a clean request boundary
 -- starts with no initiator and no stale receipt/request authority.
 update public.chat_conversations set state='REQUEST',initiated_by=null,
  request_epoch=gen_random_uuid()::text,request_nudged=false,updated_at=clock_timestamp() where id=c.id;
 perform public.findback_chat_publish_member(c.id,c.user_a,'REQUEST','NONE',null);
 perform public.findback_chat_publish_member(c.id,c.user_b,'REQUEST','NONE',null);
end $$;

create or replace function public.findback_block_conversation(p_conv_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_conv_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 perform public.findback_block_user(case when c.user_a=v_uid then c.user_b else c.user_a end);
end $$;

create or replace function public.findback_chat_views(p_after text default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; result jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select coalesce(jsonb_agg(page.value order by page.id),'[]'::jsonb) into result from (
  select c.id,jsonb_build_object('conversationId',c.id,
   'peerId',case when c.user_a=v_uid then c.user_b else c.user_a end,
   'mode',v.mode,'request',v.request_direction,'requestEpoch',v.request_epoch,
   'ownHidden',v.hidden,'ownDeclined',v.declined,'revision',v.revision,
   'epoch',public.findback_chat_relationship_epoch(c),
   'ownBlocked',exists(select 1 from public.user_blocks b where b.blocker_user_id=v_uid
     and b.blocked_user_id=case when c.user_a=v_uid then c.user_b else c.user_a end)) as value
  from public.chat_member_state v join public.chat_conversations c on c.id=v.conversation_id
  where v.user_id=v_uid and v_uid in(c.user_a,c.user_b) and (p_after is null or c.id>p_after)
  order by c.id limit 100
 ) page;
 return result;
end $$;

create or replace function public.findback_chat_private_state(p_id text,p_action text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 perform 1 from public.chat_conversations where id=p_id and v_uid in(user_a,user_b) for update;
 if not found or not exists(select 1 from public.chat_member_state where conversation_id=p_id and user_id=v_uid) then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if p_action is null or p_action not in('HIDE','UNHIDE','DECLINE') then
  raise exception 'Invalid chat operation' using errcode='22023'; end if;
 update public.chat_member_state set
  hidden=case when p_action='HIDE' then true when p_action='UNHIDE' then false else hidden end,
  declined=case when p_action='DECLINE' then true else declined end,revision=revision+1
 where conversation_id=p_id and user_id=v_uid and (
  (p_action='HIDE' and not hidden) or (p_action='UNHIDE' and hidden)
  or (p_action='DECLINE' and not declined and mode='REQUEST' and request_direction='INCOMING'));
end $$;

create or replace function public.findback_set_chat_receipts(p_enabled boolean)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_enabled is null then raise exception 'Preference required' using errcode='22023'; end if;
 insert into public.chat_preferences(user_id,enabled) values(v_uid,p_enabled)
  on conflict(user_id) do update set enabled=excluded.enabled;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Receipts read/write the member owner
-- ---------------------------------------------------------------------------
create or replace function public.findback_receipt_context_internal(p_conversation_id text,p_uid text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations%rowtype; p record; v_epochs text:=''; v_count integer:=0;
begin
 select * into c from public.chat_conversations where id=p_conversation_id and p_uid in(user_a,user_b) for update;
 if not found or c.state<>'CONNECTED' or c.receipt_connection_epoch is null
  or public.findback_is_blocked_pair(c.user_a,c.user_b) then return null; end if;
 for p in select user_id,enabled,receipt_consent_epoch from public.chat_preferences
  where user_id in(c.user_a,c.user_b) order by user_id for update loop
  if not p.enabled then return null; end if;
  v_count:=v_count+1; v_epochs:=v_epochs||p.receipt_consent_epoch||':';
 end loop;
 if v_count<>2 then return null; end if;
 return encode(sha256(convert_to(c.receipt_connection_epoch||':'||c.receipt_block_epoch||':'||v_epochs,'UTF8')),'hex');
end $$;

create or replace function public.findback_chat_receipt_view(
  p_account_id text,p_device_id text,p_conversation_id text,p_message_ids jsonb
) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_context text; c public.chat_conversations%rowtype;
 v_peer text; v_through bigint; v_ids jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
  raise exception 'Device unavailable' using errcode='42501'; end if;
 if p_message_ids is null or jsonb_typeof(p_message_ids)<>'array' then
  raise exception 'Invalid message list' using errcode='22023'; end if;
 if jsonb_array_length(p_message_ids)>100
  or exists(select 1 from jsonb_array_elements(p_message_ids) x where jsonb_typeof(x)<>'string') then
  raise exception 'Invalid message list' using errcode='22023'; end if;
 v_context:=public.findback_receipt_context_internal(p_conversation_id,v_uid);
 if v_context is null then return jsonb_build_object('context',null,'readIds','[]'::jsonb); end if;
 select * into c from public.chat_conversations where id=p_conversation_id;
 v_peer:=case when c.user_a=v_uid then c.user_b else c.user_a end;
 select read_through into v_through from public.chat_member_state
  where conversation_id=c.id and user_id=v_peer and read_context=v_context;
 select coalesce(jsonb_agg(m.id order by m.event_sequence),'[]'::jsonb) into v_ids
  from public.chat_messages m where m.conversation_id=c.id and m.sender_id=v_uid and m.unsent_at is null
   and m.receipt_connection_epoch=c.receipt_connection_epoch and m.event_sequence<=coalesce(v_through,0)
   and exists(select 1 from public.chat_message_audience a where a.message_id=m.id and a.user_id=v_peer)
   and exists(select 1 from jsonb_array_elements_text(p_message_ids) j(id) where j.id=m.id);
 return jsonb_build_object('context',v_context,'readIds',v_ids);
end $$;

create or replace function public.findback_chat_receipt_observe(
  p_account_id text,p_device_id text,p_conversation_id text,p_context text,p_message_id text
) returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_context text; v_sequence bigint;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
  raise exception 'Device unavailable' using errcode='42501'; end if;
 v_context:=public.findback_receipt_context_internal(p_conversation_id,v_uid);
 if v_context is null or p_context is null or p_context<>v_context then return false; end if;
 select m.event_sequence into v_sequence from public.chat_messages m
  join public.chat_conversations c on c.id=m.conversation_id
  join public.chat_message_audience a on a.message_id=m.id and a.user_id=v_uid
  where m.id=p_message_id and m.conversation_id=p_conversation_id and m.sender_id<>v_uid
   and m.unsent_at is null and m.sender_id in(c.user_a,c.user_b)
   and m.receipt_connection_epoch=c.receipt_connection_epoch;
 if v_sequence is null then return false; end if;
 update public.chat_member_state set read_context=v_context,
  read_through=case when read_context=v_context then greatest(read_through,v_sequence) else v_sequence end
  where conversation_id=p_conversation_id and user_id=v_uid;
 return true;
end $$;

-- ---------------------------------------------------------------------------
-- 8. One canonical client exchange (no compatibility chain)
-- ---------------------------------------------------------------------------
create or replace function public.findback_chat_exchange(
  p_account_id text,p_device_id text,p_action text,p_args jsonb
) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_result jsonb; v_other text; v_after bigint; v_id text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 case p_action
 when 'REGISTER' then return to_jsonb(public.findback_register_chat_device(p_device_id,p_args->>'platform'));
 when 'VIEWS' then return public.findback_chat_views(p_args->>'afterId');
 when 'PRIVATE' then perform public.findback_chat_private_state(p_args->>'conversationId',p_args->>'operation');
 when 'CREATE' then return to_jsonb(public.findback_create_conversation(p_args->>'otherId'));
 when 'ACCEPT' then perform public.findback_accept_conversation(p_args->>'conversationId',p_args->>'expectedEpoch');
 when 'END' then perform public.findback_end_conversation(p_args->>'conversationId');
 when 'BLOCK' then perform public.findback_block_conversation(p_args->>'conversationId');
 when 'RECEIPTS' then perform public.findback_set_chat_receipts((p_args->>'enabled')::boolean);
 when 'PREFERENCES' then
  select jsonb_build_object(
   'readReceipts',coalesce((select enabled from public.chat_preferences where user_id=v_uid),false),
   'openMessages',coalesce((select open_messages from public.chat_preferences where user_id=v_uid),false)) into v_result;
  return v_result;
 when 'CONTACT_MODE' then
  if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then
   raise exception 'Preference required' using errcode='22023'; end if;
  insert into public.chat_preferences(user_id,open_messages) values(v_uid,(p_args->>'enabled')::boolean)
   on conflict(user_id) do update set open_messages=excluded.open_messages;
 when 'SEND' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  select case when user_a=v_uid then user_b else user_a end into v_other from public.chat_conversations
   where id=p_args->>'conversationId' and v_uid in(user_a,user_b) for update;
  if not found or (p_args->>'recipientId') is distinct from v_other then
   raise exception 'Conversation unavailable' using errcode='42501'; end if;
  return to_jsonb(public.findback_chat_send_internal(p_args->>'conversationId',p_args->>'body',
   p_args->>'messageId',coalesce(p_args->>'messageType','TEXT'),p_args->>'expectedEpoch'));
 when 'SYNC' then
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_result from public.findback_fetch_chat_mailbox(p_device_id) e;
  return v_result;
 when 'ACK' then perform public.findback_ack_chat_message(p_args->>'mailboxId',p_device_id);
 when 'STATE_SYNC' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  v_after:=(p_args->>'afterSequence')::bigint;
  if v_after is null or v_after<0 or v_after>9007199254740991 then
   raise exception 'Invalid state cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(page.value order by page.seq),'[]'::jsonb) into v_result from (
   select e.event_sequence as seq,jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'change',
    jsonb_build_object('eventId',e.id,'sequence',e.event_sequence,'kind',e.kind,'conversationId',e.conversation_id,
     'occurredAt',floor(extract(epoch from e.occurred_at)*1000)::bigint) ||
    case when e.kind='CLEAR_FOR_ME' then jsonb_build_object('peerId',e.peer_id,'throughSequence',e.through_sequence)
     else jsonb_build_object('messageId',e.message_id,'authorId',e.author_id,'recipientId',e.recipient_id,
      'messageSequence',e.message_sequence) end) as value
   from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where a.user_id=v_uid and e.event_sequence>v_after order by e.event_sequence limit 100
  ) page;
  return v_result;
 when 'STATE_ACK' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  v_after:=(p_args->>'sequence')::bigint;
  if not exists(select 1 from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
   where e.id=p_args->>'eventId' and e.event_sequence=v_after and a.user_id=v_uid) then
   raise exception 'State unavailable' using errcode='42501'; end if;
  update public.chat_devices set state_ack_sequence=greatest(state_ack_sequence,v_after)
   where user_id=v_uid and device_id=p_device_id;
 when 'UNSEND','DELETE_FOR_ME','CLEAR_FOR_ME' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501'; end if;
  v_id:=public.findback_chat_remove(p_action,p_args->>'conversationId',p_args->>'messageId',
   (p_args->>'throughSequence')::bigint);
  return to_jsonb(v_id);
 else raise exception 'Invalid chat operation' using errcode='22023';
 end case;
 return 'null'::jsonb;
end $$;

-- Legacy author RPC kept internal: the canonical exchange owns UNSEND.
create or replace function public.findback_unsend_chat_message(p_message_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_id text;
begin
 select conversation_id into v_id from public.chat_messages where id=p_message_id;
 perform public.findback_chat_remove('UNSEND',v_id,p_message_id,null);
end $$;

-- Fail closed for any stale caller of the old context-free read API.
create or replace function public.findback_mark_chat_read(p_message_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin raise exception 'Read observation requires current context' using errcode='42501'; end $$;

-- ---------------------------------------------------------------------------
-- 9. Block boundary: a block ends the connection; unblock never reconnects
-- ---------------------------------------------------------------------------
create or replace function public.findback_chat_own_block_view() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor text; v_peer text; c public.chat_conversations%rowtype;
begin
 if tg_op='DELETE' then v_actor:=old.blocker_user_id; v_peer:=old.blocked_user_id;
 else v_actor:=new.blocker_user_id; v_peer:=new.blocked_user_id; end if;
 for c in select * from public.chat_conversations
  where (user_a=v_actor and user_b=v_peer) or (user_b=v_actor and user_a=v_peer) for update loop
  if tg_op='INSERT' and c.state='CONNECTED' then
   -- The block boundary itself ends the connection. A later unblock leaves a
   -- clean REQUEST with no initiator, so nothing silently reconnects.
   update public.chat_conversations set state='REQUEST',initiated_by=null,
    request_epoch=gen_random_uuid()::text,request_nudged=false,updated_at=clock_timestamp() where id=c.id;
   perform public.findback_chat_publish_member(c.id,c.user_a,'REQUEST','NONE',null);
   perform public.findback_chat_publish_member(c.id,c.user_b,'REQUEST','NONE',null);
  end if;
  update public.chat_member_state set revision=revision+1
   where conversation_id=c.id and user_id=v_actor;
 end loop;
 return null;
end $$;
revoke all on function public.findback_chat_own_block_view() from public,anon,authenticated;
create trigger chat_own_block_view after insert or delete on public.user_blocks
 for each row execute function public.findback_chat_own_block_view();

-- ---------------------------------------------------------------------------
-- 10. Wake triggers: member state replaces the two legacy tables
-- ---------------------------------------------------------------------------
create or replace function public.findback_chat_wake_member() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_peer text;
begin
 if tg_op='INSERT' then
  perform public.findback_chat_wake_internal(new.user_id);
  return null;
 end if;
 if new.mode is distinct from old.mode or new.request_direction is distinct from old.request_direction
  or new.request_epoch is distinct from old.request_epoch or new.hidden is distinct from old.hidden
  or new.declined is distinct from old.declined or new.revision is distinct from old.revision then
  perform public.findback_chat_wake_internal(new.user_id);
 end if;
 if new.read_context is distinct from old.read_context or new.read_through is distinct from old.read_through then
  select case when c.user_a=new.user_id then c.user_b else c.user_a end into v_peer
   from public.chat_conversations c where c.id=new.conversation_id and new.user_id in(c.user_a,c.user_b);
  perform public.findback_chat_wake_internal(v_peer);
 end if;
 return null;
end $$;
revoke all on function public.findback_chat_wake_member() from public,anon,authenticated;
create trigger chat_wake_member after insert or update on public.chat_member_state
 for each row execute function public.findback_chat_wake_member();

-- ---------------------------------------------------------------------------
-- 11. External wake delivery reads the member owner
-- ---------------------------------------------------------------------------
create or replace function public.findback_chat_external_wake_delivery(
  p_wake_id text,p_device_id text,p_claim_token text
) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare w public.chat_external_wakes%rowtype; d public.chat_external_wake_devices%rowtype;
 c public.chat_conversations%rowtype; m public.chat_messages%rowtype; v_token text;
begin
 select * into d from public.chat_external_wake_devices where wake_id=p_wake_id and device_id=p_device_id;
 if not found or d.state<>'CLAIMED' or d.claim_token is distinct from p_claim_token
  or d.lease_until<=clock_timestamp() then return null; end if;
 select * into w from public.chat_external_wakes where id=p_wake_id and expires_at>clock_timestamp();
 if not found then return null; end if;
 select * into c from public.chat_conversations where id=w.conversation_id;
 select * into m from public.chat_messages where id=w.message_id and conversation_id=w.conversation_id;
 if c.id is null or m.id is null or m.unsent_at is not null or w.recipient_id not in(c.user_a,c.user_b)
  or m.sender_id not in(c.user_a,c.user_b) or m.sender_id=w.recipient_id
  or not exists(select 1 from public.chat_message_audience a where a.message_id=m.id and a.user_id=w.recipient_id)
  or public.findback_is_blocked_pair(c.user_a,c.user_b)
  or exists(select 1 from public.notification_preferences p where p.user_id=w.recipient_id and p.push_enabled=0)
  or (w.kind='CHAT_REQUEST' and (c.state<>'REQUEST' or c.request_epoch is distinct from w.request_epoch
    or not m.first_approach or not exists(select 1 from public.chat_member_state v
      where v.conversation_id=c.id and v.user_id=w.recipient_id and v.request_direction='INCOMING'
       and not v.hidden and not v.declined)))
  or (w.kind='CHAT_CONNECTED' and (c.state<>'CONNECTED'
    or c.receipt_connection_epoch is distinct from w.connection_epoch)) then return null; end if;
 select token into v_token from public.device_tokens where id=p_device_id and user_id=w.recipient_id;
 if v_token is null then return null; end if;
 return jsonb_build_object('wakeId',w.id,'recipientId',w.recipient_id,'conversationId',w.conversation_id,
  'kind',w.kind,'token',v_token);
end $$;

-- ---------------------------------------------------------------------------
-- 12. Drop retired callables
-- ---------------------------------------------------------------------------
drop function if exists public.findback_chat_exchange_041(text,text,text,jsonb);
drop function if exists public.findback_send_chat_message_044_internal(text,text,text);
drop function if exists public.findback_send_chat_message(text,text);
drop function if exists public.findback_send_chat_message(text,text,text);
drop function if exists public.findback_send_chat_message(text,text,text,text);
drop function if exists public.findback_ack_chat_message(text);
drop function if exists public.findback_chat_publish_view(text,text,text,text,text);
drop function if exists public.findback_chat_wake_view();
drop function if exists public.findback_chat_wake_read_progress();
drop function if exists public.findback_schedule_chat_media_workers();

-- ---------------------------------------------------------------------------
-- 13. Restore the non-chat-table triggers
-- ---------------------------------------------------------------------------
create trigger chat_block_fence before insert or delete on public.user_blocks
 for each row execute function public.findback_chat_block_fence();
create trigger chat_receipt_block_transition after insert or delete on public.user_blocks
 for each row execute function public.findback_receipt_block_transition();
create trigger chat_wake_block_boundary after insert or delete on public.user_blocks
 for each row execute function public.findback_chat_wake_block_boundary();
create trigger chat_media_capture_report_sources after insert on public.content_reports
 for each row execute function public.findback_capture_chat_media_report_sources();
create trigger chat_media_evidence_expiry after update of evidence_erased_at on public.content_reports
 for each row execute function public.findback_chat_media_expire_report_copy();

-- ---------------------------------------------------------------------------
-- 14. Explicit privilege surface
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  -- Every chat-named routine and the non-chat-named chat helpers start closed.
  for f in select p.oid::regprocedure as sig from pg_proc p
   where p.pronamespace='public'::regnamespace
     and (p.proname like '%chat%' or p.proname in (
       'findback_create_conversation','findback_accept_conversation','findback_end_conversation',
       'findback_block_conversation','findback_receipt_context_internal'))
  loop
    execute format('revoke all on function %s from public,anon,authenticated', f.sig);
  end loop;
end $$;

grant execute on function public.findback_chat_exchange(text,text,text,jsonb) to authenticated;
grant execute on function public.findback_chat_receipt_view(text,text,text,jsonb) to authenticated;
grant execute on function public.findback_chat_receipt_observe(text,text,text,text,text) to authenticated;
grant execute on function public.findback_reserve_chat_media(text,text,text) to authenticated;
grant execute on function public.findback_fetch_chat_media_delivery(text,text) to authenticated;
grant execute on function public.findback_ack_chat_media_delivery(text,text,text) to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
   where p.pronamespace='public'::regnamespace and p.proname in (
     'findback_chat_media_upload_target','findback_commit_chat_media','findback_read_chat_media',
     'findback_reserve_chat_media_report_evidence','findback_commit_chat_media_report_evidence',
     'findback_read_chat_media_report_evidence','findback_chat_media_cleanup_candidates',
     'findback_chat_media_cleanup_done','findback_chat_media_cleanup_recheck',
     'findback_claim_chat_external_wakes','findback_chat_external_wake_delivery',
     'findback_finish_chat_external_wake','findback_cleanup_chat_mailbox',
     'findback_claim_chat_media_evidence_job','findback_finish_chat_media_evidence_job')
  loop
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

comment on function public.findback_chat_exchange(text,text,text,jsonb) is
 'Canonical R4 client exchange: REGISTER, VIEWS, PRIVATE, CREATE, ACCEPT, END, BLOCK, RECEIPTS, PREFERENCES, CONTACT_MODE, SEND, SYNC, ACK, STATE_SYNC, STATE_ACK, UNSEND, DELETE_FOR_ME, CLEAR_FOR_ME.';
comment on table public.chat_member_state is
 'R4 single member owner: viewer projection, private hide/decline and receipt progress.';
comment on table public.chat_preferences is
 'R4 single preferences owner: open-message opt-in and reciprocal read-receipt consent.';

commit;
