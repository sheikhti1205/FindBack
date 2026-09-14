-- FindBack — direct Supabase Auth profile provisioning + users RLS bootstrap.
--
-- Mobile now authenticates directly against Supabase Auth, so a public.users
-- profile row must be created from auth.users. IDs stay TEXT (they store the
-- Supabase Auth UUID string). The Node API keeps using the secret key, which
-- bypasses RLS, so it is unaffected by everything here.

-- ---------------------------------------------------------------------------
-- Helper: the caller's app user id (auth.uid() as canonical text).
-- ---------------------------------------------------------------------------
create or replace function public.findback_uid()
returns text
language sql
stable
as $$
  select auth.uid()::text
$$;

revoke all on function public.findback_uid() from public, anon;
grant execute on function public.findback_uid() to authenticated;

-- ---------------------------------------------------------------------------
-- Profile provisioning: create public.users from a new auth user.
-- The row is built ONLY from server-controlled fields plus validated metadata.
-- email_verified/phone_verified are never taken from user metadata.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_username text;
  v_phone    text;
  v_now      text;
begin
  v_username := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')), '');
  v_phone    := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '');

  if v_username is null or v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid username for auth user %', new.id using errcode = '22023';
  end if;
  if v_phone is null or v_phone !~ '^(\+?88)?01[3-9][0-9]{8}$' then
    raise exception 'invalid phone for auth user %', new.id using errcode = '22023';
  end if;

  v_now := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.users (
    id, username, email, phone, password_hash,
    email_verified, phone_verified, avatar_url, created_at, updated_at
  ) values (
    new.id::text,
    v_username,
    coalesce(new.email, ''),
    v_phone,
    null,
    case when new.email_confirmed_at is not null then 1 else 0 end,
    0,
    null,
    v_now,
    v_now
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Keep email_verified in sync when Supabase confirms the email.
-- ---------------------------------------------------------------------------
create or replace function public.handle_auth_user_updated()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_verified integer := case when new.email_confirmed_at is not null then 1 else 0 end;
begin
  update public.users
     set email_verified = v_verified,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where id = new.id::text
     and email_verified is distinct from v_verified;
  return new;
end;
$$;

revoke all on function public.handle_auth_user_updated() from public, anon, authenticated;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.handle_auth_user_updated();

-- ---------------------------------------------------------------------------
-- Login identifier resolver.
-- Makes username-or-email login work with Supabase Auth (which signs in by
-- email only). SECURITY DEFINER is required because RLS hides other rows.
-- NOTE: this exposes whether a username maps to an account; accept that
-- trade-off for the course build and revisit later.
-- ---------------------------------------------------------------------------
create or replace function public.findback_login_email(p_identifier text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.email
    from public.users u
   where lower(u.username) = lower(btrim(p_identifier))
      or lower(u.email)    = lower(btrim(p_identifier))
   limit 1
$$;

revoke all on function public.findback_login_email(text) from public;
grant execute on function public.findback_login_email(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- users RLS bootstrap: self-only, safe columns, no client writes.
-- Email/phone are readable only by the owning user (policy is self-only), so
-- they are never exposed to other users. No INSERT (profile is trigger-owned),
-- no DELETE, and no UPDATE yet (profile editing is a later block).
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

revoke all on public.users from anon, authenticated;

grant select (
  id, username, email, phone,
  email_verified, phone_verified, avatar_url,
  created_at, updated_at
) on public.users to authenticated;

drop policy if exists users_select_self on public.users;
create policy users_select_self
  on public.users
  for select
  to authenticated
  using (id = public.findback_uid());
