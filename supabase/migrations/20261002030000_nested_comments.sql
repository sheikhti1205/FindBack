-- FindBack — nested (threaded) comments.
--
-- Adds a self-referential `parent_id` plus a denormalised `depth` so the client
-- can render a bounded tree without recursive queries. Replies reuse the
-- existing COMMENT notification type: the post owner already gets one, and the
-- parent-comment author gets one too (deduplicated when they are the same
-- person). `findback_add_comment_client` gains an optional `p_parent_id`; the
-- old two-argument signature is dropped so PostgREST resolves a single function.

alter table public.comments
  add column if not exists parent_id text references public.comments(id) on delete cascade;
alter table public.comments
  add column if not exists depth integer not null default 0;

create index if not exists idx_comments_parent
  on public.comments (parent_id)
  where parent_id is not null;

-- ---------------------------------------------------------------------------
-- List: include parent_id + depth so the client can build the tree.
-- ---------------------------------------------------------------------------
drop function if exists public.findback_list_comments_client(text);

create or replace function public.findback_list_comments_client(p_post_id text)
returns table (
  id text,
  post_id text,
  parent_id text,
  depth integer,
  body text,
  created_at text,
  updated_at text,
  author_id text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    c.id, c.post_id, c.parent_id, c.depth, c.body, c.created_at, c.updated_at,
    c.user_id as author_id,
    u.username as author_username,
    u.email_verified as author_email_verified,
    u.phone_verified as author_phone_verified,
    u.avatar_url as author_avatar_url,
    u.created_at as author_created_at
  from public.comments c
  join public.users u on u.id = c.user_id
  where c.post_id = p_post_id
  order by c.created_at asc
  limit 500;
$$;

revoke all on function public.findback_list_comments_client(text) from public, anon;
grant execute on function public.findback_list_comments_client(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Add: optional parent, validated to be on the same report and within depth.
-- ---------------------------------------------------------------------------
drop function if exists public.findback_add_comment_client(text, text);

create or replace function public.findback_add_comment_client(
  p_post_id text,
  p_body text,
  p_parent_id text default null
)
returns table (
  id text,
  post_id text,
  parent_id text,
  depth integer,
  body text,
  created_at text,
  updated_at text,
  author_id text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_id text := gen_random_uuid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_parent_post text;
  v_parent_depth integer;
  v_depth integer := 0;
  v_parent text := nullif(btrim(p_parent_id), '');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_body is null or char_length(btrim(p_body)) < 1
     or char_length(btrim(p_body)) > 1000 then
    raise exception 'Comment must be 1-1000 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from public.item_posts p where p.id = p_post_id) then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;

  if v_parent is not null then
    select c.post_id, c.depth into v_parent_post, v_parent_depth
    from public.comments c
    where c.id = v_parent;
    if not found then
      raise exception 'Parent comment not found' using errcode = 'P0002';
    end if;
    if v_parent_post <> p_post_id then
      raise exception 'Parent comment belongs to another report' using errcode = '22023';
    end if;
    -- Bounded tree: five levels below the root.
    if v_parent_depth >= 5 then
      raise exception 'Reply depth exceeded' using errcode = '22023';
    end if;
    v_depth := v_parent_depth + 1;
  end if;

  insert into public.comments (id, post_id, user_id, parent_id, depth, body, created_at, updated_at)
  values (v_id, p_post_id, v_uid, v_parent, v_depth, btrim(p_body), v_now, v_now);

  return query
    select
      c.id, c.post_id, c.parent_id, c.depth, c.body, c.created_at, c.updated_at,
      c.user_id, u.username, u.email_verified, u.phone_verified,
      u.avatar_url, u.created_at
    from public.comments c
    join public.users u on u.id = c.user_id
    where c.id = v_id;
end;
$$;

revoke all on function public.findback_add_comment_client(text, text, text) from public, anon;
grant execute on function public.findback_add_comment_client(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Notifications: replies also notify the parent-comment author (COMMENT type),
-- unless that author is the replier or the post owner (who is already notified).
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
  v_parent_author text;
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

  if new.parent_id is not null then
    select c.user_id into v_parent_author
    from public.comments c
    where c.id = new.parent_id;
    if v_parent_author is not null
       and v_parent_author <> new.user_id
       and v_parent_author is distinct from v_owner then
      perform public.findback_insert_notification(
        v_parent_author, new.user_id, 'COMMENT', new.post_id, new.id, new.body
      );
    end if;
  end if;

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
    if v_mentioned_id = new.user_id
       or v_mentioned_id = v_owner
       or v_mentioned_id is not distinct from v_parent_author then
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

revoke all on function public.findback_notify_comment() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: include parent_id + depth in the sanitized comment payload.
-- ---------------------------------------------------------------------------
create or replace function public.findback_broadcast_comment_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post text;
  v_author record;
begin
  if tg_op = 'INSERT' then
    v_post := new.post_id;
    select u.username, u.email_verified, u.phone_verified, u.avatar_url, u.created_at
      into v_author
      from public.users u
     where u.id = new.user_id;

    perform realtime.send(
      jsonb_build_object('comment', jsonb_build_object(
        'id', new.id,
        'postId', new.post_id,
        'parentId', new.parent_id,
        'depth', new.depth,
        'body', new.body,
        'createdAt', new.created_at,
        'updatedAt', new.updated_at,
        'author', jsonb_build_object(
          'id', new.user_id,
          'username', v_author.username,
          'emailVerified', coalesce(v_author.email_verified, 0)::boolean,
          'phoneVerified', coalesce(v_author.phone_verified, 0)::boolean,
          'avatarUrl', v_author.avatar_url,
          'createdAt', v_author.created_at
        )
      )),
      'comment:added', 'post:' || v_post, true
    );
  elsif tg_op = 'DELETE' then
    v_post := old.post_id;
    perform realtime.send(
      jsonb_build_object('commentId', old.id),
      'comment:deleted', 'post:' || v_post, true
    );
  end if;

  perform realtime.send(
    jsonb_build_object('postId', v_post),
    'post:changed', 'feed', true
  );
  return null;
end;
$$;

revoke all on function public.findback_broadcast_comment_change() from public, anon, authenticated;
