-- FindBack — batched caller reaction/rating hydration for the Home feed (UXN-2).
--
-- ADDITIVE ONLY: every existing social RPC (findback_react_client,
-- findback_rate_client, findback_post_social_state_client, comment RPCs) is
-- untouched, so beta.1 clients observe no change.
--
-- The Home feed must hydrate the caller's own reaction state for a page of
-- cards without calling findback_post_social_state_client once per card. This
-- single RPC carries up to 20 post ids and returns one row per input id:
--   (post_id, my_reaction, my_rating)
-- with nulls where the caller has no reaction/rating.
--
-- Privacy contract (mirrors findback_post_social_state_client):
-- - the actor is always auth.uid()::text, never accepted from the caller;
-- - rows are located by the existing deterministic ids
--   md5('reaction|<post_id>|<uid>') / md5('rating|<post_id>|<uid>');
-- - no user_id is accepted, exposed, or filterable — another user's state
--   cannot leak through this function;
-- - executable by `authenticated` only (revoked from public/anon).
--
-- Love/Unlove rides the EXISTING reaction model: Love = LIKE, Unlove = null
-- (delete), DISLIKE switches to LIKE. No LOVE kind is created anywhere.

create or replace function public.findback_feed_reaction_state_client(p_post_ids text[])
returns table (post_id text, my_reaction text, my_rating integer)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_n integer := coalesce(array_length(p_post_ids, 1), 0);
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if v_n > 20 then
    raise exception 'At most 20 post ids per call' using errcode = '22023';
  end if;

  return query
    select
      u.pid,
      (select r.type from public.reactions r
        where r.id = md5('reaction|' || u.pid || '|' || v_uid)),
      (select ra.score from public.ratings ra
        where ra.id = md5('rating|' || u.pid || '|' || v_uid))
    from unnest(p_post_ids) as u(pid);
end;
$$;

revoke all on function public.findback_feed_reaction_state_client(text[]) from public, anon;
grant execute on function public.findback_feed_reaction_state_client(text[]) to authenticated;

comment on function public.findback_feed_reaction_state_client(text[])
  is 'FindBack batched caller reaction/rating for feed ids (<=20 per call, deterministic ids, auth.uid only).';
