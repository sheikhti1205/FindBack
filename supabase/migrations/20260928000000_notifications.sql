-- FindBack — real notifications inbox.
--
-- Mobile reads a per-user notification inbox directly from Supabase via narrow
-- client RPCs (same pattern as the social client RPCs in
-- 20260914200000_social_client_rpcs.sql). Rows are produced by SECURITY
-- DEFINER triggers on `reactions` and `comments`, so the inbox works no
-- matter which writer path inserts the row (client RPCs today, Node tomorrow).
--
-- Privacy boundary:
--   * `public.notifications` has RLS enabled with NO policies (matching the
--     repo convention from 20260912000000_init.sql): the Data API with a
--     publishable key cannot read or write these rows directly.
--   * Triggers run as SECURITY DEFINER (they must see post owners and
--     mentioned users across RLS) and are revoked from public/anon/
--     authenticated (same convention as 20260914210000_realtime_broadcast.sql).
--   * The three `findback_*_client` RPCs below run as SECURITY DEFINER so they
--     can read through the policy-less RLS, but scope every row to
--     auth.uid()::text — the caller only ever sees their own inbox. EXECUTE is
--     granted ONLY to `authenticated`.
--
-- Conventions kept from the rest of the schema:
--   * TEXT primary keys (UUIDs generated server-side) and TEXT ISO-8601
--     timestamps (UTC, `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`).
--   * integer 0/1 booleans for `read`.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  -- Nullable only for system STATUS rows (no actor performed them); all
  -- reaction/comment/mention rows always carry an actor.
  actor_id text references public.users(id) on delete cascade,
  type text not null check (type in ('LIKE', 'DISLIKE', 'COMMENT', 'MENTION', 'STATUS')),
  post_id text references public.item_posts(id) on delete cascade,
  comment_id text references public.comments(id) on delete cascade,
  preview text,
  read integer not null default 0 check (read in (0, 1)),
  created_at text not null
);

-- Existing inboxes created before actor_id became nullable for STATUS rows.
alter table public.notifications alter column actor_id drop not null;

create index if not exists idx_notifications_user_created
  on public.notifications (user_id, created_at desc);
create index if not exists idx_notifications_user_unread
  on public.notifications (user_id) where read = 0;

-- RLS enabled with NO policies: only the DEFINER functions below touch rows.
alter table public.notifications enable row level security;

-- ---------------------------------------------------------------------------
-- Helper: insert one notification row (shared by both triggers).
-- ---------------------------------------------------------------------------
create or replace function public.findback_insert_notification(
  p_user_id text,
  p_actor_id text,
  p_type text,
  p_post_id text,
  p_comment_id text,
  p_preview text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  -- Never notify yourself; never double-notify the same actor for the same
  -- post/comment/type. A NULL actor is allowed only for system STATUS rows
  -- (the status trigger has no actor to attribute); every other type must
  -- carry an actor. Reaction switches stay one current row because the
  -- reaction trigger deletes the actor's superseded UNREAD LIKE/DISLIKE row
  -- on the same post before inserting the new one.
  if p_user_id is null or p_user_id = p_actor_id then
    return;
  end if;
  if p_actor_id is null and p_type <> 'STATUS' then
    return;
  end if;
  if p_comment_id is null then
    if exists (
      select 1 from public.notifications n
      where n.user_id = p_user_id
        and n.actor_id is not distinct from p_actor_id
        and n.type = p_type
        and n.post_id is not distinct from p_post_id
        and n.comment_id is null
    ) then
      return;
    end if;
  end if;
  insert into public.notifications
    (id, user_id, actor_id, type, post_id, comment_id, preview, read, created_at)
  values
    (gen_random_uuid()::text, p_user_id, p_actor_id, p_type,
     p_post_id, p_comment_id, left(nullif(p_preview, ''), 200), 0, v_now);
end;
$$;

-- ---------------------------------------------------------------------------
-- reactions INSERT -> notify the post owner (LIKE / DISLIKE, skip self).
-- A reaction switch (LIKE -> DISLIKE or back) deletes the actor's existing
-- UNREAD LIKE/DISLIKE row on the same post first, so switches stay one
-- current row. Read rows are history and are left alone.
-- ---------------------------------------------------------------------------
create or replace function public.findback_notify_reaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text;
  v_title text;
begin
  select p.user_id, p.title into v_owner, v_title
  from public.item_posts p
  where p.id = new.post_id;
  if v_owner is null or v_owner = new.user_id then
    return new;
  end if;
  -- Reaction switch: drop the superseded UNREAD LIKE/DISLIKE row from the
  -- same actor on this post so only the newest reaction notifies.
  delete from public.notifications n
  where n.user_id = v_owner
    and n.actor_id = new.user_id
    and n.type in ('LIKE', 'DISLIKE')
    and n.post_id = new.post_id
    and n.comment_id is null
    and n.read = 0;
  perform public.findback_insert_notification(
    v_owner, new.user_id, new.type, new.post_id, null, v_title
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- comments INSERT -> notify the post owner (COMMENT) + @username mentions
-- (MENTION rows via a users lookup). Self-notifies and duplicates are
-- skipped: a mentioned post owner keeps only their COMMENT row.
-- ---------------------------------------------------------------------------
create or replace function public.findback_notify_comment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text;
  v_title text;
  v_handle text;
  v_mentioned_id text;
  v_seen text[] := '{}';
begin
  select p.user_id, p.title into v_owner, v_title
  from public.item_posts p
  where p.id = new.post_id;

  if v_owner is not null and v_owner <> new.user_id then
    perform public.findback_insert_notification(
      v_owner, new.user_id, 'COMMENT', new.post_id, new.id, new.body
    );
  end if;

  -- @username handles: letters, digits, underscore (usernames are unique
  -- case-insensitively, see ux_users_username_lower).
  for v_handle in
    select distinct m[1]
    from regexp_matches(new.body, '@([A-Za-z0-9_]{1,30})', 'g') as m
  loop
    if v_handle = any (v_seen) then
      continue;
    end if;
    v_seen := v_seen || v_handle;
    select u.id into v_mentioned_id
    from public.users u
    where lower(u.username) = lower(v_handle);
    if v_mentioned_id is null then
      continue;
    end if;
    -- Skip self-notify and skip duplicates: the post owner already has a
    -- COMMENT row for this comment, and each mentioned user gets at most one
    -- MENTION row per comment.
    if v_mentioned_id = new.user_id or v_mentioned_id = v_owner then
      continue;
    end if;
    if exists (
      select 1 from public.notifications n
      where n.user_id = v_mentioned_id
        and n.comment_id = new.id
        and n.type = 'MENTION'
    ) then
      continue;
    end if;
    perform public.findback_insert_notification(
      v_mentioned_id, new.user_id, 'MENTION', new.post_id, new.id, new.body
    );
  end loop;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- item_posts status UPDATE -> notify the post owner when a report moves to
-- MATCHED / RECOVERED / CLOSED. The trigger sees only the row, not who
-- issued the UPDATE, so there is no actor to attribute: the row is a system
-- STATUS notification with a NULL actor (actor_id is nullable for exactly
-- this case) and the preview "Your report status changed to X".
-- ---------------------------------------------------------------------------
create or replace function public.findback_notify_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('MATCHED', 'RECOVERED', 'CLOSED')
     and new.user_id is not null then
    perform public.findback_insert_notification(
      new.user_id, null, 'STATUS', new.id, null,
      'Your report status changed to ' || new.status
    );
  end if;
  return new;
end;
$$;

revoke all on function public.findback_insert_notification(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.findback_notify_reaction() from public, anon, authenticated;
revoke all on function public.findback_notify_comment() from public, anon, authenticated;
revoke all on function public.findback_notify_status() from public, anon, authenticated;

drop trigger if exists trg_findback_notify_reaction on public.reactions;
create trigger trg_findback_notify_reaction
  after insert on public.reactions
  for each row execute function public.findback_notify_reaction();

drop trigger if exists trg_findback_notify_comment on public.comments;
create trigger trg_findback_notify_comment
  after insert on public.comments
  for each row execute function public.findback_notify_comment();

drop trigger if exists trg_findback_notify_status on public.item_posts;
create trigger trg_findback_notify_status
  after update of status on public.item_posts
  for each row execute function public.findback_notify_status();

-- ---------------------------------------------------------------------------
-- Client RPCs: own inbox only (actor username + post title joined in).
-- ---------------------------------------------------------------------------
create or replace function public.findback_list_notifications_client()
returns table (
  id text,
  type text,
  preview text,
  read integer,
  created_at text,
  actor_id text,
  actor_username text,
  post_id text,
  post_title text,
  comment_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return query
    select
      n.id, n.type, n.preview, n.read, n.created_at,
      n.actor_id, u.username as actor_username,
      n.post_id, p.title as post_title,
      n.comment_id
    from public.notifications n
    left join public.users u on u.id = n.actor_id
    left join public.item_posts p on p.id = n.post_id
    where n.user_id = v_uid
    order by n.created_at desc, n.id desc
    limit 100;
end;
$$;

create or replace function public.findback_notification_count_client()
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
  select count(*)::integer into v_count
  from public.notifications n
  where n.user_id = v_uid and n.read = 0;
  return coalesce(v_count, 0);
end;
$$;

create or replace function public.findback_mark_notifications_read_client(p_ids text[] default null)
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
  update public.notifications n
  set read = 1
  where n.user_id = v_uid
    and n.read = 0
    and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.findback_list_notifications_client() from public, anon;
grant execute on function public.findback_list_notifications_client() to authenticated;

revoke all on function public.findback_notification_count_client() from public, anon;
grant execute on function public.findback_notification_count_client() to authenticated;

revoke all on function public.findback_mark_notifications_read_client(text[]) from public, anon;
grant execute on function public.findback_mark_notifications_read_client(text[]) to authenticated;

comment on function public.findback_list_notifications_client()
  is 'FindBack notification inbox (authenticated): caller-owned rows newest first with actor username + post title. Max 100.';
comment on function public.findback_notification_count_client()
  is 'FindBack unread notification count (authenticated): caller-owned rows with read = 0.';
comment on function public.findback_mark_notifications_read_client(text[])
  is 'FindBack mark notifications read (authenticated): caller-owned ids, or all when p_ids is null. Returns rows updated.';
