-- LIVE-PENDING verification for 20261013020000_comment_media_cleanup_lease.sql.
--
-- Run ONLY after the migration applies. Section 1 is read-only catalog
-- probes (database owner session, e.g. Supabase dashboard SQL editor).
-- Section 2 is the lease/ack behavioral proof: run on a DISPOSABLE test
-- backend (it writes scratch queue rows inside a transaction rolled back
-- at the end — never run it against production).
-- Expected: every probe below returns a row (no EXCEPTION).

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes.
-- ---------------------------------------------------------------------------

-- P1. Lease columns exist with the contracted defaults.
select 'P1 lease columns present' as probe
where exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'comment_media_cleanup_queue'
    and column_name = 'leased_at' and data_type = 'timestamp with time zone'
) and exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'comment_media_cleanup_queue'
    and column_name = 'attempts' and data_type = 'integer'
);
-- EXPECT: 1 row.

-- P2. Claim marks leased (UPDATE leased_at/attempts), never deletes;
--     stale window is 15 minutes; concurrent claims skip locked rows.
select 'P2 claim is lease-not-delete' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_comment_media_cleanup'
    and position('leased_at = now()' in pg_get_functiondef(p.oid)) > 0
    and position('attempts = q.attempts + 1' in pg_get_functiondef(p.oid)) > 0
    and position('interval ''15 minutes''' in pg_get_functiondef(p.oid)) > 0
    and position('skip locked' in lower(pg_get_functiondef(p.oid))) > 0
);
-- EXPECT: 1 row.

-- P3. Claim body holds no DELETE (the old claim-then-delete hole is gone).
select 'P3 claim holds no delete' as probe
where not exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_comment_media_cleanup'
    and position('delete from' in lower(pg_get_functiondef(p.oid))) > 0
);
-- EXPECT: 1 row.

-- P4. Ack companion exists, deletes only listed keys, caps the batch.
select 'P4 ack deletes only listed keys' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'ack_comment_media_cleanup'
    and position('storage_key = any' in lower(pg_get_functiondef(p.oid))) > 0
    and position('max 1000 keys' in lower(pg_get_functiondef(p.oid))) > 0
);
-- EXPECT: 1 row.

-- P5. Both RPCs are service-role-only; enqueue helper fully revoked.
select 'P5 service-role-only grants' as probe
where has_function_privilege('service_role',
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'claim_comment_media_cleanup'), 'EXECUTE')
  and not has_function_privilege('authenticated',
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'claim_comment_media_cleanup'), 'EXECUTE')
  and not has_function_privilege('anon',
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'claim_comment_media_cleanup'), 'EXECUTE')
  and has_function_privilege('service_role',
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'ack_comment_media_cleanup'), 'EXECUTE')
  and not has_function_privilege('authenticated',
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'ack_comment_media_cleanup'), 'EXECUTE')
  and not has_function_privilege('anon',
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'ack_comment_media_cleanup'), 'EXECUTE');
-- EXPECT: 1 row.

-- P6. Queue table still denies clients (new columns inherit RLS).
select 'P6 queue denies clients' as probe
where not has_table_privilege('authenticated', 'public.comment_media_cleanup_queue', 'SELECT')
  and not has_table_privilege('anon', 'public.comment_media_cleanup_queue', 'SELECT');
-- EXPECT: 1 row.

-- P7. Enqueue trigger + table untouched by the redesign (same trigger,
--     same conflict-tolerant insert).
select 'P7 enqueue path untouched' as probe
where exists (select 1 from pg_trigger where tgname = 'comment_attachments_cleanup_enqueue')
  and exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'enqueue_comment_media_cleanup'
      and position('on conflict (storage_key) do nothing' in lower(pg_get_functiondef(p.oid))) > 0
  );
-- EXPECT: 1 row.

-- ---------------------------------------------------------------------------
-- 2. Disposable-backend behavioral proof (transaction-local scratch rows;
--    ROLLBACK at the end, nothing persists). Service-role session.
-- ---------------------------------------------------------------------------
-- begin;
--
-- -- B1. Claim marks-not-deletes: rows survive with leased_at + attempts 1.
-- insert into public.comment_media_cleanup_queue (storage_key)
-- values ('verify-lease/a.jpg'), ('verify-lease/b.jpg');
-- select storage_key from public.claim_comment_media_cleanup(10) order by 1;
-- -- EXPECT: 2 rows (verify-lease/a.jpg, verify-lease/b.jpg).
-- select storage_key, leased_at is not null as leased, attempts
-- from public.comment_media_cleanup_queue where storage_key like 'verify-lease/%' order by 1;
-- -- EXPECT: 2 rows, leased true, attempts 1 (nothing deleted by claim).
--
-- -- B2. Fresh leases are invisible; stale leases reclaimable.
-- select storage_key from public.claim_comment_media_cleanup(10);
-- -- EXPECT: 0 rows (just-leased rows are not reclaimable).
-- update public.comment_media_cleanup_queue set leased_at = now() - interval '16 minutes'
-- where storage_key = 'verify-lease/a.jpg';
-- select storage_key from public.claim_comment_media_cleanup(10);
-- -- EXPECT: 1 row (verify-lease/a.jpg), attempts now 2.
--
-- -- B3. Ack deletes only acked keys; failures stay queued.
-- select storage_key from public.ack_comment_media_cleanup(array['verify-lease/a.jpg']) ;
-- -- EXPECT: 1 row (verify-lease/a.jpg).
-- select storage_key from public.comment_media_cleanup_queue where storage_key like 'verify-lease/%' order by 1;
-- -- EXPECT: 1 row (verify-lease/b.jpg still queued — the "Storage failure"
-- -- case: unacked tasks are never lost).
-- select storage_key from public.ack_comment_media_cleanup('{}');
-- -- EXPECT: 0 rows (empty ack is a no-op).
--
-- rollback;
