-- FindBack — Supabase Realtime cutover (Block 10G).
--
-- Mobile subscribes to Supabase Realtime Broadcast instead of the Node Socket.IO
-- gateway. Postgres Changes was considered first, but it streams the whole WAL
-- row to any subscriber whose RLS SELECT policy lets the row through — for
-- `reactions`/`ratings` that would ship `user_id` to every client, breaking the
-- Block 10F "no reaction/rating user lists" boundary. Broadcast triggers let us
-- send exactly the sanitized payload the UI needs (public comment projections and
-- aggregate counts only), so this is the required mechanism, not over-engineering.
--
-- Topics are private (`realtime.send(..., true)`); `authenticated` may receive,
-- anon may not. No tables are added to the `supabase_realtime` publication and no
-- REPLICA IDENTITY changes are needed because this does not use Postgres Changes.

-- ---------------------------------------------------------------------------
-- Private-channel receive authorization
-- ---------------------------------------------------------------------------
grant select on realtime.messages to authenticated;

drop policy if exists findback_realtime_receive_authenticated on realtime.messages;
create policy findback_realtime_receive_authenticated
  on realtime.messages for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- item_posts -> feed refetch + post-detail refetch
-- ---------------------------------------------------------------------------
create or replace function public.findback_broadcast_post_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text;
  v_op text := tg_op;
begin
  v_id := case when tg_op = 'DELETE' then old.id else new.id end;
  perform realtime.send(
    jsonb_build_object('postId', v_id, 'op', v_op),
    'post:changed', 'feed', true
  );
  perform realtime.send(
    jsonb_build_object('postId', v_id, 'op', v_op),
    case when v_op = 'DELETE' then 'post:deleted' else 'post:updated' end,
    'post:' || v_id, true
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- comments -> sanitized public comment payload
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

-- ---------------------------------------------------------------------------
-- reactions -> aggregate counts only
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
begin
  v_post := case when tg_op = 'DELETE' then old.post_id else new.post_id end;

  select
    count(*) filter (where r.type = 'LIKE'),
    count(*) filter (where r.type = 'DISLIKE')
  into v_like, v_dislike
  from public.reactions r
  where r.post_id = v_post;

  perform realtime.send(
    jsonb_build_object('postId', v_post, 'likeCount', v_like, 'dislikeCount', v_dislike),
    'reaction:changed', 'post:' || v_post, true
  );
  perform realtime.send(
    jsonb_build_object('postId', v_post),
    'post:changed', 'feed', true
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- ratings -> aggregate average/count only
-- ---------------------------------------------------------------------------
create or replace function public.findback_broadcast_rating_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post text;
  v_avg numeric;
  v_count bigint;
begin
  v_post := case when tg_op = 'DELETE' then old.post_id else new.post_id end;

  select round(avg(r.score), 2), count(*)
  into v_avg, v_count
  from public.ratings r
  where r.post_id = v_post;

  perform realtime.send(
    jsonb_build_object('postId', v_post, 'ratingAvg', v_avg, 'ratingCount', v_count),
    'rating:changed', 'post:' || v_post, true
  );
  perform realtime.send(
    jsonb_build_object('postId', v_post),
    'post:changed', 'feed', true
  );
  return null;
end;
$$;

revoke all on function public.findback_broadcast_post_change() from public, anon, authenticated;
revoke all on function public.findback_broadcast_comment_change() from public, anon, authenticated;
revoke all on function public.findback_broadcast_reaction_change() from public, anon, authenticated;
revoke all on function public.findback_broadcast_rating_change() from public, anon, authenticated;

drop trigger if exists trg_findback_broadcast_post on public.item_posts;
create trigger trg_findback_broadcast_post
  after insert or update or delete on public.item_posts
  for each row execute function public.findback_broadcast_post_change();

drop trigger if exists trg_findback_broadcast_comment on public.comments;
create trigger trg_findback_broadcast_comment
  after insert or delete on public.comments
  for each row execute function public.findback_broadcast_comment_change();

drop trigger if exists trg_findback_broadcast_reaction on public.reactions;
create trigger trg_findback_broadcast_reaction
  after insert or update or delete on public.reactions
  for each row execute function public.findback_broadcast_reaction_change();

drop trigger if exists trg_findback_broadcast_rating on public.ratings;
create trigger trg_findback_broadcast_rating
  after insert or update or delete on public.ratings
  for each row execute function public.findback_broadcast_rating_change();
