-- LIVE-PENDING verification for 20261014010000_account_deletion_storage_fence.sql.
--
-- Run ONLY after the migration applies. Section 1 is read-only catalog probes
-- (database owner session, e.g. Supabase dashboard SQL editor). Section 2 is
-- the behavioral proof of the write fence: it runs inside a transaction that
-- writes a scratch fence row, exercises the real trigger on storage.objects,
-- and ROLLBACKs — but still prefer a disposable backend, never production.
-- Expected: every probe in section 1 returns a row (no EXCEPTION), and the
-- host-side equivalents already run hermetically in
-- supabase/tests/run-account-deletion-fence.mjs (17 real-PostgreSQL
-- assertions: trigger enforcement, privileged-writer bypass, versioning
-- delete-marker/archive exemption, probe-savepoint rollback, in-flight commit
-- ordering, waiter re-check after lock release).

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes.
-- ---------------------------------------------------------------------------

-- P1. Fence table exists, denies clients, grants service_role only.
select 'P1 fence table locked down' as probe
where exists (
  select 1 from information_schema.tables
  where table_schema = 'public' and table_name = 'account_deletion_fences'
)
and not has_table_privilege('authenticated', 'public.account_deletion_fences', 'SELECT')
and not has_table_privilege('anon', 'public.account_deletion_fences', 'SELECT')
and has_table_privilege('service_role', 'public.account_deletion_fences', 'SELECT')
and has_table_privilege('service_role', 'public.account_deletion_fences', 'INSERT');
-- EXPECT: 1 row.

-- P2. Fence has no cascading FK to public.users (it must survive the cascade).
select 'P2 fence outlives the cascade' as probe
where not exists (
  select 1 from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relname = 'account_deletion_fences'
    and c.contype = 'f'
);
-- EXPECT: 1 row.

-- P3. begin_deletion: service-role-only, takes the advisory lock, idempotent.
select 'P3 begin_deletion is service-role-only + locked' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_begin_account_deletion'
    and position('pg_advisory_xact_lock' in pg_get_functiondef(p.oid)) > 0
    and position('on conflict (user_id) do nothing' in lower(pg_get_functiondef(p.oid))) > 0
)
and has_function_privilege('service_role',
      (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'findback_begin_account_deletion'), 'EXECUTE')
and not has_function_privilege('authenticated',
      (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'findback_begin_account_deletion'), 'EXECUTE')
and not has_function_privilege('anon',
      (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'findback_begin_account_deletion'), 'EXECUTE');
-- EXPECT: 1 row.

-- P4. Final-write trigger present on storage.objects (not RLS-gated).
select 'P4 storage write trigger present' as probe
where exists (
  select 1 from pg_trigger tg
  join pg_class t on t.oid = tg.tgrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'storage' and t.relname = 'objects'
    and tg.tgname = 'findback_guard_storage_account_write'
    and not tg.tgisinternal
);
-- EXPECT: 1 row.

-- P5. Owner mapping matches delete-account namespaces (bare keys are refused).
select 'P5 owner mapping' as probe
where public.findback_storage_account('findback-images', 'UID/probe.jpg') = 'UID'
  and public.findback_storage_account('findback-images', 'avatars/UID/probe.jpg') = 'UID'
  and public.findback_storage_account('findback-comment-media', 'UID/probe.jpg') = 'UID'
  and public.findback_storage_account('findback-images', 'root-placeholder.jpg') is null
  and public.findback_storage_account('findback-images', 'avatars') is null
  and public.findback_storage_account('some-other-bucket', 'UID/probe.jpg') is null;
-- EXPECT: 1 row.

-- P6. Trigger design is versioning-safe: it reads the removal markers
--     defensively (jsonb) so a storage schema change cannot break it, AND both
--     gated buckets must be versioning-DISABLED — a versioned bucket would make
--     the sweep soft-delete (markers) and overstate `storageRemoved`, so this
--     is a hard requirement, not a default to assume.
select 'P6 versioning-safe trigger + buckets DISABLED' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_guard_storage_account_write'
    and position('is_delete_marker' in pg_get_functiondef(p.oid)) > 0
    and position('archived_at' in pg_get_functiondef(p.oid)) > 0
)
and not exists (
  select 1 from storage.buckets
  where id in ('findback-images', 'findback-comment-media')
    and coalesce(versioning_status, 'DISABLED') <> 'DISABLED'
);
-- EXPECT: 1 row. If this fails, either disable bucket versioning or extend the
-- deletion contract to wait for physical version purge.

-- P7. No client grants on any new object.
select 'P7 no client grants' as probe
where not has_function_privilege('authenticated',
      (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'findback_storage_account'), 'EXECUTE')
  and not has_function_privilege('authenticated',
      (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'findback_guard_storage_account_write'), 'EXECUTE')
  and not has_function_privilege('anon',
      (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'findback_storage_account'), 'EXECUTE');
-- EXPECT: 1 row.

-- ---------------------------------------------------------------------------
-- 2. Behavioral proof (disposable backend preferred; transaction-local, ROLLBACK).
--    Uses a fictitious uid so no real account is touched.
-- ---------------------------------------------------------------------------
-- begin;
--
-- -- B1. A normal user-bytes write passes while the account exists and is unfenced.
-- insert into storage.objects (bucket_id, name)
-- values ('findback-images', '00000000-0000-4000-8000-000000000000/probe.jpg');
-- -- EXPECT: INSERT 0 1 (no trigger exception).
--
-- -- B2. Fencing the account refuses the NEXT write at final commit time,
-- --     including a privileged (non-authenticated) writer.
-- select public.findback_begin_account_deletion('00000000-0000-4000-8000-000000000000');
-- insert into storage.objects (bucket_id, name)
-- values ('findback-images', '00000000-0000-4000-8000-000000000000/blocked.jpg');
-- -- EXPECT: ERROR: account deletion prevents storage writes (SQLSTATE 42501).
--
-- -- B3. A fenced insert in another bucket, and an out-of-namespace key, are
-- --     unaffected by the fence.
-- insert into storage.objects (bucket_id, name) values ('unrelated-bucket', 'anything.jpg');
-- -- EXPECT: INSERT 0 1.
--
-- rollback;
