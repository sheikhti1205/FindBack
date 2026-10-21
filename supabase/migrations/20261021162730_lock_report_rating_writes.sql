-- FindBack — close the client report-rating write path.
--
-- WHY THIS FILE EXISTS. The app stopped writing a report rating (D1: an
-- arbitrary score on a report was never backed by a confirmed relationship),
-- but the SERVER still offered that write to every signed-in account:
--
--   * `public.findback_rate_client(text, integer)` was executable by
--     `authenticated`, and it wrote straight into `public.ratings` — so any
--     account could set a score on ANY report, including reports it has no
--     connection to.
--   * `public.ratings` carried an INSERT policy (`ratings_insert_own`) and a
--     DELETE policy (`ratings_delete_own`) for `authenticated`, and the table
--     itself was granted INSERT/DELETE to `authenticated`. The RPC was
--     therefore not the only door: PostgREST could insert the same row
--     directly.
--
-- The community average is shown to readers as the community's opinion, so it
-- has to mean something. With the write open, one account could move any
-- report's average to any value. The client saying "ratings are read-only"
-- while the server still accepted the write was a half-truth; this file makes
-- it true end to end.
--
-- WHAT THIS FILE DOES.
--   1. Drops the client INSERT and DELETE policies on `public.ratings`.
--   2. Revokes INSERT/UPDATE/DELETE on `public.ratings` from the client
--      roles. The SELECT grant stays: the ratings that already exist stay
--      readable, and the feed still computes the average from them.
--   3. Revokes EXECUTE on `findback_rate_client(text, integer)` from
--      `authenticated`. The function itself stays in the schema and stays
--      executable by `service_role`/`postgres`, so the relationship-backed
--      writer that replaces it (R1) can be added later without recreating
--      this shape — and so nothing about this file has to be undone later.
--
-- WHAT THIS FILE DOES NOT DO.
--   * It deletes no row and rewrites no data. The ratings readers already
--     gave stay exactly where they are.
--   * It does not touch the reaction path: reactions are a different feature
--     with a different rule (one row per reader per target), and they keep
--     their own write path.
--   * It does not remove the READ path. `findback_post_social_state_client`
--     still answers "what did this reader rate?" for the historical rows, and
--     the community average is still computed from the ratings table.
--
-- THE CONSEQUENCE, STATED PLAINLY: the community average becomes HISTORICAL.
-- It shows what readers rated before this change and it cannot move until a
-- relationship-backed rating exists (R1). The client already presents the
-- rating as read-only ("Report ratings are read-only."), so the surface and
-- the server now agree.
--
-- ADDITIVE ONLY in the sense that it removes ACCESS, never data: no table is
-- dropped, no row is deleted, no applied file is edited. Every statement is
-- idempotent, so re-running this file changes nothing.
--
-- Verification pointer: supabase/tests/verify_20261021162730_lock_report_rating_writes.sql

-- ---------------------------------------------------------------------------
-- 1. No client policy can write a rating any more.
-- ---------------------------------------------------------------------------
-- The policies are the first lock (RLS) and the grants the second; both are
-- removed here, because leaving either one open would leave the hole open.
drop policy if exists ratings_insert_own on public.ratings;
drop policy if exists ratings_delete_own on public.ratings;

-- ---------------------------------------------------------------------------
-- 2. No client role holds a write privilege on the table.
-- ---------------------------------------------------------------------------
-- SELECT stays: the ratings stay readable, so the average keeps rendering.
revoke insert, update, delete on public.ratings from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 3. The rating RPC is not callable by a client any more.
-- ---------------------------------------------------------------------------
-- The function is left in place (and left executable by service_role) so a
-- future relationship-backed writer can supersede it in a reviewed migration
-- instead of a resurrection.
revoke execute on function public.findback_rate_client(text, integer) from anon, authenticated, public;
-- Preserve the stated administrative contract explicitly, not via a hosted
-- default ACL that may differ between installations.
grant execute on function public.findback_rate_client(text, integer) to service_role;

comment on function public.findback_rate_client(text, integer) is
  'FindBack rate a report: NOT callable by clients any more (2026-10-21). A rating was never backed by a confirmed relationship, so the client write path was closed and the community average is historical until a relationship-backed rating (R1) replaces this function. Readable history stays: the ratings table keeps its SELECT grant and findback_post_social_state_client still answers for the caller''s own historical score.';
