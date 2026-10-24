-- R3 Chat: conversation state machine (REQUEST/CONNECTED/BLOCKED/ENDED)
-- Foundational migration. Full implementation requires additional slices:
-- local storage (Android SQLite/web IndexedDB), outbox, mailbox, backup/restore.
begin;

-- 1. chat_conversations table
create table if not exists public.chat_conversations (
  id            text primary key default gen_random_uuid()::text,
  user_a        text not null references public.users(id) on delete cascade,
  user_b        text not null references public.users(id) on delete cascade,
  state         text not null default 'REQUEST'
    check (state in ('REQUEST','CONNECTED','BLOCKED','ENDED')),
  initiated_by  text not null references public.users(id),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  ended_at      timestamptz,
  ended_by      text references public.users(id)
  -- Unique pair (order-independent) enforced via expression index below
);

create index if not exists ix_chat_conversations_user_a on public.chat_conversations(user_a);
create index if not exists ix_chat_conversations_user_b on public.chat_conversations(user_b);
create index if not exists ix_chat_conversations_state on public.chat_conversations(state);

create unique index if not exists ux_chat_conversations_pair
  on public.chat_conversations (least(user_a, user_b), greatest(user_a, user_b));

alter table public.chat_conversations enable row level security;
revoke all on table public.chat_conversations from public, anon, authenticated;

-- 2. chat_messages table (server-side temporary mailbox)
create table if not exists public.chat_messages (
  id            text primary key default gen_random_uuid()::text,
  conversation_id text not null references public.chat_conversations(id) on delete cascade,
  sender_id     text not null references public.users(id),
  body          text not null,
  message_type  text not null default 'TEXT'
    check (message_type in ('TEXT')),
  sent_at       timestamptz not null default clock_timestamp(),
  -- Tombstone for unsend
  unsent_at     timestamptz,
  unsent_by     text references public.users(id),
  -- Read receipt (only after CONNECTED + reciprocal consent)
  read_at       timestamptz
);

create index if not exists ix_chat_messages_conversation on public.chat_messages(conversation_id, sent_at);
create index if not exists ix_chat_messages_sender on public.chat_messages(sender_id);

alter table public.chat_messages enable row level security;
revoke all on table public.chat_messages from public, anon, authenticated;

-- 3. RLS: participants only
create policy chat_conversations_participant_select on public.chat_conversations
  for select to authenticated
  using (user_a = auth.uid()::text or user_b = auth.uid()::text);

create policy chat_messages_participant_select on public.chat_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.chat_conversations c
      where c.id = chat_messages.conversation_id
        and (c.user_a = auth.uid()::text or c.user_b = auth.uid()::text)
    )
  );

-- 4. create_conversation RPC (REQUEST state)
create or replace function public.findback_create_conversation(p_other_user text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_conv_id text;
  v_state text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if v_uid = p_other_user then raise exception 'Cannot chat with yourself' using errcode='22023'; end if;

  -- Check if conversation already exists
  select id, state into v_conv_id, v_state
    from public.chat_conversations
    where (user_a = v_uid and user_b = p_other_user)
       or (user_a = p_other_user and user_b = v_uid);

  if v_conv_id is not null then
    -- If ENDED, allow re-request (return to REQUEST)
    if v_state = 'ENDED' then
      update public.chat_conversations
        set state = 'REQUEST', initiated_by = v_uid, ended_at = null, ended_by = null, updated_at = clock_timestamp()
        where id = v_conv_id;
    end if;
    return v_conv_id;
  end if;

  insert into public.chat_conversations (user_a, user_b, initiated_by)
  values (v_uid, p_other_user, v_uid)
  returning id into v_conv_id;

  return v_conv_id;
end;
$$;
revoke all on function public.findback_create_conversation(text) from public, anon;
grant execute on function public.findback_create_conversation(text) to authenticated;

-- 5. accept_conversation RPC (REQUEST -> CONNECTED)
create or replace function public.findback_accept_conversation(p_conv_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_initiator text;
  v_state text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select initiated_by, state into v_initiator, v_state
    from public.chat_conversations where id = p_conv_id;

  if v_initiator is null then raise exception 'Conversation not found' using errcode='P0001'; end if;
  if v_initiator = v_uid then raise exception 'Cannot accept your own request' using errcode='42501'; end if;
  if v_state <> 'REQUEST' then raise exception 'Conversation is not in REQUEST state' using errcode='P0001'; end if;

  update public.chat_conversations
    set state = 'CONNECTED', updated_at = clock_timestamp()
    where id = p_conv_id;
end;
$$;
revoke all on function public.findback_accept_conversation(text) from public, anon;
grant execute on function public.findback_accept_conversation(text) to authenticated;

-- 6. end_conversation RPC (CONNECTED -> REQUEST, history retained)
create or replace function public.findback_end_conversation(p_conv_id text)
returns void
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
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select user_a, user_b, state into v_user_a, v_user_b, v_state
    from public.chat_conversations where id = p_conv_id;

  if v_user_a is null then raise exception 'Conversation not found' using errcode='P0001'; end if;
  if v_uid <> v_user_a and v_uid <> v_user_b then
    raise exception 'Not a participant' using errcode='42501';
  end if;
  if v_state <> 'CONNECTED' then raise exception 'Conversation is not CONNECTED' using errcode='P0001'; end if;

  update public.chat_conversations
    set state = 'REQUEST', ended_at = clock_timestamp(), ended_by = v_uid, updated_at = clock_timestamp()
    where id = p_conv_id;
end;
$$;
revoke all on function public.findback_end_conversation(text) from public, anon;
grant execute on function public.findback_end_conversation(text) to authenticated;

-- 7. block_conversation RPC
create or replace function public.findback_block_conversation(p_conv_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_user_a text;
  v_user_b text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select user_a, user_b into v_user_a, v_user_b
    from public.chat_conversations where id = p_conv_id;

  if v_user_a is null then raise exception 'Conversation not found' using errcode='P0001'; end if;
  if v_uid <> v_user_a and v_uid <> v_user_b then
    raise exception 'Not a participant' using errcode='42501';
  end if;

  update public.chat_conversations
    set state = 'BLOCKED', updated_at = clock_timestamp()
    where id = p_conv_id;
end;
$$;
revoke all on function public.findback_block_conversation(text) from public, anon;
grant execute on function public.findback_block_conversation(text) to authenticated;

commit;