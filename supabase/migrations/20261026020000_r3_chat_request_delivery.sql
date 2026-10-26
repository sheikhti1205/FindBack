-- R3 text-chat server flow. No raw participant table grants: use scoped RPCs.
-- Legacy BLOCKED rows stay quarantined; their missing blocker attribution cannot
-- safely be guessed. New blocks use the canonical directional user_blocks owner.
begin;
alter table public.chat_conversations alter column initiated_by drop not null;
alter table public.chat_conversations add column request_nudged boolean not null default false;
alter table public.chat_messages add column event_sequence bigint generated always as identity;
alter table public.chat_messages add column first_approach boolean not null default false;
alter table public.chat_messages add column payload_digest text;
update public.chat_messages set payload_digest=encode(sha256(convert_to(body,'UTF8')),'hex');
-- Earlier receipts had no server consent boundary. They cannot be trusted.
update public.chat_messages set read_at=null;

create table public.chat_receipt_preferences (
 user_id text primary key references public.users(id) on delete cascade,
 enabled boolean not null default false
);
alter table public.chat_receipt_preferences enable row level security;
revoke all on public.chat_receipt_preferences from public,anon,authenticated;

-- Fence canonical block/unblock writes against all row-locked chat transitions.
create function public.findback_chat_block_fence() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if TG_OP='DELETE' then
  perform c.id from public.chat_conversations c where
   (c.user_a=OLD.blocker_user_id and c.user_b=OLD.blocked_user_id) or
   (c.user_b=OLD.blocker_user_id and c.user_a=OLD.blocked_user_id) for update;
  return OLD;
 end if;
 perform c.id from public.chat_conversations c where
  (c.user_a=NEW.blocker_user_id and c.user_b=NEW.blocked_user_id) or
  (c.user_b=NEW.blocker_user_id and c.user_a=NEW.blocked_user_id) for update;
 return NEW;
end $$;
revoke all on function public.findback_chat_block_fence() from public,anon,authenticated;
create trigger chat_block_fence before insert or delete on public.user_blocks
 for each row execute function public.findback_chat_block_fence();

create or replace function public.findback_create_conversation(p_other_user text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_id text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_other_user is null or p_other_user=v_uid or not exists(select 1 from public.users where id=p_other_user) then
  raise exception 'Conversation unavailable' using errcode='42501';
 end if;
 insert into public.chat_conversations(user_a,user_b,initiated_by) values(v_uid,p_other_user,v_uid)
  on conflict(least(user_a,user_b),greatest(user_a,user_b)) do nothing;
 select id into v_id from public.chat_conversations where
  (user_a=v_uid and user_b=p_other_user) or (user_b=v_uid and user_a=p_other_user);
 return v_id;
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

create or replace function public.findback_end_conversation(p_conv_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_conv_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state<>'CONNECTED' then raise exception 'Conversation is not CONNECTED' using errcode='P0001'; end if;
 update public.chat_conversations set state='REQUEST',initiated_by=null,request_nudged=false,
  ended_at=clock_timestamp(),ended_by=v_uid,updated_at=clock_timestamp() where id=c.id;
end $$;

create function public.findback_register_chat_device(p_device_id text,p_platform text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_id text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_device_id is null or p_device_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or p_platform is null or p_platform not in('android','web','ios') then raise exception 'Invalid device' using errcode='22023'; end if;
 insert into public.chat_devices(user_id,device_id,platform) values(v_uid,p_device_id,p_platform)
 on conflict(user_id,device_id) do update set last_seen_at=clock_timestamp()
 returning id into v_id;
 return v_id;
end $$;

create or replace function public.findback_enqueue_chat_mailbox(p_message_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare m public.chat_messages%rowtype; c public.chat_conversations%rowtype; v_blocked boolean;
begin
 select * into m from public.chat_messages where id=p_message_id;
 if not found then return; end if;
 select * into c from public.chat_conversations where id=m.conversation_id;
 v_blocked:=public.findback_is_blocked_pair(c.user_a,c.user_b);
 -- Echo to the author's installations confirms durable outbox success. A block
 -- withholds only counterpart delivery; the sender gets the same send response.
 insert into public.chat_mailbox(device_id,message_id,conversation_id)
 select d.id,m.id,c.id from public.chat_devices d where
  d.user_id=m.sender_id or (not v_blocked and d.user_id in(c.user_a,c.user_b))
 on conflict(device_id,message_id) do nothing;
end $$;

create function public.findback_send_chat_message(p_conversation_id text,p_body text,p_client_message_id text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype; m public.chat_messages%rowtype;
 v_digest text; v_first boolean;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_body is null or btrim(p_body)='' or length(p_body)>100000 or p_client_message_id is null
  or p_client_message_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then raise exception 'Invalid message' using errcode='22023'; end if;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 v_digest:=encode(sha256(convert_to(p_body,'UTF8')),'hex');
 select * into m from public.chat_messages where id=p_client_message_id;
 if found then
  if m.sender_id=v_uid and m.conversation_id=c.id and m.payload_digest=v_digest then return m.id; end if;
  raise exception 'Message identity conflict' using errcode='22023';
 end if;
 if c.state not in('REQUEST','CONNECTED') then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state='REQUEST' and c.initiated_by is not null and c.initiated_by<>v_uid then
  raise exception 'Conversation unavailable' using errcode='42501';
 end if;
 v_first:=c.state='REQUEST' and not c.request_nudged;
 insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,first_approach)
 values(p_client_message_id,c.id,v_uid,p_body,v_digest,v_first);
 update public.chat_conversations set updated_at=clock_timestamp(),
  initiated_by=case when state='REQUEST' then coalesce(initiated_by,v_uid) else initiated_by end,
  request_nudged=request_nudged or v_first where id=c.id;
 perform public.findback_enqueue_chat_mailbox(p_client_message_id);
 return p_client_message_id;
end $$;
-- Prevent old non-idempotent writes; no peer-chat production caller used this RPC.
revoke all on function public.findback_send_chat_message(text,text) from public,anon,authenticated;

create function public.findback_set_chat_receipts(p_enabled boolean)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_enabled is null then raise exception 'Preference required' using errcode='22023'; end if;
 insert into public.chat_receipt_preferences(user_id,enabled) values(v_uid,p_enabled)
 on conflict(user_id) do update set enabled=excluded.enabled;
end $$;

create or replace function public.findback_mark_chat_read(p_message_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; m public.chat_messages%rowtype; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into m from public.chat_messages where id=p_message_id;
 if not found then return; end if;
 select * into c from public.chat_conversations where id=m.conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if m.sender_id=v_uid or c.state<>'CONNECTED' or public.findback_is_blocked_pair(c.user_a,c.user_b) then return; end if;
 if (select count(*) from public.chat_receipt_preferences where user_id in(c.user_a,c.user_b) and enabled)<>2 then return; end if;
 update public.chat_messages set read_at=clock_timestamp() where id=m.id and read_at is null;
end $$;

create function public.findback_fetch_chat_mailbox(p_device_id text)
returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 return query select jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'mailboxId',b.id,
  'event',jsonb_build_object('kind','TEXT','eventId',m.id,'sequence',m.event_sequence,'message',
   jsonb_build_object('id',m.id,'conversationId',c.id,'authorId',m.sender_id,
    'recipientId',case when c.user_a=m.sender_id then c.user_b else c.user_a end,'body',m.body)))
 from public.chat_mailbox b join public.chat_devices d on d.id=b.device_id
 join public.chat_messages m on m.id=b.message_id join public.chat_conversations c on c.id=b.conversation_id
 where d.user_id=v_uid and d.device_id=p_device_id and b.acked_at is null and b.expires_at>clock_timestamp()
  and m.unsent_at is null and m.body<>''
  and (m.sender_id=v_uid or not public.findback_is_blocked_pair(c.user_a,c.user_b))
 order by m.event_sequence limit 100;
end $$;

create function public.findback_ack_chat_message(p_mailbox_id text,p_device_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 update public.chat_mailbox b set acked_at=coalesce(acked_at,clock_timestamp())
 where b.id=p_mailbox_id and exists(select 1 from public.chat_devices d where d.id=b.device_id and d.user_id=v_uid and d.device_id=p_device_id);
end $$;
revoke all on function public.findback_ack_chat_message(text) from public,anon,authenticated;

create or replace function public.findback_cleanup_chat_mailbox()
returns integer language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare n integer;
begin
 delete from public.chat_mailbox where acked_at is not null or expires_at<clock_timestamp();
 get diagnostics n=row_count;
 -- Keep only idempotency/tombstone metadata after every device ACKs or expires.
 update public.chat_messages m set body='' where body<>'' and not exists(select 1 from public.chat_mailbox b where b.message_id=m.id);
 return n;
end $$;

-- SEND is internal: only the definer exchange may invoke it after checking
-- the captured account, registered installation and expected counterpart.
revoke all on function public.findback_send_chat_message(text,text,text) from public,anon,authenticated;
revoke all on function public.findback_register_chat_device(text,text),
 public.findback_set_chat_receipts(boolean),public.findback_fetch_chat_mailbox(text),public.findback_ack_chat_message(text,text) from public,anon;
grant execute on function public.findback_register_chat_device(text,text),
 public.findback_set_chat_receipts(boolean),public.findback_fetch_chat_mailbox(text),public.findback_ack_chat_message(text,text) to authenticated;
-- Existing internal enqueue/cleanup grants stay revoked. Existing participant
-- RPC replacements retain their authenticated-only grants from earlier migrations.

-- Every production client request carries its captured account scope. If the
-- canonical SDK changes sessions before dispatch, reject rather than sending the
-- previous account's queued body as the newly signed-in participant.
create function public.findback_chat_exchange(p_account_id text,p_device_id text,p_action text,p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_result jsonb; v_other text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 case p_action
 when 'REGISTER' then return to_jsonb(public.findback_register_chat_device(p_device_id,p_args->>'platform'));
 when 'CREATE' then return to_jsonb(public.findback_create_conversation(p_args->>'otherId'));
 when 'ACCEPT' then perform public.findback_accept_conversation(p_args->>'conversationId');
 when 'END' then perform public.findback_end_conversation(p_args->>'conversationId');
 when 'BLOCK' then perform public.findback_block_conversation(p_args->>'conversationId');
 when 'RECEIPTS' then perform public.findback_set_chat_receipts((p_args->>'enabled')::boolean);
 when 'READ' then perform public.findback_mark_chat_read(p_args->>'messageId');
 when 'SEND' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501';
  end if;
  select case when user_a=v_uid then user_b else user_a end into v_other from public.chat_conversations
   where id=p_args->>'conversationId' and v_uid in(user_a,user_b) for update;
  if not found or (p_args->>'recipientId') is distinct from v_other then
   raise exception 'Conversation unavailable' using errcode='42501';
  end if;
  return to_jsonb(public.findback_send_chat_message(p_args->>'conversationId',p_args->>'body',p_args->>'messageId'));
 when 'SYNC' then
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_result from public.findback_fetch_chat_mailbox(p_device_id) e;
  return v_result;
 when 'ACK' then perform public.findback_ack_chat_message(p_args->>'mailboxId',p_device_id);
 else raise exception 'Invalid chat operation' using errcode='22023';
 end case;
 return 'null'::jsonb;
end $$;
revoke all on function public.findback_chat_exchange(text,text,text,jsonb) from public,anon;
grant execute on function public.findback_chat_exchange(text,text,text,jsonb) to authenticated;
commit;
