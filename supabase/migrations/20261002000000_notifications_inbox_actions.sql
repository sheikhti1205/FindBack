-- FindBack — notification inbox actions: read/unread, soft delete, restore.
--
-- Extends 20260928000000_notifications.sql. The inbox gains an explicit
-- read/unread toggle, a soft-delete timestamp, and a restore path. Soft delete
-- keeps history (no data loss for a mis-tap) while the default list, the unread
-- count, and the delete/restore helpers all stay scoped to auth.uid()::text.
--
-- Privacy boundary is unchanged: `public.notifications` keeps RLS with no
-- policies; only the SECURITY DEFINER RPCs below touch rows, EXECUTE granted
-- ONLY to `authenticated`.

-- ---------------------------------------------------------------------------
-- Column: soft-delete marker (NULL = active).
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists deleted_at text;

-- Partial index for the active inbox and its unread subset.
create index if not exists idx_notifications_user_active
  on public.notifications (user_id, created_at desc)
  where deleted_at is null;
create index if not exists idx_notifications_user_deleted
  on public.notifications (user_id, deleted_at desc)
  where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- Insert helper: dedupe only against ACTIVE rows, so deleting a notification
-- and then repeating the same action can notify again.
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
        and n.deleted_at is null
    ) then
      return;
    end if;
  end if;
  insert into public.notifications
    (id, user_id, actor_id, type, post_id, comment_id, preview, read, created_at, deleted_at)
  values
    (gen_random_uuid()::text, p_user_id, p_actor_id, p_type,
     p_post_id, p_comment_id, left(nullif(p_preview, ''), 200), 0, v_now, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reaction trigger: only supersede ACTIVE unread rows on a reaction switch, so
-- a previously deleted LIKE/DISLIKE row does not block the new notification.
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
  delete from public.notifications n
  where n.user_id = v_owner
    and n.actor_id = new.user_id
    and n.type in ('LIKE', 'DISLIKE')
    and n.post_id = new.post_id
    and n.comment_id is null
    and n.read = 0
    and n.deleted_at is null;
  perform public.findback_insert_notification(
    v_owner, new.user_id, new.type, new.post_id, null, v_title
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs. `findback_list_notifications_client` gains a deleted flag, so
-- the old zero-argument signature must be dropped before recreating it.
-- ---------------------------------------------------------------------------
drop function if exists public.findback_list_notifications_client();

create or replace function public.findback_list_notifications_client(
  p_deleted boolean default false
)
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
      and (
        (p_deleted and n.deleted_at is not null)
        or (not p_deleted and n.deleted_at is null)
      )
    order by
      case when p_deleted then n.deleted_at else n.created_at end desc,
      n.id desc
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
  where n.user_id = v_uid and n.read = 0 and n.deleted_at is null;
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
    and n.deleted_at is null
    and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

create or replace function public.findback_mark_notifications_unread_client(p_ids text[] default null)
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
  set read = 0
  where n.user_id = v_uid
    and n.read = 1
    and n.deleted_at is null
    and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

create or replace function public.findback_delete_notifications_client(p_ids text[] default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  update public.notifications n
  set deleted_at = v_now, read = 1
  where n.user_id = v_uid
    and n.deleted_at is null
    and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

create or replace function public.findback_restore_notifications_client(p_ids text[] default null)
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
  set deleted_at = null
  where n.user_id = v_uid
    and n.deleted_at is not null
    and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.findback_list_notifications_client(boolean) from public, anon;
grant execute on function public.findback_list_notifications_client(boolean) to authenticated;

revoke all on function public.findback_notification_count_client() from public, anon;
grant execute on function public.findback_notification_count_client() to authenticated;

revoke all on function public.findback_mark_notifications_read_client(text[]) from public, anon;
grant execute on function public.findback_mark_notifications_read_client(text[]) to authenticated;

revoke all on function public.findback_mark_notifications_unread_client(text[]) from public, anon;
grant execute on function public.findback_mark_notifications_unread_client(text[]) to authenticated;

revoke all on function public.findback_delete_notifications_client(text[]) from public, anon;
grant execute on function public.findback_delete_notifications_client(text[]) to authenticated;

revoke all on function public.findback_restore_notifications_client(text[]) from public, anon;
grant execute on function public.findback_restore_notifications_client(text[]) to authenticated;

comment on function public.findback_list_notifications_client(boolean)
  is 'FindBack notification inbox (authenticated): caller-owned rows newest first; p_deleted selects the soft-deleted view. Max 100.';
comment on function public.findback_mark_notifications_unread_client(text[])
  is 'FindBack mark notifications unread (authenticated): caller-owned active ids, or all when p_ids is null. Returns rows updated.';
comment on function public.findback_delete_notifications_client(text[])
  is 'FindBack soft-delete notifications (authenticated): caller-owned active ids, or all when p_ids is null. Returns rows updated.';
comment on function public.findback_restore_notifications_client(text[])
  is 'FindBack restore soft-deleted notifications (authenticated): caller-owned deleted ids, or all when p_ids is null. Returns rows updated.';
