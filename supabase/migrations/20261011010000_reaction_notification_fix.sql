-- FindBack — W1-A-FIX: kind-keyed REACTION dedupe (follow-up to 20261011000000).
--
-- ADDITIVE / NON-DESTRUCTIVE. This file only replaces
-- public.findback_insert_notification/7 in place (same signature, same
-- defaults, same grants); it never edits 20261011000000, drops nothing,
-- deletes no data, and changes no RLS or grant.
--
-- Decision (a): notify on kind-switch-after-read. The base migration's
-- trigger deletes only UNREAD (read = 0) superseded reaction rows while its
-- insert helper deduped on exact type = 'REACTION' regardless of kind or
-- read state — so LOVE(read) -> WOW was swallowed, unlike legacy
-- LIKE -> DISLIKE (different types, so the old dedupe never blocked the
-- switch). The helper below keys the REACTION dedupe on reaction_kind, so a
-- different kind after read notifies with the same parity legacy
-- LIKE -> DISLIKE had, while anti-spam is preserved: same-kind re-reacts
-- stay suppressed, and unread switches still collapse to one current row
-- via the trigger delete. Read rows otherwise keep their history semantics
-- for every other type.
--
-- Verified against the base migration by re-reading
-- 20261011000000_reaction_notification_feed.sql: signature
-- (text x6 + defaulted p_reaction_kind), self-notify guard, NULL-actor
-- STATUS rule, post/comment/type dedupe shape, and the revoke line are all
-- carried over unchanged; only the REACTION kind predicate is added.

create or replace function public.findback_insert_notification(
  p_user_id text,
  p_actor_id text,
  p_type text,
  p_post_id text,
  p_comment_id text,
  p_preview text,
  p_reaction_kind text default null
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
  -- post/comment/type. A NULL actor is allowed only for system STATUS rows.
  -- REACTION dedupes on (actor, post, REACTION, kind): the reaction trigger
  -- deletes the actor's superseded UNREAD reaction row before inserting, so
  -- unread switches keep one current row; a different kind after read
  -- notifies (parity with legacy LIKE -> DISLIKE, which are different types
  -- and therefore never blocked each other), while the same kind stays
  -- suppressed. Every other type dedupes exactly as before.
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
        and (
          p_type <> 'REACTION'
          or n.reaction_kind is not distinct from p_reaction_kind
        )
    ) then
      return;
    end if;
  end if;
  insert into public.notifications
    (id, user_id, actor_id, type, post_id, comment_id, preview, read, created_at, deleted_at, reaction_kind)
  values
    (gen_random_uuid()::text, p_user_id, p_actor_id, p_type,
     p_post_id, p_comment_id, left(nullif(p_preview, ''), 200), 0, v_now, null, p_reaction_kind);
end;
$$;

revoke all on function
  public.findback_insert_notification(text, text, text, text, text, text, text)
  from public, anon, authenticated;
