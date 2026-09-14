-- FindBack — direct comments / reactions / ratings (Block 10F).
--
-- Mobile no longer calls Node for social features. Everything here is a narrow
-- SECURITY INVOKER RPC executable only by `authenticated`; the actor is always
-- auth.uid()::text and never accepted from the caller.
--
-- Comments are public content: authenticated may read them (with a public author
-- projection via the users table) and may insert/delete their own. A post owner
-- may also delete a comment on their own post (mirrors the Node service's
-- moderation rule).
--
-- Reactions and ratings stay aggregate-only on the wire: `authenticated` can
-- read reactions(id, post_id, type) and ratings(id, post_id, score) with
-- `using (true)` for feed counts, but never `user_id` — the per-user lists are
-- not exposed. The caller's own row is therefore located by a deterministic id
-- md5('<kind>|<post_id>|<uid>') rather than by filtering on `user_id`. Writes
-- are owner-scoped by RLS policies (INSERT WITH CHECK, DELETE USING), so an
-- INVOKER function can switch a reaction with delete-then-insert without ever
-- reading or accepting another user's identity.

-- ---------------------------------------------------------------------------
-- Comments: public content, owner-scoped writes
-- ---------------------------------------------------------------------------
grant select (id, post_id, user_id, body, created_at, updated_at)
  on public.comments to authenticated;
grant insert on public.comments to authenticated;
grant delete on public.comments to authenticated;

drop policy if exists comments_insert_own on public.comments;
create policy comments_insert_own
  on public.comments for insert to authenticated
  with check (
    user_id = (select auth.uid())::text
    and exists (select 1 from public.item_posts p where p.id = comments.post_id)
  );

drop policy if exists comments_delete_own on public.comments;
create policy comments_delete_own
  on public.comments for delete to authenticated
  using (
    user_id = (select auth.uid())::text
    or exists (
      select 1 from public.item_posts p
      where p.id = comments.post_id and p.user_id = (select auth.uid())::text
    )
  );

create or replace function public.findback_list_comments_client(p_post_id text)
returns table (
  id text,
  post_id text,
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
    c.id, c.post_id, c.body, c.created_at, c.updated_at,
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

create or replace function public.findback_add_comment_client(p_post_id text, p_body text)
returns table (
  id text,
  post_id text,
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

  insert into public.comments (id, post_id, user_id, body, created_at, updated_at)
  values (v_id, p_post_id, v_uid, btrim(p_body), v_now, v_now);

  return query
    select
      c.id, c.post_id, c.body, c.created_at, c.updated_at,
      c.user_id, u.username, u.email_verified, u.phone_verified,
      u.avatar_url, u.created_at
    from public.comments c
    join public.users u on u.id = c.user_id
    where c.id = v_id;
end;
$$;

revoke all on function public.findback_add_comment_client(text, text) from public, anon;
grant execute on function public.findback_add_comment_client(text, text) to authenticated;

create or replace function public.findback_delete_comment_client(p_comment_id text)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  delete from public.comments c
   where c.id = p_comment_id
     and (
       c.user_id = v_uid
       or exists (
         select 1 from public.item_posts p
         where p.id = c.post_id and p.user_id = v_uid
       )
     );

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Comment not found or not allowed' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke all on function public.findback_delete_comment_client(text) from public, anon;
grant execute on function public.findback_delete_comment_client(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reactions: caller-only writes, aggregate-only reads
-- ---------------------------------------------------------------------------
grant insert on public.reactions to authenticated;
grant delete on public.reactions to authenticated;

drop policy if exists reactions_insert_own on public.reactions;
create policy reactions_insert_own
  on public.reactions for insert to authenticated
  with check (
    user_id = (select auth.uid())::text
    and exists (select 1 from public.item_posts p where p.id = reactions.post_id)
  );

drop policy if exists reactions_delete_own on public.reactions;
create policy reactions_delete_own
  on public.reactions for delete to authenticated
  using (user_id = (select auth.uid())::text);

create or replace function public.findback_react_client(p_post_id text, p_type text)
returns table (
  post_id text,
  like_count bigint,
  dislike_count bigint,
  my_reaction text
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
  if p_type is not null and p_type not in ('LIKE', 'DISLIKE') then
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
      (select count(*) from public.reactions r where r.post_id = p_post_id and r.type = 'LIKE'),
      (select count(*) from public.reactions r where r.post_id = p_post_id and r.type = 'DISLIKE'),
      p_type;
end;
$$;

revoke all on function public.findback_react_client(text, text) from public, anon;
grant execute on function public.findback_react_client(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Ratings: caller-only writes, aggregate-only reads
-- ---------------------------------------------------------------------------
grant insert on public.ratings to authenticated;
grant delete on public.ratings to authenticated;

drop policy if exists ratings_insert_own on public.ratings;
create policy ratings_insert_own
  on public.ratings for insert to authenticated
  with check (
    user_id = (select auth.uid())::text
    and exists (select 1 from public.item_posts p where p.id = ratings.post_id)
  );

drop policy if exists ratings_delete_own on public.ratings;
create policy ratings_delete_own
  on public.ratings for delete to authenticated
  using (user_id = (select auth.uid())::text);

create or replace function public.findback_rate_client(p_post_id text, p_score integer)
returns table (
  post_id text,
  score integer,
  rating_avg numeric,
  rating_count bigint
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
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'Rating must be between 1 and 5' using errcode = '22023';
  end if;
  if not exists (select 1 from public.item_posts p where p.id = p_post_id) then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;

  -- RLS restricts this delete to the caller's own rating.
  delete from public.ratings r where r.post_id = p_post_id;

  v_id := md5('rating|' || p_post_id || '|' || v_uid);
  insert into public.ratings (id, post_id, user_id, score, created_at, updated_at)
  values (v_id, p_post_id, v_uid, p_score, v_now, v_now);

  return query
    select
      p_post_id,
      p_score,
      (select round(avg(ra.score), 2) from public.ratings ra where ra.post_id = p_post_id),
      (select count(*) from public.ratings ra where ra.post_id = p_post_id);
end;
$$;

revoke all on function public.findback_rate_client(text, integer) from public, anon;
grant execute on function public.findback_rate_client(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Caller's own social state (reload hydration)
--
-- Located by the deterministic id the write RPCs use, so this never reads or
-- filters on `user_id` and cannot surface another user's reaction/rating.
-- ---------------------------------------------------------------------------
create or replace function public.findback_post_social_state_client(p_post_id text)
returns table (my_reaction text, my_rating integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    (select r.type from public.reactions r
      where r.id = md5('reaction|' || p_post_id || '|' || auth.uid()::text)),
    (select ra.score from public.ratings ra
      where ra.id = md5('rating|' || p_post_id || '|' || auth.uid()::text));
$$;

revoke all on function public.findback_post_social_state_client(text) from public, anon;
grant execute on function public.findback_post_social_state_client(text) to authenticated;

comment on function public.findback_react_client(text, text)
  is 'FindBack react (authenticated): one LIKE/DISLIKE per user, null removes, returns counts + caller reaction.';
comment on function public.findback_rate_client(text, integer)
  is 'FindBack rate (authenticated): 1-5 one per user, returns live average/count.';
comment on function public.findback_post_social_state_client(text)
  is 'FindBack caller reaction/rating for a post (reload hydration), located by deterministic id.';
