-- DISPOSABLE LOCAL PostgreSQL ONLY. Platform stubs for the migration chain.
-- This is not Supabase auth, storage, realtime or hosted/JWT acceptance.
-- Derived from the locally measured PG17 chain harness, now CI-executable.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role supabase_admin nologin noinherit bypassrls;
create role supabase_auth_admin nologin noinherit;
create role supabase_storage_admin nologin noinherit;
create role authenticator nologin noinherit;
-- Hosted catalog readback 2026-10-29: Supabase grants EXECUTE by default for
-- public functions. Mirror it so explicit private-delegate revokes are actually
-- tested against platform grants, not an artificially restrictive local role.
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public
  grant execute on functions to postgres, anon, authenticated, service_role;
create schema auth;
create schema storage;
create schema graphql;
create schema extensions;
create extension pgcrypto with schema extensions;
create extension pg_trgm with schema extensions;
create extension citext with schema extensions;
create extension "uuid-ossp" with schema extensions;
create table auth.users(
  id uuid primary key default extensions.gen_random_uuid(),
  email text unique,
  encrypted_password text,
  phone text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz,
  banned_until timestamptz,
  is_anonymous boolean default false
);
create table auth.identities(
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  provider text,
  provider_id text,
  identity_data jsonb,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
create function auth.email() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;
grant usage on schema auth to anon, authenticated, service_role;
create table storage.buckets(
  id text primary key,
  name text,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table storage.objects(
  id bigint generated always as identity primary key,
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  version text,
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  is_delete_marker boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now()
);
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select string_to_array(name, '/') $$;
create function storage.filename(name text) returns text language sql immutable as
  $$ select regexp_replace(name, '^.*/', '') $$;
alter table storage.objects enable row level security;
create publication supabase_realtime;
create function public.rls_auto_enable() returns event_trigger
  language plpgsql as $$ begin end; $$;
create schema realtime;
create table realtime.messages(
  id bigint generated always as identity primary key,
  topic text,
  extension text,
  payload jsonb,
  event text,
  private boolean,
  inserted_at timestamptz default now(),
  updated_at timestamptz default now()
);
create function realtime.send(
  payload jsonb, event text, topic text, private boolean default false
) returns void language plpgsql as $$ begin return; end; $$;
-- Hosted already grants authenticated USAGE on this schema (and SELECT on the
-- table); the disposable stub has to mirror that or a policy read is not
-- provable locally. Deliberately NOT in the migration: hosted's realtime schema
-- is owned by supabase_realtime_admin, the delegation covers policy statements
-- and object grants but not schema grants, and a 42501 there would roll back the
-- whole migration transaction for a privilege the platform already holds.
grant usage on schema realtime to authenticated;
