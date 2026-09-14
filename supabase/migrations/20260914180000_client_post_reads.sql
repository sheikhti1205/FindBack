-- FindBack — authenticated post reads straight from Supabase (Block 10D).
--
-- Goal: the mobile app reads the feed, a single post and "My Posts" directly
-- from the hosted Data API with the publishable key, while the Node API stays
-- the only writer for now (writes arrive in later blocks).
--
-- Privacy boundary introduced here:
--   * `public.users` email/phone are private. The `authenticated` role keeps
--     SELECT on the safe public profile columns only, and may read those for
--     every user (usernames/avatars are public). Email/phone/updated_at are
--     revoked. The signed-in user's own email comes from the Auth session and
--     their phone from signup metadata (display only).
--   * Posts/comments never expose the author's email or phone. The existing
--     `findback_query_posts` RPC still returns them but stays service_role-only
--     (Node); a new client-safe RPC returns public author fields only.
--
-- SECURITY INVOKER throughout: the caller's own RLS/column privileges drive the
-- query, so nothing requires SECURITY DEFINER.
--
-- Writes are intentionally NOT granted here: anon gets no table access, and
-- authenticated gets SELECT only. Post/comment/reaction/rating mutations keep
-- going through the Node API until their own blocks add scoped write policies.

-- ---------------------------------------------------------------------------
-- users: public profile columns for authenticated; private fields revoked.
-- ---------------------------------------------------------------------------
revoke select (email, phone, updated_at) on public.users from authenticated;

grant select (
  id, username, email_verified, phone_verified, avatar_url, created_at
) on public.users to authenticated;

-- Replace the self-only bootstrap policy: authenticated may read the safe
-- public columns of any user (email/phone are no longer granted, so the wide
-- row policy cannot leak them). anon keeps its username-only policy from 10C.
drop policy if exists users_select_self on public.users;
drop policy if exists users_select_public_authenticated on public.users;
create policy users_select_public_authenticated
  on public.users
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Read-only grants for the tables the client RPC and direct reads touch.
-- Explicitly strip the default grants first so no write slips through.
-- ---------------------------------------------------------------------------
revoke all on public.item_posts from anon, authenticated;
revoke all on public.attachments from anon, authenticated;
revoke all on public.comments from anon, authenticated;
revoke all on public.reactions from anon, authenticated;
revoke all on public.ratings from anon, authenticated;
-- No client access at all for these two.
revoke all on public.verification_challenges from anon, authenticated;
revoke all on public.uploads from anon, authenticated;

grant select (
  id, user_id, type, title, description, category, status, event_date,
  latitude, longitude, location_label, youtube_url, created_at, updated_at
) on public.item_posts to authenticated;

grant select (
  id, post_id, file_url, mime_type, file_name, file_size, created_at
) on public.attachments to authenticated;

-- Aggregate support only: no comment bodies, no reaction/rating user identity.
grant select (id, post_id) on public.comments to authenticated;
grant select (id, post_id, type) on public.reactions to authenticated;
grant select (id, post_id, score) on public.ratings to authenticated;

drop policy if exists item_posts_select_authenticated on public.item_posts;
create policy item_posts_select_authenticated
  on public.item_posts for select to authenticated using (true);

drop policy if exists attachments_select_authenticated on public.attachments;
create policy attachments_select_authenticated
  on public.attachments for select to authenticated using (true);

drop policy if exists comments_select_authenticated on public.comments;
create policy comments_select_authenticated
  on public.comments for select to authenticated using (true);

drop policy if exists reactions_select_authenticated on public.reactions;
create policy reactions_select_authenticated
  on public.reactions for select to authenticated using (true);

drop policy if exists ratings_select_authenticated on public.ratings;
create policy ratings_select_authenticated
  on public.ratings for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Client-safe feed/listing RPC.
--
-- Same filters/pagination/aggregates as findback_query_posts but:
--   * author email/phone are not in the result at all
--   * `p_post_id` allows an exact single-post read
--   * page size is clamped to 20 in SQL, independent of the caller
--   * counts use explicit columns so the caller needs only the column grants
--     above (never table-level SELECT)
-- ---------------------------------------------------------------------------
create or replace function public.findback_query_posts_client(
  p_user_id text default null,
  p_type text default null,
  p_category text default null,
  p_status text default null,
  p_q text default null,
  p_date_from text default null,
  p_date_to text default null,
  p_cursor_created_at text default null,
  p_cursor_id text default null,
  p_order text default 'desc',
  p_limit integer default 10,
  p_post_id text default null
)
returns table (
  id text,
  user_id text,
  type text,
  title text,
  description text,
  category text,
  status text,
  event_date text,
  latitude double precision,
  longitude double precision,
  location_label text,
  youtube_url text,
  created_at text,
  updated_at text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text,
  like_count bigint,
  dislike_count bigint,
  rating_avg numeric,
  rating_count bigint,
  comment_count bigint,
  attachments jsonb,
  total_count bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    p.*,
    u.username as author_username,
    u.email_verified as author_email_verified,
    u.phone_verified as author_phone_verified,
    u.avatar_url as author_avatar_url,
    u.created_at as author_created_at,
    (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'LIKE') as like_count,
    (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'DISLIKE') as dislike_count,
    (select avg(ra.score) from ratings ra where ra.post_id = p.id) as rating_avg,
    (select count(ra.id) from ratings ra where ra.post_id = p.id) as rating_count,
    (select count(c.id) from comments c where c.post_id = p.id) as comment_count,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'post_id', a.post_id,
          'file_url', a.file_url,
          'mime_type', a.mime_type,
          'file_name', a.file_name,
          'file_size', a.file_size,
          'created_at', a.created_at
        ) order by a.created_at asc
      )
      from attachments a
      where a.post_id = p.id
    ), '[]'::jsonb) as attachments,
    count(p.id) over() as total_count
  from item_posts p
  join users u on u.id = p.user_id
  where
    (p_post_id is null or p.id = p_post_id)
    and (p_user_id is null or p.user_id = p_user_id)
    and (p_type is null or p.type = p_type)
    and (p_category is null or p.category = p_category)
    and (p_status is null or p.status = p_status)
    and (
      p_q is null
      or lower(p.title) like '%' || lower(p_q) || '%'
      or lower(p.description) like '%' || lower(p_q) || '%'
    )
    and (p_date_from is null or p.event_date >= p_date_from)
    and (p_date_to is null or p.event_date <= p_date_to)
    and (
      p_cursor_created_at is null
      or (
        p_order = 'asc'
        and (
          p.created_at > p_cursor_created_at
          or (p.created_at = p_cursor_created_at and p.id > coalesce(p_cursor_id, ''))
        )
      )
      or (
        p_order <> 'asc'
        and (
          p.created_at < p_cursor_created_at
          or (p.created_at = p_cursor_created_at and p.id < coalesce(p_cursor_id, ''))
        )
      )
    )
  order by
    (case when p_order = 'asc' then p.created_at end) asc,
    (case when p_order = 'asc' then p.id end) asc,
    (case when p_order <> 'asc' then p.created_at end) desc,
    (case when p_order <> 'asc' then p.id end) desc
  limit least(greatest(p_limit, 0), 20);
$$;

revoke all on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) from public;
revoke all on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) from anon;
grant execute on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) to authenticated;

comment on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) is 'FindBack client feed/listing (authenticated): post + public author + aggregates + attachments with keyset pagination, exact post lookup and total_count window. Never returns author email/phone. Page size clamped to 20.';
