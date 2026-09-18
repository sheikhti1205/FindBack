-- FindBack — Realtime feed change kinds.
--
-- The `feed` topic previously sent `{postId, op}` for item_posts and bare
-- `{postId}` for comments/reactions/ratings. The client inferred "new post"
-- from an absent `op`, so a like or a comment showed the user "N new posts".
--
-- Every feed broadcast now carries an explicit `change` kind. Only a real
-- INSERT means a new post; everything else is a generic "updates" signal.
-- `op` is kept on item_posts for backward compatibility.

-- ---------------------------------------------------------------------------
-- item_posts -> change = INSERT | UPDATE | DELETE
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
    jsonb_build_object('postId', v_id, 'op', v_op, 'change', v_op),
    'post:changed', 'feed', true
  );
  perform realtime.send(
    jsonb_build_object('postId', v_id, 'op', v_op, 'change', v_op),
    case when v_op = 'DELETE' then 'post:deleted' else 'post:updated' end,
    'post:' || v_id, true
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- comments -> change = COMMENT_CHANGE (never a new post)
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
    jsonb_build_object('postId', v_post, 'change', 'COMMENT_CHANGE'),
    'post:changed', 'feed', true
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- reactions -> change = REACTION_CHANGE (never a new post)
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
    jsonb_build_object('postId', v_post, 'change', 'REACTION_CHANGE'),
    'post:changed', 'feed', true
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- ratings -> change = RATING_CHANGE (never a new post)
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
    jsonb_build_object('postId', v_post, 'change', 'RATING_CHANGE'),
    'post:changed', 'feed', true
  );
  return null;
end;
$$;

revoke all on function public.findback_broadcast_post_change() from public, anon, authenticated;
revoke all on function public.findback_broadcast_comment_change() from public, anon, authenticated;
revoke all on function public.findback_broadcast_reaction_change() from public, anon, authenticated;
revoke all on function public.findback_broadcast_rating_change() from public, anon, authenticated;
