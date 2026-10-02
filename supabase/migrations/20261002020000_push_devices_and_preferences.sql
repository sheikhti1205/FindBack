-- FindBack — push devices, notification preferences, and dispatch marker.
--
-- The mobile app registers an FCM device token and opts into notification
-- categories here. `push-dispatch` (Edge Function) reads unsent notifications,
-- joins the recipient's active device tokens and preferences, sends FCM HTTP v1,
-- then stamps `pushed_at`. Nothing in this file accepts a caller-supplied
-- user id: every client RPC is scoped to auth.uid()::text.
--
-- Privacy boundary: both tables have RLS enabled with NO policies; only the
-- SECURITY DEFINER RPCs below touch rows, EXECUTE granted ONLY to `authenticated`.

-- ---------------------------------------------------------------------------
-- Device tokens (one row per user/token pair; a token can move between users
-- by upserting under a new owner — the unique pair never blocks that).
-- ---------------------------------------------------------------------------
create table if not exists public.device_tokens (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('android', 'ios', 'web')),
  created_at text not null,
  updated_at text not null,
  unique (user_id, token)
);

create index if not exists idx_device_tokens_user on public.device_tokens (user_id);
create index if not exists idx_device_tokens_token on public.device_tokens (token);

alter table public.device_tokens enable row level security;

-- ---------------------------------------------------------------------------
-- Per-user notification preferences (absent row = all defaults on).
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id text primary key references public.users(id) on delete cascade,
  push_enabled integer not null default 1 check (push_enabled in (0, 1)),
  likes integer not null default 1 check (likes in (0, 1)),
  comments integer not null default 1 check (comments in (0, 1)),
  mentions integer not null default 1 check (mentions in (0, 1)),
  status integer not null default 1 check (status in (0, 1)),
  updated_at text not null
);

alter table public.notification_preferences enable row level security;

-- ---------------------------------------------------------------------------
-- Dispatch marker on the existing inbox table.
-- ---------------------------------------------------------------------------
alter table public.notifications add column if not exists pushed_at text;
create index if not exists idx_notifications_dispatch
  on public.notifications (created_at)
  where pushed_at is null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------
create or replace function public.findback_register_device_token_client(
  p_token text,
  p_platform text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_token is null or length(trim(p_token)) < 8 or length(p_token) > 4096 then
    raise exception 'Invalid device token' using errcode = '22023';
  end if;
  if p_platform not in ('android', 'ios', 'web') then
    raise exception 'Invalid platform' using errcode = '22023';
  end if;
  insert into public.device_tokens (id, user_id, token, platform, created_at, updated_at)
  values (gen_random_uuid()::text, v_uid, p_token, p_platform, v_now, v_now)
  on conflict (user_id, token)
    do update set platform = excluded.platform, updated_at = excluded.updated_at;
end;
$$;

create or replace function public.findback_unregister_device_token_client(p_token text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from public.device_tokens d
  where d.user_id = v_uid and d.token = p_token;
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

create or replace function public.findback_get_notification_preferences_client()
returns table (
  push_enabled integer,
  likes integer,
  comments integer,
  mentions integer,
  status integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_push integer;
  v_likes integer;
  v_comments integer;
  v_mentions integer;
  v_status integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select p.push_enabled, p.likes, p.comments, p.mentions, p.status
  into v_push, v_likes, v_comments, v_mentions, v_status
  from public.notification_preferences p
  where p.user_id = v_uid;
  if not found then
    return query select 1, 1, 1, 1, 1;
  else
    return query select v_push, v_likes, v_comments, v_mentions, v_status;
  end if;
end;
$$;

create or replace function public.findback_set_notification_preferences_client(
  p_push_enabled boolean,
  p_likes boolean,
  p_comments boolean,
  p_mentions boolean,
  p_status boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  insert into public.notification_preferences
    (user_id, push_enabled, likes, comments, mentions, status, updated_at)
  values (
    v_uid,
    (p_push_enabled)::int, (p_likes)::int, (p_comments)::int, (p_mentions)::int, (p_status)::int,
    v_now
  )
  on conflict (user_id) do update set
    push_enabled = excluded.push_enabled,
    likes = excluded.likes,
    comments = excluded.comments,
    mentions = excluded.mentions,
    status = excluded.status,
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.findback_register_device_token_client(text, text) from public, anon;
grant execute on function public.findback_register_device_token_client(text, text) to authenticated;

revoke all on function public.findback_unregister_device_token_client(text) from public, anon;
grant execute on function public.findback_unregister_device_token_client(text) to authenticated;

revoke all on function public.findback_get_notification_preferences_client() from public, anon;
grant execute on function public.findback_get_notification_preferences_client() to authenticated;

revoke all on function public.findback_set_notification_preferences_client(boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.findback_set_notification_preferences_client(boolean, boolean, boolean, boolean, boolean) to authenticated;

comment on table public.device_tokens
  is 'FindBack FCM device tokens (one per user/token). Read only by push-dispatch via service role.';
comment on table public.notification_preferences
  is 'FindBack per-user push/notification category preferences. Absent row means all categories on.';
