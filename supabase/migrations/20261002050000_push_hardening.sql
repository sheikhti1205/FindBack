-- FindBack — push hardening: token ownership, atomic reply, retry bookkeeping,
-- and revocation of direct table grants on server-only tables.
--
-- Fixes three correctness/privacy defects found in review:
--   1. A device token could belong to several users at once. Ownership is now
--      exclusive on `token`; registration transfers the token to the caller.
--   2. Reply-token consumption + comment insert was a read/check/update/insert
--      across separate round-trips. It is now one locked transaction.
--   3. push-dispatch retired notifications after a temporary FCM failure.
--      `push_attempts`/`push_last_error` let a failed send be retried a bounded
--      number of times before it is retired.
--
-- Also revokes the default `anon`/`authenticated` privileges on tables whose
-- only access path is a scoped RPC or the service role, shrinking the exposed
-- GraphQL surface (Supabase security advisor).

-- ---------------------------------------------------------------------------
-- 1. One current owner per device token.
-- ---------------------------------------------------------------------------
-- Collapse any existing (user_id, token) duplicates to the most recently
-- updated row per token before the global unique constraint is added.
delete from public.device_tokens d
using public.device_tokens k
where d.token = k.token
  and (d.updated_at, d.id) < (k.updated_at, k.id);

alter table public.device_tokens
  drop constraint if exists device_tokens_user_id_token_key;
drop index if exists public.idx_device_tokens_token;
alter table public.device_tokens
  add constraint device_tokens_token_key unique (token);

-- Registration claims the token for the signed-in user even when another user
-- previously held it (same phone, account switch). Scoped to auth.uid().
create or replace function public.findback_register_device_token_client(
  p_token text,
  p_platform text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_token is null or length(trim(p_token)) < 8 or length(p_token) > 4096 then
    raise exception 'Invalid device token' using errcode = '22023';
  end if;
  if p_platform not in ('android', 'ios', 'web') then
    raise exception 'Invalid platform' using errcode = '22023';
  end if;
  insert into public.device_tokens (id, user_id, token, platform, created_at, updated_at)
  values (gen_random_uuid()::text, v_uid, p_token, p_platform, v_now, v_now)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.findback_register_device_token_client(text, text) from public, anon;
grant execute on function public.findback_register_device_token_client(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Atomic reply-token consumption + reply insert.
-- ---------------------------------------------------------------------------
-- `FOR UPDATE` makes concurrent replies for one token serialize; the second
-- caller sees `used_at` and is rejected. The comment insert and the token
-- stamp happen in the same transaction, so a failed insert never burns the
-- token. Service-role only: the device has no Supabase session.
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
  v_depth integer := 0;
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

  select c.post_id, c.depth into v_parent_post, v_parent_depth
  from public.comments c
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

  insert into public.comments (id, post_id, user_id, parent_id, depth, body, created_at, updated_at)
  values (v_id, v_token.post_id, v_token.user_id, v_token.parent_comment_id, v_depth, btrim(p_body), v_now, v_now);

  update public.push_reply_tokens set used_at = v_now where id = v_token.id;

  return query select true, null::text, v_id;
end;
$$;

revoke all on function public.findback_consume_reply_token_and_add_comment(text, text)
  from public, anon, authenticated;
grant execute on function public.findback_consume_reply_token_and_add_comment(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Bounded retry bookkeeping for push-dispatch.
-- ---------------------------------------------------------------------------
alter table public.notifications add column if not exists push_attempts integer not null default 0;
alter table public.notifications add column if not exists push_last_error text;

-- Increments the attempt counter for the given still-pending notifications and
-- retires any that reached the attempt ceiling. Returns how many were retired.
create or replace function public.findback_record_push_failure(
  p_ids text[],
  p_error text,
  p_max_attempts integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_given_up integer := 0;
begin
  update public.notifications
     set push_attempts = push_attempts + 1,
         push_last_error = left(coalesce(p_error, 'push failed'), 200)
   where id = any(p_ids) and pushed_at is null;

  with retired as (
    update public.notifications
       set pushed_at = v_now
     where id = any(p_ids)
       and pushed_at is null
       and push_attempts >= greatest(p_max_attempts, 1)
     returning 1
  )
  select count(*) into v_given_up from retired;

  return v_given_up;
end;
$$;

revoke all on function public.findback_record_push_failure(text[], text, integer)
  from public, anon, authenticated;
grant execute on function public.findback_record_push_failure(text[], text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Revoke direct table grants on server/RPC-only tables.
-- ---------------------------------------------------------------------------
-- These tables are reached only through SECURITY DEFINER RPCs or the service
-- role. Dropping the default grants removes them from the auto-generated
-- GraphQL surface; RPC access is unaffected.
revoke select, insert, update, delete on public.device_tokens from anon, authenticated;
revoke select, insert, update, delete on public.notification_preferences from anon, authenticated;
revoke select, insert, update, delete on public.push_reply_tokens from anon, authenticated;
revoke select on public.notifications from anon, authenticated;

comment on column public.device_tokens.token
  is 'One current owner per token; registering under a new user transfers ownership.';
