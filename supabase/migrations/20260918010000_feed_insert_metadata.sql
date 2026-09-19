-- FindBack — feed INSERT metadata for honest new-post pills.
--
-- The `feed` topic told clients *that* a post was inserted but not whether it
-- belongs to the filter the reader is looking at (type/search). The client
-- then counted every INSERT as a new post, so a FOUND post arriving while the
-- reader filtered to LOST showed "1 new post" that would never appear.
--
-- Post INSERT/UPDATE/DELETE broadcasts now carry the post's `postType`,
-- `category`, and `title` so the client can prove filter membership. When it
-- cannot prove membership (e.g. an active search query), it shows a generic
-- "Updates" affordance instead of a count.

create or replace function public.findback_broadcast_post_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text;
  v_op text := tg_op;
  v_type text;
  v_category text;
  v_title text;
begin
  if tg_op = 'DELETE' then
    v_id := old.id;
    v_type := old.type;
    v_category := old.category;
    v_title := old.title;
  else
    v_id := new.id;
    v_type := new.type;
    v_category := new.category;
    v_title := new.title;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'postId', v_id,
      'op', v_op,
      'change', v_op,
      'postType', v_type,
      'category', v_category,
      'title', v_title
    ),
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

revoke all on function public.findback_broadcast_post_change() from public, anon, authenticated;
