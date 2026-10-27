-- Current-context reciprocal read receipts; no ordinary message-body archive.
begin;
alter table public.chat_conversations add column receipt_connection_epoch text;
alter table public.chat_conversations add column receipt_block_epoch text not null default gen_random_uuid()::text;
-- Current connections can support new connected-stage messages; existing
-- messages have unknown provenance and are deliberately not backfilled.
update public.chat_conversations set receipt_connection_epoch=gen_random_uuid()::text where state='CONNECTED';
alter table public.chat_messages add column receipt_connection_epoch text;
alter table public.chat_receipt_preferences add column receipt_consent_epoch text not null default gen_random_uuid()::text;

create function public.findback_receipt_connection_transition() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if old.state is distinct from new.state then
  new.receipt_connection_epoch:=case when new.state='CONNECTED' then gen_random_uuid()::text else null end;
 end if;
 return new;
end $$;
revoke all on function public.findback_receipt_connection_transition() from public,anon,authenticated;
create trigger chat_receipt_connection_transition before update of state on public.chat_conversations
 for each row execute function public.findback_receipt_connection_transition();

create function public.findback_receipt_consent_transition() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.enabled is distinct from old.enabled then new.receipt_consent_epoch:=gen_random_uuid()::text; end if;
 return new;
end $$;
revoke all on function public.findback_receipt_consent_transition() from public,anon,authenticated;
create trigger chat_receipt_consent_transition before update of enabled on public.chat_receipt_preferences
 for each row execute function public.findback_receipt_consent_transition();

-- Existing block fence locks the pair before this after-trigger runs. A block
-- and subsequent unblock must never revive a delayed pre-block observation.
create function public.findback_receipt_block_transition() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare a text; b text;
begin
 if tg_op='DELETE' then a:=old.blocker_user_id; b:=old.blocked_user_id;
 else a:=new.blocker_user_id; b:=new.blocked_user_id; end if;
 update public.chat_conversations set receipt_block_epoch=gen_random_uuid()::text
  where (user_a=a and user_b=b) or (user_a=b and user_b=a);
 return null;
end $$;
revoke all on function public.findback_receipt_block_transition() from public,anon,authenticated;
create trigger chat_receipt_block_transition after insert or delete on public.user_blocks
 for each row execute function public.findback_receipt_block_transition();

-- Capture pre-SEND state under the canonical conversation lock. In particular
-- the request message that triggers OPEN remains request-origin. Retry never
-- rewrites prior provenance. The retained sender owns all other behavior.
alter function public.findback_send_chat_message(text,text,text) rename to findback_send_chat_message_044_internal;
revoke all on function public.findback_send_chat_message_044_internal(text,text,text) from public,anon,authenticated;
create function public.findback_send_chat_message(p_conversation_id text,p_body text,p_client_message_id text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations%rowtype; existed boolean; v_id text; v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 select exists(select 1 from public.chat_messages where id=p_client_message_id) into existed;
 v_id:=public.findback_send_chat_message_044_internal(p_conversation_id,p_body,p_client_message_id);
 if not existed and c.state='CONNECTED' and c.receipt_connection_epoch is not null then
  update public.chat_messages set receipt_connection_epoch=c.receipt_connection_epoch where id=v_id;
 end if;
 return v_id;
end $$;
revoke all on function public.findback_send_chat_message(text,text,text) from public,anon,authenticated;

create table public.chat_read_progress (
 conversation_id text not null references public.chat_conversations(id) on delete cascade,
 reader_id text not null references public.users(id) on delete cascade,
 context text not null,
 through_sequence bigint not null check(through_sequence>0 and through_sequence<=9007199254740991),
 primary key(conversation_id,reader_id)
);
alter table public.chat_read_progress enable row level security;
revoke all on public.chat_read_progress from public,anon,authenticated;

-- Locks pair then existing preferences in stable order. Preference writes lock
-- their row; pair state and block writes lock the conversation. This makes the
-- returned context and any subsequent mutation one atomic consent observation.
create function public.findback_receipt_context_internal(p_conversation_id text,p_uid text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations%rowtype; p record; v_epochs text:=''; v_count integer:=0;
begin
 select * into c from public.chat_conversations where id=p_conversation_id and p_uid in(user_a,user_b) for update;
 if not found or c.state<>'CONNECTED' or c.receipt_connection_epoch is null
  or public.findback_is_blocked_pair(c.user_a,c.user_b) then return null; end if;
 for p in select user_id,enabled,receipt_consent_epoch from public.chat_receipt_preferences
  where user_id in(c.user_a,c.user_b) order by user_id for update loop
  if not p.enabled then return null; end if;
  v_count:=v_count+1; v_epochs:=v_epochs||p.receipt_consent_epoch||':';
 end loop;
 if v_count<>2 then return null; end if;
 return encode(sha256(convert_to(c.receipt_connection_epoch||':'||c.receipt_block_epoch||':'||v_epochs,'UTF8')),'hex');
end $$;
revoke all on function public.findback_receipt_context_internal(text,text) from public,anon,authenticated;

-- Fail closed for callers of the old context-free API, including old exchange
-- clients. No participant may continue writing per-message read_at through it.
create or replace function public.findback_mark_chat_read(p_message_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin raise exception 'Read observation requires current context' using errcode='42501'; end $$;
revoke all on function public.findback_mark_chat_read(text) from public,anon,authenticated;

-- Each response contains only current opaque authority and the requested own
-- message IDs whose connected-stage sequence is covered by peer progress.
-- No peer preference, timestamp, device or historical receipt map is returned.
create function public.findback_chat_receipt_view(p_account_id text,p_device_id text,p_conversation_id text,p_message_ids jsonb)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_context text; c public.chat_conversations%rowtype;
 v_peer text; v_through bigint; v_ids jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
  raise exception 'Device unavailable' using errcode='42501'; end if;
 if p_message_ids is null or jsonb_typeof(p_message_ids)<>'array' then raise exception 'Invalid message list' using errcode='22023'; end if;
 if jsonb_array_length(p_message_ids)>100 or exists(select 1 from jsonb_array_elements(p_message_ids) x where jsonb_typeof(x)<>'string') then
  raise exception 'Invalid message list' using errcode='22023'; end if;
 v_context:=public.findback_receipt_context_internal(p_conversation_id,v_uid);
 if v_context is null then return jsonb_build_object('context',null,'readIds','[]'::jsonb); end if;
 select * into c from public.chat_conversations where id=p_conversation_id;
 v_peer:=case when c.user_a=v_uid then c.user_b else c.user_a end;
 select through_sequence into v_through from public.chat_read_progress
  where conversation_id=c.id and reader_id=v_peer and context=v_context;
 select coalesce(jsonb_agg(m.id order by m.event_sequence),'[]'::jsonb) into v_ids
  from public.chat_messages m where m.conversation_id=c.id and m.sender_id=v_uid and m.unsent_at is null
   and m.receipt_connection_epoch=c.receipt_connection_epoch and m.event_sequence<=v_through
   and exists(select 1 from public.chat_message_audience a where a.message_id=m.id and a.user_id=v_peer)
   and exists(select 1 from jsonb_array_elements_text(p_message_ids) j(id) where j.id=m.id);
 return jsonb_build_object('context',v_context,'readIds',v_ids);
end $$;
revoke all on function public.findback_chat_receipt_view(text,text,text,jsonb) from public,anon;
grant execute on function public.findback_chat_receipt_view(text,text,text,jsonb) to authenticated;

-- Boundary is a real originally authorized inbound message in this connection,
-- observed with exactly the context returned before the observation. Old
-- contexts, NULLs, unknown IDs and own-message boundaries never advance it.
create function public.findback_chat_receipt_observe(p_account_id text,p_device_id text,p_conversation_id text,p_context text,p_message_id text)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
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
  where m.id=p_message_id and m.conversation_id=p_conversation_id and m.sender_id<>v_uid and m.unsent_at is null
   and m.sender_id in(c.user_a,c.user_b) and m.receipt_connection_epoch=c.receipt_connection_epoch;
 if v_sequence is null then return false; end if;
 insert into public.chat_read_progress(conversation_id,reader_id,context,through_sequence)
  values(p_conversation_id,v_uid,v_context,v_sequence)
 on conflict(conversation_id,reader_id) do update set context=excluded.context,
  through_sequence=case when chat_read_progress.context=excluded.context
   then greatest(chat_read_progress.through_sequence,excluded.through_sequence) else excluded.through_sequence end;
 return true;
end $$;
revoke all on function public.findback_chat_receipt_observe(text,text,text,text,text) from public,anon;
grant execute on function public.findback_chat_receipt_observe(text,text,text,text,text) to authenticated;
commit;
