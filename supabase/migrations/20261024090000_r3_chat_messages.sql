-- R3 Chat: message sending, read receipts, unsend, delete-for-me
-- Extends 20261024070000_r3_chat_foundation.sql
begin;

-- 1. send_message RPC (participants only, CONNECTED or REQUEST state)
-- Request-stage messages are text-only. No media/linkification before acceptance.
create or replace function public.findback_send_chat_message(
  p_conversation_id text,
  p_body text
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_user_a text;
  v_user_b text;
  v_state text;
  v_msg_id text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'Message body is required' using errcode='22023';
  end if;

  select user_a, user_b, state into v_user_a, v_user_b, v_state
    from public.chat_conversations where id = p_conversation_id;

  if v_user_a is null then raise exception 'Conversation not found' using errcode='P0001'; end if;
  if v_uid <> v_user_a and v_uid <> v_user_b then
    raise exception 'Not a participant' using errcode='42501';
  end if;
  if v_state not in ('REQUEST', 'CONNECTED') then
    raise exception 'Conversation is not active' using errcode='P0001';
  end if;

  insert into public.chat_messages (conversation_id, sender_id, body)
  values (p_conversation_id, v_uid, btrim(p_body))
  returning id into v_msg_id;

  update public.chat_conversations
    set updated_at = clock_timestamp()
    where id = p_conversation_id;

  return v_msg_id;
end;
$$;
revoke all on function public.findback_send_chat_message(text,text) from public, anon;
grant execute on function public.findback_send_chat_message(text,text) to authenticated;

-- 2. unsend_message RPC (author-only, tombstone preserves moderation evidence)
create or replace function public.findback_unsend_chat_message(p_message_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_sender text;
  v_conv_id text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select sender_id, conversation_id into v_sender, v_conv_id
    from public.chat_messages where id = p_message_id;

  if v_sender is null then raise exception 'Message not found' using errcode='P0001'; end if;
  if v_sender <> v_uid then raise exception 'Only the author can unsend' using errcode='42501'; end if;

  -- Tombstone: preserve row for moderation evidence, clear body
  update public.chat_messages
    set unsent_at = clock_timestamp(),
        unsent_by = v_uid,
        body = ''
    where id = p_message_id;
end;
$$;
revoke all on function public.findback_unsend_chat_message(text) from public, anon;
grant execute on function public.findback_unsend_chat_message(text) to authenticated;

-- 3. mark_read RPC (reciprocal: only works if both have receipts enabled)
-- For now, simple mark-as-read by recipient. Consent check is client-side.
create or replace function public.findback_mark_chat_read(p_message_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_sender text;
  v_conv_id text;
  v_user_a text;
  v_user_b text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select m.sender_id, m.conversation_id into v_sender, v_conv_id
    from public.chat_messages m where m.id = p_message_id;

  if v_sender is null then raise exception 'Message not found' using errcode='P0001'; end if;
  if v_sender = v_uid then return; end if; -- can't mark own message as read

  select user_a, user_b into v_user_a, v_user_b
    from public.chat_conversations where id = v_conv_id;

  if v_uid <> v_user_a and v_uid <> v_user_b then
    raise exception 'Not a participant' using errcode='42501';
  end if;

  update public.chat_messages
    set read_at = clock_timestamp()
    where id = p_message_id and read_at is null;
end;
$$;
revoke all on function public.findback_mark_chat_read(text) from public, anon;
grant execute on function public.findback_mark_chat_read(text) to authenticated;

-- 4. delete_for_me tracking table (per-user, per-device)
create table if not exists public.chat_deleted_for_me (
  id            text primary key default gen_random_uuid()::text,
  user_id       text not null references public.users(id) on delete cascade,
  message_id    text not null references public.chat_messages(id) on delete cascade,
  device_id     text,
  deleted_at    timestamptz not null default clock_timestamp(),
  unique (user_id, message_id)
);

create index if not exists ix_chat_deleted_for_me_user on public.chat_deleted_for_me(user_id);
alter table public.chat_deleted_for_me enable row level security;
revoke all on table public.chat_deleted_for_me from public, anon, authenticated;

create policy chat_deleted_for_me_owner on public.chat_deleted_for_me
  for all to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

commit;