-- FindBack — users privacy convergence (RC Phase B).
--
-- Live drift: the hosted project exposes public.users to anon with a broad
-- SELECT (id, username, email, phone, password_hash, verification flags,
-- avatar, timestamps) and is missing the users hardening from 20260914120000
-- (revoke + self-only policy), 20260914170000 (anon username-only grant) and
-- 20260914180000 (authenticated safe-columns grant + public policy).
--
-- This migration converges live to the intended end state regardless of which
-- earlier users migrations were applied. Every statement is idempotent:
--   * anon gets NO table access at all (not even username — availability goes
--     through the boolean RPC below, which also stops bulk username harvest
--     via select=username&limit=N&offset=M).
--   * authenticated keeps SELECT on the safe public-profile columns only:
--     id, username, email_verified, phone_verified, avatar_url, created_at.
--     Never email, phone, password_hash, updated_at.
--   * No INSERT/UPDATE/DELETE for anon or authenticated (profile rows are
--     trigger-owned; email/phone for the signed-in user come from the Auth
--     session and signup metadata, never from this table).
--
-- Two SECURITY DEFINER RPCs are the only anon-reachable users surface.
-- DEFINER is required precisely because anon holds no table privileges; the
-- functions return the minimal shape (boolean / safe public profile) and run
-- with a locked search_path.

-- ---------------------------------------------------------------------------
-- 0. RLS must be on (no-op when already enabled).
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;

-- ---------------------------------------------------------------------------
-- 1. Strip every client privilege on the table, then re-grant only the safe
--    authenticated column set. password_hash is never granted to any client
--    role (it stays NULL on hosted rows; Supabase Auth owns passwords).
-- ---------------------------------------------------------------------------
revoke all on public.users from anon, authenticated;

grant select (
  id, username, email_verified, phone_verified, avatar_url, created_at
) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Drop every existing policy on public.users (including unknown live-only
--    broad anon policies), then recreate exactly the one intended policy:
--    authenticated may read the granted safe columns of any row. Column
--    grants above — not this policy — are what keep email/phone/password_hash
--    unreadable.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename = 'users'
  loop
    execute format('drop policy if exists %I on public.users', r.policyname);
  end loop;
end
$$;

create policy users_select_public_authenticated
  on public.users
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 3. Username availability oracle: boolean only, no row data.
-- ---------------------------------------------------------------------------
create or replace function public.is_username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (
    select 1
      from public.users u
     where lower(u.username) = lower(btrim(p_username))
  )
$$;

revoke all on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Safe public profile lookup by username. Public fields only.
-- ---------------------------------------------------------------------------
create or replace function public.public_profile_by_username(p_username text)
returns table (
  id text,
  username text,
  avatar_url text,
  created_at text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.username, u.avatar_url, u.created_at
    from public.users u
   where lower(u.username) = lower(btrim(p_username))
   limit 1
$$;

revoke all on function public.public_profile_by_username(text) from public;
grant execute on function public.public_profile_by_username(text) to anon, authenticated;
