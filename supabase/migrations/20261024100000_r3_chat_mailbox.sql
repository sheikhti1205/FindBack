-- R3 Chat: per-device temporary mailbox, durable idempotent outbox, ACK tracking
-- Extends 20261024090000_r3_chat_messages.sql
-- Server-side tables for offline message delivery and sync.
-- Client-side: Android SQLite / web IndexedDB (not in this migration).
begin;

-- 1. Device registry (per-user, per-device)
create table if not exists public.chat_devices (
  id            text primary key default gen_random_uuid()::text,
  user_id       text not null references public.users(id) on delete cascade,
  device_id     text not null,
  device_name   text,
  platform      text not null check (platform in ('android', 'web', 'ios')),
  push_token    text,
  last_seen_at  timestamptz not null default clock_timestamp(),
  registered_at timestamptz not null default clock_timestamp(),
  unique (user_id, device_id)
);

create index if not exists ix_chat_devices_user on public.chat_devices(user_id);
alter table public.chat_devices enable row level security;
revoke all on table public.chat_devices from public, anon, authenticated;

create policy chat_devices_owner on public.chat_devices
  for all to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- 2. Temporary per-device mailbox (messages awaiting delivery)
-- TTL: ~30 days. ACK after persistence on device.
create table if not exists public.chat_mailbox (
  id            text primary key default gen_random_uuid()::text,
  device_id     text not null references public.chat_devices(id) on delete cascade,
  message_id    text not null references public.chat_messages(id) on delete cascade,
  conversation_id text not null references public.chat_conversations(id) on delete cascade,
  enqueued_at   timestamptz not null default clock_timestamp(),
  expires_at    timestamptz not null default (clock_timestamp() + interval '30 days'),
  delivered_at  timestamptz,
  acked_at      timestamptz,
  -- Idempotency: same message to same device is a no-op
  unique (device_id, message_id)
);

create index if not exists ix_chat_mailbox_device on public.chat_mailbox(device_id, enqueued_at);
create index if not exists ix_chat_mailbox_expires on public.chat_mailbox(expires_at);
alter table public.chat_mailbox enable row level security;
revoke all on table public.chat_mailbox from public, anon, authenticated;

-- 3. Durable idempotent outbox (for message sending)
create table if not exists public.chat_outbox (
  id            text primary key default gen_random_uuid()::text,
  device_id     text not null references public.chat_devices(id) on delete cascade,
  conversation_id text not null references public.chat_conversations(id) on delete cascade,
  body          text not null,
  client_msg_id text not null,  -- client-generated idempotency key
  status        text not null default 'PENDING'
    check (status in ('PENDING', 'SENT', 'FAILED')),
  created_at    timestamptz not null default clock_timestamp(),
  sent_at       timestamptz,
  error         text,
  -- Idempotency: same client_msg_id on same device is a no-op
  unique (device_id, client_msg_id)
);

create index if not exists ix_chat_outbox_device on public.chat_outbox(device_id, created_at);
alter table public.chat_outbox enable row level security;
revoke all on table public.chat_outbox from public, anon, authenticated;

create policy chat_outbox_owner on public.chat_outbox
  for all to authenticated
  using (device_id in (select id from public.chat_devices where user_id = auth.uid()::text))
  with check (device_id in (select id from public.chat_devices where user_id = auth.uid()::text));

-- 4. Enqueue message to mailbox (for offline recipients)
create or replace function public.findback_enqueue_chat_mailbox(
  p_message_id text
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv_id text;
  v_sender text;
  v_user_a text;
  v_user_b text;
  v_recipient text;
  v_device record;
begin
  select m.conversation_id, m.sender_id into v_conv_id, v_sender
    from public.chat_messages m where m.id = p_message_id;

  if v_conv_id is null then return; end if;

  select user_a, user_b into v_user_a, v_user_b
    from public.chat_conversations where id = v_conv_id;

  -- Enqueue for the recipient's devices (not the sender's)
  if v_sender = v_user_a then v_recipient := v_user_b; else v_recipient := v_user_a; end if;

  for v_device in
    select id from public.chat_devices where user_id = v_recipient
  loop
    insert into public.chat_mailbox (device_id, message_id, conversation_id)
    values (v_device.id, p_message_id, v_conv_id)
    on conflict (device_id, message_id) do nothing;
  end loop;
end;
$$;
revoke all on function public.findback_enqueue_chat_mailbox(text) from public, anon, authenticated;

-- 5. ACK message (device confirms persistence)
create or replace function public.findback_ack_chat_message(
  p_mailbox_id text
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  update public.chat_mailbox
    set acked_at = clock_timestamp()
    where id = p_mailbox_id
      and device_id in (select id from public.chat_devices where user_id = v_uid);
end;
$$;
revoke all on function public.findback_ack_chat_message(text) from public, anon, authenticated;
grant execute on function public.findback_ack_chat_message(text) to authenticated;

-- 6. Cleanup expired mailbox entries (TTL ~30 days)
create or replace function public.findback_cleanup_chat_mailbox()
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from public.chat_mailbox where expires_at < clock_timestamp() and acked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.findback_cleanup_chat_mailbox() from public, anon, authenticated;

commit;