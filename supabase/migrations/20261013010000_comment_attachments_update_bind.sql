-- FindBack — comment attachment UPDATE bind (FB-AUD-03 follow-up to 20261011020000).
--
-- SUPERSEDES the comment_attachments_update_own policy created in
-- 20261011020000_comment_attachments_relation.sql, and why (FB-AUD-03):
-- that UPDATE policy gated USING and WITH CHECK on user_id only, so an
-- owner could UPDATE their own attachment row and reassign comment_id to a
-- comment they do not own (WITH CHECK passed on user_id alone). This file
-- drop-if-exists + recreates ONLY that UPDATE policy so BOTH USING and
-- WITH CHECK require user_id = auth.uid() AND the row's comment_id to
-- belong to a comment owned by the caller — the same EXISTS anti-join
-- pattern the INSERT policy uses. Select/insert/delete policies are
-- untouched.
--
-- ADDITIVE ONLY: one policy drop + recreate on public.comment_attachments.
-- No table/column drops, no row rewrites, no grants touched, no edits to
-- any applied migration (20261011020000 is already applied live and is
-- NEVER edited; this file supersedes its UPDATE policy at apply time).
-- LIVE-PENDING (owner-deferred): verify on the live project with
-- supabase/tests/verify_20261013010000_attachment_update_bind.sql
-- (owner display_order edit still allowed; reassignment to a foreign
-- comment_id rejected by WITH CHECK).
--
-- Idempotent: drop policy if exists + recreate; safe to re-run.

drop policy if exists comment_attachments_update_own on public.comment_attachments;
create policy comment_attachments_update_own
  on public.comment_attachments for update to authenticated
  using (
    user_id = (select auth.uid())::text
    and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
  )
  with check (
    user_id = (select auth.uid())::text
    and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
  );
