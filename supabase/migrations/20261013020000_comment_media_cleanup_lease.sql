-- 20261013020000_comment_media_cleanup_lease.sql
--
-- ADDITIVE ONLY. Lease/ack redesign for the comment-media cleanup queue
-- (LIVE-PENDING; verify with supabase/tests/verify_20261013020000_cleanup_lease.sql).
--
-- What this closes: 20261012020000 created comment_media_cleanup_queue with a
-- claim-then-DELETE claim (`claim_comment_media_cleanup` deleted rows on
-- claim) and no consumer, so ordinary comment deletion orphaned Storage
-- bytes — and worse, a claim-then-delete-then-Storage-failure lost the
-- task permanently. This migration keeps the table and the enqueue
-- trigger byte-for-byte untouched and replaces only the claim semantics:
--
--   STALE-LEASE RESET RULE: a lease older than 15 minutes is reclaimable.
--   claim marks a bounded batch leased (leased_at = now(), attempts + 1)
--   over unleased-or-stale rows and RETURNS it without deleting; the new
--   ack companion deletes rows only after Storage removal succeeds.
--   A crashed, timed-out, or Storage-failed sweep therefore retries
--   instead of orphaning: failures stay queued (attempts++), never lost.
--
-- Consumer: supabase/functions/cleanup-comment-media (service-role /
-- internal cron secret only). Scheduled trigger wiring lives owner-side
-- (pg_cron / Supabase scheduled function); this migration only provides
-- the lease/ack primitives the sweeper calls.
-- NEVER edit any applied migration; this file only ADDS columns and
-- CREATE OR REPLACEs the claim function beside a new ack function.

-- ---------------------------------------------------------------------------
-- 1. Lease columns (additive; table, PK, trigger, RLS untouched).
-- ---------------------------------------------------------------------------
alter table public.comment_media_cleanup_queue
  add column if not exists leased_at timestamptz null,
  add column if not exists attempts integer not null default 0;

comment on column public.comment_media_cleanup_queue.leased_at
  is 'Lease stamp set by claim_comment_media_cleanup; null = never claimed. Leases older than 15 minutes are reclaimable (stale-lease reset rule).';
comment on column public.comment_media_cleanup_queue.attempts
  is 'Claim count; incremented on every lease so stuck keys are visible without losing the task.';

-- ---------------------------------------------------------------------------
-- 2. Lease claim: MARK a bounded batch leased, never delete.
-- ---------------------------------------------------------------------------
create or replace function public.claim_comment_media_cleanup(p_limit integer default 100)
returns table (storage_key text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 1000));
  v_stale_cutoff timestamptz := now() - interval '15 minutes';
begin
  -- Only unleased rows or rows whose lease went stale are eligible; the
  -- batch is marked leased atomically and returned. Rows are NOT deleted
  -- here — deletion happens only via ack_comment_media_cleanup after
  -- Storage removal succeeds, so a crash after claim loses nothing.
  -- SKIP LOCKED keeps concurrent sweepers from blocking on each other.
  return query
    with batch as (
      select q.storage_key
      from public.comment_media_cleanup_queue q
      where q.leased_at is null or q.leased_at < v_stale_cutoff
      order by q.enqueued_at asc, q.storage_key asc
      limit v_limit
      for update skip locked
    )
    update public.comment_media_cleanup_queue q
    set leased_at = now(),
        attempts = q.attempts + 1
    from batch b
    where q.storage_key = b.storage_key
    returning q.storage_key;
end;
$$;

comment on function public.claim_comment_media_cleanup(integer)
  is 'Lease claim (service-role sweeper only): marks up to p_limit (1..1000, default 100) unleased-or-stale (>15min) queue rows leased and returns their keys. Never deletes; pair with ack_comment_media_cleanup after Storage success.';

revoke all on function public.claim_comment_media_cleanup(integer) from public, anon, authenticated;
grant execute on function public.claim_comment_media_cleanup(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Ack companion: DELETE only after Storage success.
-- ---------------------------------------------------------------------------
create or replace function public.ack_comment_media_cleanup(p_keys text[])
returns table (storage_key text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keys text[] := coalesce(p_keys, '{}');
begin
  -- Empty ack is a no-op (timeout-safe sweeper may finish a batch with
  -- zero removals). Only listed keys are deleted; failures simply stay
  -- queued under their lease until it goes stale.
  if cardinality(v_keys) = 0 then
    return;
  end if;
  if cardinality(v_keys) > 1000 then
    raise exception 'ack batch too large (max 1000 keys)' using errcode = '22023';
  end if;
  return query
    delete from public.comment_media_cleanup_queue q
    where q.storage_key = any (v_keys)
    returning q.storage_key;
end;
$$;

comment on function public.ack_comment_media_cleanup(text[])
  is 'Ack (service-role sweeper only): deletes exactly the passed keys after Storage removal succeeded; empty input is a no-op, >1000 keys rejected. Unacked (failed) keys stay queued for stale-lease reclaim.';

revoke all on function public.ack_comment_media_cleanup(text[]) from public, anon, authenticated;
grant execute on function public.ack_comment_media_cleanup(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Re-assert: queue table stays client-denied (new columns inherit RLS).
-- ---------------------------------------------------------------------------
revoke all on public.comment_media_cleanup_queue from anon, authenticated;
