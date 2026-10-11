-- FindBack — least-privilege grants on server-only tables (FBX-034).
--
-- WHY: `notifications`, `device_tokens`, `notification_preferences` and
-- `push_reply_tokens` are reached ONLY through SECURITY DEFINER RPCs
-- (granted EXECUTE to authenticated) and the service-role push dispatcher.
-- The client never reads or writes them over REST/PostgREST, and the inbox
-- realtime is a data-free broadcast (`notification:added` on a private
-- channel), not postgres_changes on this table — so no client-facing grant
-- is needed at all.
--
-- WHAT THE EARLIER MIGRATION LEFT OPEN: `20261002050000_push_hardening.sql`
-- revoked column-DML on the three push tables and only `revoke select` on
-- `notifications` — INSERT/UPDATE/DELETE grants from Supabase's default ACL
-- survived on `notifications`, and TRUNCATE/TRIGGER/REFERENCES survived on
-- all four. This migration closes that retroactively.
--
-- INVARIANTS (enforced by apps/mobile/src/services/leastPrivilege.migration.test.ts):
--   * `revoke all ... from anon, authenticated` on each of the four tables
--     (strips every privilege the default ACL handed out, not just DML);
--   * NO grant of any kind to anon/authenticated in this file;
--   * NO touch of any client-reachable table (item_posts, comments, users,
--     comment_attachments, comment_reactions) or function EXECUTE grant —
--     RPC grants are function-level and live in their own migrations.
--
-- ADDITIVE ONLY in the hardening direction: nothing is granted, nothing is
-- dropped; service_role keeps full access (granted by Supabase's defaults
-- for the service role, untouched here). Rollback = re-grant the default
-- ACL (not needed: no legitimate client path used these grants).
--
-- No `postgres_changes` subscription on these tables exists anywhere in the
-- app (verified: zero hits in apps/mobile), so realtime is unaffected.

revoke all on public.notifications from anon, authenticated;
revoke all on public.device_tokens from anon, authenticated;
revoke all on public.notification_preferences from anon, authenticated;
revoke all on public.push_reply_tokens from anon, authenticated;
