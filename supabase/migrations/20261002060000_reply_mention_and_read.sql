-- FindBack — direct-reply fidelity: mention the actor and mark the source read.
--
-- The Android notification-shade reply should behave exactly like replying in
-- the app: the reply is attributed to the actor of the parent comment via an
-- `@username` mention (which also drives the existing mention-notification
-- path), and the notification that produced the reply action is marked read.
--
-- The notification id is carried on the token (minted by `push-dispatch`) so
-- the consume RPC can mark exactly that row read inside the same transaction.
-- Prefixing happens server-side AFTER the 1–1000 validation so the user's own
-- text bound is unchanged.

alter table public.push_reply_tokens
  add column if not exists notification_id text;

create or replace function public.findback_consume_reply_token_and_add_comment(
  p_token_hash text,
  p_body text
)
returns table (ok boolean, reason text, comment_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token public.push_reply_tokens%rowtype;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_parent_post text;
  v_parent_depth integer;
  v_actor text;
  v_depth integer := 0;
  v_body text;
  v_id text := gen_random_uuid()::text;
begin
  if p_token_hash is null or length(p_token_hash) < 32 or length(p_token_hash) > 128 then
    return query select false, 'missing', null::text;
    return;
  end if;
  if p_body is null or char_length(btrim(p_body)) < 1 or char_length(btrim(p_body)) > 1000 then
    return query select false, 'invalid_body', null::text;
    return;
  end if;

  select t.* into v_token
  from public.push_reply_tokens t
  where t.token_hash = p_token_hash
  for update;

  if not found then
    return query select false, 'missing', null::text;
    return;
  end if;
  if v_token.used_at is not null then
    return query select false, 'used', null::text;
    return;
  end if;
  if v_token.expires_at <= v_now then
    return query select false, 'expired', null::text;
    return;
  end if;

  select c.post_id, c.depth, u.username
    into v_parent_post, v_parent_depth, v_actor
  from public.comments c
  join public.users u on u.id = c.user_id
  where c.id = v_token.parent_comment_id;

  if not found or v_parent_post <> v_token.post_id then
    return query select false, 'parent_unavailable', null::text;
    return;
  end if;
  if v_parent_depth >= 5 then
    return query select false, 'depth_exceeded', null::text;
    return;
  end if;
  v_depth := v_parent_depth + 1;

  v_body := btrim(p_body);
  if v_actor is not null and length(btrim(v_actor)) > 0 then
    v_body := '@' || btrim(v_actor) || ' ' || v_body;
  end if;

  insert into public.comments (id, post_id, user_id, parent_id, depth, body, created_at, updated_at)
  values (v_id, v_token.post_id, v_token.user_id, v_token.parent_comment_id, v_depth, v_body, v_now, v_now);

  update public.push_reply_tokens set used_at = v_now where id = v_token.id;

  if v_token.notification_id is not null then
    update public.notifications
      set read = 1
      where id = v_token.notification_id and user_id = v_token.user_id;
  end if;

  return query select true, null::text, v_id;
end;
$$;

revoke all on function public.findback_consume_reply_token_and_add_comment(text, text)
  from public, anon, authenticated;
grant execute on function public.findback_consume_reply_token_and_add_comment(text, text) to service_role;
