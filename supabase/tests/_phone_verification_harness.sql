-- Minimal stand-ins for the objects the phone-verification migration and its
-- behavioral test depend on. Runs ONLY on a disposable Postgres (CI service
-- container) BEFORE the migration; never applied to any hosted database.
--
-- It does not duplicate the migration's trigger logic: the migration under
-- test still owns findback_normalize_bd_phone + handle_auth_user_updated and
-- the auth.users triggers. This harness only provides the ambient schema and
-- the signup-provisioning trigger that the real project supplies elsewhere.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated noinherit;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  phone_confirmed_at timestamptz,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  phone_change text
);

create table if not exists public.users (
  id text primary key,
  email_verified integer default 0,
  phone text,
  phone_verified integer default 0,
  updated_at text
);

-- Mirrors the production signup-provisioning trigger. PostgreSQL runs
-- same-event triggers in name order, so `on_auth_user_created` fires before
-- the migration's `on_auth_user_phone_synced` on INSERT.
create or replace function public.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (id) values (new.id::text) on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_auth_user_created() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_auth_user_created();
