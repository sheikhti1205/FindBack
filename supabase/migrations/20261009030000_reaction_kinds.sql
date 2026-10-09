-- FindBack — multi-kind reactions (W3.3).
--
-- ADDITIVE / NON-DESTRUCTIVE. Widens the reaction vocabulary from the original
-- LIKE/DISLIKE pair to a real four-kind FindBack model:
--
--   LOVE, HELPFUL, SUPPORT, WOW
--
-- Legacy LIKE/DISLIKE rows remain valid and are never deleted; only the CHECK
-- constraint on `reactions.type` is widened (drop + re-add, no data touched).
--
-- Display mapping (canonical, applied by every count below):
--   * LIKE   -> LOVE   (a legacy like is a love)
--   * DISLIKE stays DISLIKE (kept for backward compatibility; no new-kind peer)
--   * LOVE / HELPFUL / SUPPORT / WOW are stored and counted as themselves.
-- Counts are exposed as a `reaction_counts` jsonb object keyed by the canonical
-- kind, so PostgREST returns a stable shape regardless of which kinds are used.
--
-- Comments gain reactions for the first time (`comment_reactions`). Privacy
-- mirrors post reactions: the wire only ever carries aggregate counts plus the
-- caller's own reaction. The caller's own row is located by a deterministic id
-- md5('comment_reaction|<comment_id>|<uid>') because `comment_reactions.user_id`
-- is deliberately NOT granted to `authenticated` (never exposed, never
-- filterable). anon gets no access at all: Supabase's default ACL grants anon
-- EXECUTE on new functions and DML on new tables, so every new object is
-- explicitly revoked from anon here.
--
-- No table/column drops and no data deletion.

-- ---------------------------------------------------------------------------
-- 1. Widen reactions.type (LIKE/DISLIKE retained, new kinds added).
--
-- The original constraint was declared inline in the init migration, so its
-- name is Postgres-generated. Drop any existing CHECK on `reactions.type`
-- first (robust to the generated name), then re-add the widened one.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'reactions'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%type%'
  loop
    execute format('alter table public.reactions drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.reactions
  add constraint reactions_type_check
  check (type in ('LIKE', 'DISLIKE', 'LOVE', 'HELPFUL', 'SUPPORT', 'WOW'));

-- ---------------------------------------------------------------------------
-- 2. comment_reactions: same vocabulary, scoped to comments.
-- ---------------------------------------------------------------------------
create table if not exists public.comment_reactions (
  id text primary key,
  comment_id text not null references public.comments(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  type text not null,
  created_at text not null,
  unique (comment_id, user_id),
  constraint comment_reactions_type_check
    check (type in ('LIKE', 'DISLIKE', 'LOVE', 'HELPFUL', 'SUPPORT', 'WOW'))
);

create index if not exists idx_comment_reactions_comment
  on public.comment_reactions (comment_id);

alter table public.comment_reactions enable row level security;

-- Strip the Supabase default ACL entirely (anon included), then grant the
-- narrow client surface: aggregate columns only, never user_id.
revoke all on public.comment_reactions from anon, authenticated;
grant select (id, comment_id, type) on public.comment_reactions to authenticated;
grant insert on public.comment_reactions to authenticated;
grant delete on public.comment_reactions to authenticated;

-- READ: aggregate-only rows (id/comment_id/type). Mirrors
-- reactions_select_authenticated; required for the SECURITY INVOKER comment
-- list RPC to read counts.
drop policy if exists comment_reactions_select_authenticated on public.comment_reactions;
create policy comment_reactions_select_authenticated
  on public.comment_reactions for select to authenticated
  using (true);

-- WRITE: owner only, on an existing comment.
drop policy if exists comment_reactions_insert_own on public.comment_reactions;
create policy comment_reactions_insert_own
  on public.comment_reactions for insert to authenticated
  with check (
    user_id = (select auth.uid())::text
    and exists (select 1 from public.comments c where c.id = comment_reactions.comment_id)
  );

drop policy if exists comment_reactions_delete_own on public.comment_reactions;
create policy comment_reactions_delete_own
  on public.comment_reactions for delete to authenticated
  using (user_id = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- 3. Post reactions: accept the new kinds, return per-kind counts.
--
-- Return signature grows a `reaction_counts jsonb` column, so the function is
-- dropped and recreated. `like_count`/`dislike_count`/`my_reaction` keep their
-- existing meaning for current callers (my_reaction is the raw stored kind).
-- ---------------------------------------------------------------------------
drop function if exists public.findback_react_client(text, text);

create or replace function public.findback_react_client(p_post_id text, p_type text)
returns table (
  post_id text,
  like_count bigint,
  dislike_count bigint,
  my_reaction text,
  reaction_counts jsonb
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_id text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_type is not null
     and p_type not in ('LIKE', 'DISLIKE', 'LOVE', 'HELPFUL', 'SUPPORT', 'WOW') then
    raise exception 'Invalid reaction type' using errcode = '22023';
  end if;
  if not exists (select 1 from public.item_posts p where p.id = p_post_id) then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;

  -- RLS restricts this delete to the caller's own reaction.
  delete from public.reactions r where r.post_id = p_post_id;

  if p_type is not null then
    v_id := md5('reaction|' || p_post_id || '|' || v_uid);
    insert into public.reactions (id, post_id, user_id, type, created_at)
    values (v_id, p_post_id, v_uid, p_type, v_now);
  end if;

  return query
    select
      p_post_id,
      (select count(*) from public.reactions r
        where r.post_id = p_post_id and r.type = 'LIKE'),
      (select count(*) from public.reactions r
        where r.post_id = p_post_id and r.type = 'DISLIKE'),
      p_type,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                 count(*) as n
          from public.reactions r
          where r.post_id = p_post_id
          group by 1
        ) t
      ), '{}'::jsonb);
end;
$$;

revoke all on function public.findback_react_client(text, text) from public, anon;
grant execute on function public.findback_react_client(text, text) to authenticated;

comment on function public.findback_react_client(text, text)
  is 'FindBack react (authenticated): one reaction per user (LIKE/DISLIKE/LOVE/HELPFUL/SUPPORT/WOW), null removes, returns counts + per-kind reaction_counts + caller reaction.';

-- ---------------------------------------------------------------------------
-- 4. Comment reactions: set the caller's reaction, return per-kind counts.
--
-- SECURITY DEFINER (per W3.3): bypasses RLS, therefore it validates auth.uid()
-- itself and scopes the delete to the caller's own row explicitly. anon revoked.
-- ---------------------------------------------------------------------------
create or replace function public.findback_react_comment_client(p_comment_id text, p_type text)
returns table (
  comment_id text,
  my_reaction text,
  reaction_counts jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_id text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_type is not null
     and p_type not in ('LIKE', 'DISLIKE', 'LOVE', 'HELPFUL', 'SUPPORT', 'WOW') then
    raise exception 'Invalid reaction type' using errcode = '22023';
  end if;
  if not exists (select 1 from public.comments c where c.id = p_comment_id) then
    raise exception 'Comment not found' using errcode = 'P0002';
  end if;

  -- Explicit owner scope (SECURITY DEFINER does not consult the RLS policy).
  delete from public.comment_reactions cr
   where cr.comment_id = p_comment_id
     and cr.user_id = v_uid;

  if p_type is not null then
    v_id := md5('comment_reaction|' || p_comment_id || '|' || v_uid);
    insert into public.comment_reactions (id, comment_id, user_id, type, created_at)
    values (v_id, p_comment_id, v_uid, p_type, v_now);
  end if;

  return query
    select
      p_comment_id,
      p_type,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when cr.type = 'LIKE' then 'LOVE' else cr.type end as kind,
                 count(*) as n
          from public.comment_reactions cr
          where cr.comment_id = p_comment_id
          group by 1
        ) t
      ), '{}'::jsonb);
end;
$$;

revoke all on function public.findback_react_comment_client(text, text) from public, anon;
grant execute on function public.findback_react_comment_client(text, text) to authenticated;

comment on function public.findback_react_comment_client(text, text)
  is 'FindBack comment react (authenticated): one reaction per user on a comment, null removes, returns per-kind reaction_counts + caller reaction.';

-- ---------------------------------------------------------------------------
-- 5. Comment list: preserve every existing column, add per-comment reaction
--    summary (counts + the caller's own reaction, located by deterministic id).
--
-- SECURITY INVOKER: relies on the column grants + SELECT policy above.
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
  author_created_at text,
  reaction_counts jsonb,
  my_reaction text
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
    u.created_at as author_created_at,
    coalesce((
      select jsonb_object_agg(t.kind, t.n)
      from (
        select case when cr.type = 'LIKE' then 'LOVE' else cr.type end as kind,
               count(*) as n
        from public.comment_reactions cr
        where cr.comment_id = c.id
        group by 1
      ) t
    ), '{}'::jsonb) as reaction_counts,
    (select cr2.type from public.comment_reactions cr2
      where cr2.id = md5('comment_reaction|' || c.id || '|' || (select auth.uid())::text))
      as my_reaction
  from public.comments c
  join public.users u on u.id = c.user_id
  where c.post_id = p_post_id
  order by c.created_at asc
  limit 500;
$$;

revoke all on function public.findback_list_comments_client(text) from public, anon;
grant execute on function public.findback_list_comments_client(text) to authenticated;

comment on function public.findback_list_comments_client(text)
  is 'FindBack comment list (authenticated): public comment tree + author projection + per-comment per-kind reaction_counts and caller my_reaction. Never returns reaction user ids.';

-- ---------------------------------------------------------------------------
-- 6. Realtime: post reactions carry per-kind counts too (additive; the existing
--    likeCount/dislikeCount keys are retained for current subscribers).
-- ---------------------------------------------------------------------------
create or replace function public.findback_broadcast_reaction_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post text;
  v_like bigint;
  v_dislike bigint;
  v_counts jsonb;
begin
  v_post := case when tg_op = 'DELETE' then old.post_id else new.post_id end;

  select
    count(*) filter (where r.type = 'LIKE'),
    count(*) filter (where r.type = 'DISLIKE')
  into v_like, v_dislike
  from public.reactions r
  where r.post_id = v_post;

  select coalesce(jsonb_object_agg(t.kind, t.n), '{}'::jsonb)
  into v_counts
  from (
    select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
           count(*) as n
    from public.reactions r
    where r.post_id = v_post
    group by 1
  ) t;

  perform realtime.send(
    jsonb_build_object(
      'postId', v_post,
      'likeCount', v_like,
      'dislikeCount', v_dislike,
      'reactionCounts', v_counts
    ),
    'reaction:changed', 'post:' || v_post, true
  );
  perform realtime.send(
    jsonb_build_object('postId', v_post, 'change', 'REACTION_CHANGE'),
    'post:changed', 'feed', true
  );
  return null;
end;
$$;

revoke all on function public.findback_broadcast_reaction_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Realtime: comment reactions resolve their post and broadcast
--    reaction:changed on post:<postId> (mirrors the post reaction trigger),
--    carrying commentId so the client can target the comment.
-- ---------------------------------------------------------------------------
create or replace function public.findback_broadcast_comment_reaction_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment text;
  v_post text;
  v_counts jsonb;
begin
  v_comment := case when tg_op = 'DELETE' then old.comment_id else new.comment_id end;

  select c.post_id into v_post
  from public.comments c
  where c.id = v_comment;

  -- Cascaded deletes (comment removed) leave nothing to broadcast: the
  -- comment:deleted event already fired.
  if v_post is null then
    return null;
  end if;

  select coalesce(jsonb_object_agg(t.kind, t.n), '{}'::jsonb)
  into v_counts
  from (
    select case when cr.type = 'LIKE' then 'LOVE' else cr.type end as kind,
           count(*) as n
    from public.comment_reactions cr
    where cr.comment_id = v_comment
    group by 1
  ) t;

  perform realtime.send(
    jsonb_build_object(
      'postId', v_post,
      'commentId', v_comment,
      'reactionCounts', v_counts
    ),
    'reaction:changed', 'post:' || v_post, true
  );
  perform realtime.send(
    jsonb_build_object('postId', v_post, 'change', 'REACTION_CHANGE'),
    'post:changed', 'feed', true
  );
  return null;
end;
$$;

revoke all on function public.findback_broadcast_comment_reaction_change() from public, anon, authenticated;

drop trigger if exists trg_findback_broadcast_comment_reaction on public.comment_reactions;
create trigger trg_findback_broadcast_comment_reaction
  after insert or update or delete on public.comment_reactions
  for each row execute function public.findback_broadcast_comment_reaction_change();
