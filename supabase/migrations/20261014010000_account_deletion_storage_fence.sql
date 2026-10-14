-- 20261014010000_account_deletion_storage_fence.sql
--
-- ADDITIVE ONLY. Account-deletion storage write fence
-- (LIVE-PENDING; verify with supabase/tests/verify_20261014010000_deletion_fence.sql).
--
-- What this closes: `delete-account` sweeps Storage, then cascades the whole
-- profile tree, then deletes the auth user — all scoped to the JWT uid. But an
-- OLD in-flight request holding a still-valid JWT could keep uploading after the
-- sweep, recreating bytes for an account that no longer exists (orphans). RLS
-- policies alone cannot close it: Supabase Storage commits object metadata
-- through a privileged writer that bypasses `authenticated` policies, and the
-- permission probe that evaluates those policies runs in a rolled-back
-- savepoint. This migration therefore fences at the real final-write boundary:
-- a BEFORE INSERT/UPDATE row trigger on `storage.objects`, which fires for
-- privileged writers too (triggers are not RLS-gated).
--
-- Why a trigger and NOT a policy: a RESTRICTIVE policy on `storage.objects`
-- would also be evaluated by the Storage delete path when bucket versioning
-- writes delete markers (an INSERT/UPDATE, not a DELETE), so a policy-based
-- fence can wedge deletion itself. A trigger can tell a marker from a real
-- write and stay out of the way of removals; a policy cannot.
--
-- Mechanics:
--   * `account_deletion_fences` holds only the opaque account id; RLS is on,
--     clients have no grants at all, and it carries no cascading FK, so it
--     survives the `public.users` / auth cascade that ends a deletion. A uuid
--     is never reused, so a stale fence is inert for every future account.
--   * `findback_begin_account_deletion(uid)` is service-role-only: it takes a
--     per-account advisory transaction lock, then idempotently records the
--     fence. The Edge Function calls it BEFORE listing/removing objects, so an
--     upload that already committed is still swept, and one that has not yet
--     committed is refused by the guard below.
--   * `findback_guard_storage_account_write()` re-checks the owning account
--     through the SAME advisory lock, so a write racing the fence serializes:
--     whichever obtains the lock first wins, and the loser sees the other's
--     outcome. A pure removal — a versioning delete marker or an archive — is
--     allowed through, because it removes bytes rather than creating them.
--     (Version-PROMOTION and admin owner-transfer writes on a fenced account
--     are therefore also refused; neither is on the deletion or upload path.)
--     Both gated buckets are expected versioning-DISABLED; the verify script
--     asserts it, because a versioned bucket would soft-delete rather than
--     physically purge.
--
-- Owner mapping (must stay in step with delete-account OWNED_STORAGE_NAMESPACES):
--   findback-images/<uid>/…, findback-images/avatars/<uid>/…,
--   findback-comment-media/<uid>/… . Any other first segment in those two
--   buckets is refused (fail-closed) rather than silently written.
-- NEVER edit an applied migration; this file only ADDS a table, functions and
-- a trigger.

-- ---------------------------------------------------------------------------
-- 1. Fence table (survives the deletion cascade; clients fully denied).
-- ---------------------------------------------------------------------------
create table public.account_deletion_fences (
  user_id text primary key,
  started_at timestamptz not null default now()
);
comment on table public.account_deletion_fences
  is 'Transient write fence: an account id listed here accepts no new Storage writes for its namespaces. Row is service-role-only and never cascaded, so it outlives profile/auth deletion; uuids are never reused, so stale rows are inert.';
alter table public.account_deletion_fences enable row level security;
revoke all on public.account_deletion_fences from public, anon, authenticated;
grant select, insert on public.account_deletion_fences to service_role;

-- ---------------------------------------------------------------------------
-- 2. Begin deletion: serialize against in-flight policy checks, then commit
--    the fence before the Edge Function starts sweeping.
-- ---------------------------------------------------------------------------
create function public.findback_begin_account_deletion(p_user_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_user_id = '' then raise exception 'account required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id, 714));
  insert into public.account_deletion_fences(user_id) values (p_user_id)
    on conflict (user_id) do nothing;
end;
$$;
revoke all on function public.findback_begin_account_deletion(text) from public, anon, authenticated;
grant execute on function public.findback_begin_account_deletion(text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Owner mapping for a user-bytes object key (mirrors the delete-account
--    namespace registry). Null = outside the fenced namespaces.
-- ---------------------------------------------------------------------------
create function public.findback_storage_account(p_bucket text, p_name text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_bucket = 'findback-images' and pg_catalog.split_part(p_name, '/', 1) = 'avatars'
      then nullif(pg_catalog.split_part(p_name, '/', 2), '')
    when p_bucket in ('findback-images', 'findback-comment-media') and p_name like '%/%'
      then nullif(pg_catalog.split_part(p_name, '/', 1), '')
    else null end
$$;
comment on function public.findback_storage_account(text, text)
  is 'Owning account id for a user-bytes object key, or null when the key is outside the fenced namespaces. Mirrors delete-account OWNED_STORAGE_NAMESPACES.';
revoke all on function public.findback_storage_account(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Final-write trigger: the boundary privileged writers cannot bypass.
-- ---------------------------------------------------------------------------
create function public.findback_guard_storage_account_write()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare
  new_row jsonb := to_jsonb(new);
  old_account text;
  new_account text := public.findback_storage_account(new.bucket_id, new.name);
  account_id text;
begin
  -- A delete marker or an archived row removes bytes instead of creating
  -- them, so it must pass even while the account is fenced (otherwise the
  -- deletion sweep's own versioning writes would be refused and deletion
  -- could never finish). Read defensively via jsonb so the trigger still
  -- works on storage schemas without versioning columns.
  if new_row ->> 'is_delete_marker' = 'true' then return new; end if;
  if new_row ->> 'archived_at' is not null then return new; end if;
  if tg_op = 'UPDATE' then
    old_account := public.findback_storage_account(old.bucket_id, old.name);
  end if;
  -- Account order is fixed within a row so concurrent writers cannot
  -- interleave in opposite orders on the same two accounts.
  for account_id in
    select distinct id from unnest(array[old_account, new_account]) id
    where id is not null order by id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(account_id, 714));
    if exists (select 1 from public.account_deletion_fences where user_id = account_id) then
      raise exception 'account deletion prevents storage writes' using errcode = '42501';
    end if;
  end loop;
  if new.bucket_id in ('findback-images', 'findback-comment-media') and new_account is null then
    raise exception 'account required for storage write' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.findback_guard_storage_account_write() from public, anon, authenticated;

create trigger findback_guard_storage_account_write
  before insert or update on storage.objects
  for each row execute function public.findback_guard_storage_account_write();
