-- ===========================================================================
-- FindBack — CF-060 B2a: the moderation-privacy precondition
--            (Residual 1 + Residual 12), applied BEFORE the first writer of
--            public.item_posts.moderation_visibility.
-- ===========================================================================
--
-- LIVE-PENDING. This file has NOT been applied to the hosted project, and no
-- device/consumer proof exists for it. It is authored for independent review.
--
-- ORDER IS LOAD-BEARING. This file sorts AFTER 20261022160000 (already applied
-- to the hosted project) and BEFORE 20261022173000 (the CF-060 B2a/B2b/B2c
-- moderation migration, which is the FIRST writer of moderation_visibility).
-- The precondition is only effective if it is applied first: the moment the
-- moderation writer exists, the column this file takes away is a live oracle
-- rather than a constant.
--
-- ---------------------------------------------------------------------------
-- WHY THE ATOM MUST MOVE AT ALL (§0.2 of
-- WORK-ORDER-CF060-B2a-REPORTS.md, reproduced because the reviewer will
-- demand the argument and not the assertion).
--
--   "B1 made `findback_visible_posts` a `security_invoker` view whose `WHERE`
--    names `moderation_visibility`, so it needs the caller's column privilege
--    or every read fails `42501`
--    (20261017070000_visibility_kernel_and_blocks.sql:250-269). The grant
--    cannot be revoked while that `WHERE` exists, and `SELECT *`/`WHERE` on
--    the base table still returned a `HIDDEN` row's existence to any stranger
--    — which is Residual 12. Both are closed by the same move: the row filter
--    goes to the policy, the view becomes a projection, the column privilege
--    goes away."
--
-- The two residuals are therefore ONE defect with two faces:
--
--   * Residual 1 (the grant): 20261017070000:270 grants
--     `select (moderation_visibility) on public.item_posts to authenticated`,
--     because a security_invoker view whose body names a column is refused
--     (42501) for a caller without that column privilege. The grant is what
--     makes the view usable — and, while the base SELECT policy is
--     `using (true)` (20260914180000_client_post_reads.sql:71-73), it is also
--     what lets ANY signed-in client read the moderation state of ANY post.
--
--   * Residual 12 (the oracle): that same `using (true)` policy means
--     `select id, moderation_visibility from item_posts` answers "is this post
--     moderated?" for every post id in the table, including the ones the feed
--     does not show. While every row is 'PUBLISHED' that is inert. It is not
--     inert the moment B2 writes the column.
--
--   One move closes both: MOVE THE ATOM INTO THE POLICY. The policy is
--   evaluated with the table's own row rules and needs no column privilege
--   from the caller, so the grant can go; and once the policy refuses the
--   row, a stranger cannot learn that the row exists, so the oracle is shut
--   at the row level rather than at the column level. The view then stops
--   being a predicate and becomes a PROJECTION, so it no longer names
--   moderation_visibility and no longer needs the column grant.
--
-- ---------------------------------------------------------------------------
-- GATE 0 — VARIANT A (settled, measured; B2A-PREREQUISITES.md and
-- GATE0-VISIBILITY-ATOM-EVIDENCE.md).
--
--   "A caller with no column privilege on moderation_visibility is filtered
--    correctly by a policy that references it, through a security_invoker
--    view, and still reads every granted column; the author still sees and
--    reads their own HIDDEN row. Therefore: row 14 (revoke select
--    (moderation_visibility) … from authenticated) and row 15 (policy carries
--    moderation_visibility = 'PUBLISHED') are the shape, and no is_published
--    column exists, no CHECK ties it to the atom, and no definer visibility
--    helper is written."
--
--   So: NO `is_published` column is added, NO second column is created, and
--   NO definer visibility helper is introduced. The policy names the column
--   the table already has, and the caller never needs to read it.
--
-- ---------------------------------------------------------------------------
-- ONE POLICY = ONE PREDICATE (D11 — "no second predicate").
--
--   D9 wanted the ordinary-viewer visibility predicate to exist once. B1 put
--   it in the VIEW's WHERE. This file moves it into the base table's SELECT
--   policy and DELETES it from the view. It does not ADD a second copy: the
--   view's WHERE is removed, not duplicated, and the view's WHERE and the
--   policy's USING are the same two disjuncts in the same order, so there is
--   exactly one place in the chain where "may this viewer see this post" is
--   decided for an ordinary reader. The policy is also the STRICTLY BETTER
--   home for it: a policy is evaluated per row under the table's own rules
--   and requires no privilege from the caller, whereas a security_invoker
--   view's WHERE is evaluated against the caller's privileges and therefore
--   FORCES the column grant that creates the oracle. D11's "absent ==
--   inaccessible" rule (contract §13.1) is preserved exactly: a stranger
--   reads a HIDDEN post as zero rows, byte-identically to a post id that
--   never existed, and the owner still reads their own row in every state.
--
-- ---------------------------------------------------------------------------
-- THE FOUR MOVES (WORK-ORDER-CF060-B2a-REPORTS.md §2.7, rows 14-17):
--   14  revoke select (moderation_visibility) on public.item_posts
--   15  replace the base SELECT policy with the owner clause + the atom
--   16  recreate public.findback_visible_posts as an explicit projection
--   17  recreate public.findback_list_notifications_client with the atom
--       evaluated explicitly
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY (WORK-ORDER §4.1). No column is dropped, no row is rewritten,
-- no table is dropped, no DELETE runs, no backfill runs. The complete
-- guarded-drop inventory is:
--   * drop policy if exists item_posts_select_authenticated on public.item_posts
--       — re-created immediately, in the same transaction (row 15).
--   * drop view if exists public.findback_visible_posts
--       — re-created immediately, in the same transaction (row 16).
-- No function is dropped: the inbox reader (row 17) keeps its signature and
-- its OUT columns, so `create or replace` is sufficient. A retried apply is
-- a no-op in the same way the rest of the chain is.
--
-- ORDER INSIDE THE FILE (B2A-PREREQUISITES.md, "Ordering hazard to respect").
-- Row 16 is applied AFTER rows 15 and 14: a view recreated before the policy
-- existed would run under the old permissive USING (true), and a revoke before the
-- policy existed would make every client read fail 42501 for the duration of
-- the migration. The file is one transaction, so no client ever observes an
-- intermediate state; the order is still the order.
--
-- ---------------------------------------------------------------------------
-- ACL CLOSURE (ACL-CLOSURE.md, the fact-#14 default-ACL trap). Every object
-- this file touches is closed first and then opened exactly as far as it must
-- be:
--   * public.item_posts: ONE revoke — the column privilege. The table-level
--     SELECT privilege was never granted (20260914180000_client_post_reads.sql
--     revokes all and then grants fourteen COLUMNS), so removing the
--     moderation column leaves the fourteen granted columns and nothing else.
--     The insert/update/delete policies (20260914190000_post_mutations.sql and
--     the 20260914191000 initplan fix) are UNTOUCHED.
--   * public.findback_visible_posts: revoked from public, anon and
--     authenticated, then SELECT granted to authenticated only. anon gains
--     nothing.
--   * public.findback_list_notifications_client: revoked from public and
--     anon, EXECUTE granted to authenticated only. It is a definer, so it
--     keeps its own privileges internally and grants no row access.
--
-- ---------------------------------------------------------------------------
-- THE ONE CONCESSION THIS FILE DOES NOT MAKE. The comment reader
-- (public.findback_list_comments_client) reads public.comments, whose own
-- row rules are unchanged by this file. Invoker writers that check post
-- existence now inherit the stricter item_posts SELECT policy: a stranger
-- cannot comment/react on a HIDDEN target through those checks.
-- A comment on a post that is not visible to its reader is therefore still
-- readable. That is pre-existing B1 behaviour, not a change made here, and it
-- is recorded as a residual in the handoff rather than silently widened.
--
-- ---------------------------------------------------------------------------
-- Verification: supabase/tests/verify_20261022172000_moderation_visibility_privacy_precondition.sql
-- Static parity (including the re-anchored M1/M2/M3 fixtures) is in
-- supabase/tests/migration_parity.test.mjs.

begin;

-- ---------------------------------------------------------------------------
-- 1. Row 14 — the column privilege goes away.
--
--    `revoke all on public.item_posts from anon, authenticated` in
--    20260914180000_client_post_reads.sql:48 means `authenticated` never held
--    table-level SELECT on this table; it holds fourteen COLUMN privileges
--    plus the one added by B1 for the view. Removing that one leaves the
--    fourteen. The consequence is deliberate and is reported: a client
--    `select * from item_posts` now fails with 42501, because `*` names a
--    column the caller may not read. No client does that (the mobile app
--    reads posts through the findback_query_posts_client RPC), and the
--    migration's own view now projects the fourteen columns explicitly, so
--    nothing in the chain depends on the wildcard.
-- ---------------------------------------------------------------------------
revoke select (moderation_visibility) on public.item_posts from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Row 15 — the atom moves into the base SELECT policy. This is the ONE
--    policy = ONE predicate move (D11).
--
--    Two disjuncts, in this order:
--      * the OWNER clause (D10): the author keeps seeing their own row in
--        every state, so their own list stays complete and the client can
--        render "This report is being reviewed";
--      * the MODERATION atom: every other viewer sees the row only while it
--        is PUBLISHED, so a HIDDEN / PENDING_REVIEW / REMOVED post is absent
--        to a stranger — byte-identically to a post id that never existed
--        (contract §13.1).
--
--    `(select auth.uid())` keeps the initplan form of
--    20260914191000_fix_rls_initplan.sql, so the subject is resolved once
--    per query instead of once per row. The cast to text matches
--    item_posts.user_id, which is text.
--
--    The policy is the ONLY place the atom is decided for an ordinary
--    reader. The insert / update / delete policies are NOT touched: they
--    carry the owner's own row rules and are unaffected by moderation.
-- ---------------------------------------------------------------------------
drop policy if exists item_posts_select_authenticated on public.item_posts;

create policy item_posts_select_authenticated
  on public.item_posts
  for select
  to authenticated
  using (user_id = (select auth.uid())::text or moderation_visibility = 'PUBLISHED');

comment on policy item_posts_select_authenticated on public.item_posts is
  $cmt$FindBack ordinary-viewer post visibility, moved here from the view's WHERE (CF-060 B2a §2.7 row 15). Two disjuncts: the owner clause (the author sees their own row in every moderation state) and the moderation atom (everyone else sees a row only while it is PUBLISHED). A moderated post is therefore ABSENT to a stranger, byte-identically to an id that never existed (contract §13.1). The atom is decided HERE and nowhere else for an ordinary reader; the column privilege is revoked, and a policy needs no column privilege from the caller.$cmt$;

-- ---------------------------------------------------------------------------
-- 3. Row 16 — the view becomes a PROJECTION.
--
--    security_invoker = true is retained: RLS on item_posts still applies and
--    the view adds no privilege of its own. The WHERE is REMOVED, because the
--    policy above now decides the same two disjuncts, and keeping it would
--    mean two copies of the predicate (D11) AND would keep naming
--    moderation_visibility, which is exactly the privilege this file revokes.
--
--    The projection is EXPLICIT: the fourteen columns granted by
--    20260914180000_client_post_reads.sql:57-59, plus blocked_author. `p.*`
--    is gone precisely because it would re-name the revoked column — and
--    because a wildcard would also re-expose any column added later.
--
--    blocked_author is retained unchanged: the caller-scoped, direction-free
--    O5 signal (contract §13.8 item 3) that marks a row whose author is
--    blocked with the caller. Blocking is SURFACED, never applied as a row
--    filter; this file does not touch it.
--
--    The DROP is a plain RESTRICT drop, guarded by `if exists`, and the
--    re-created view has the same name, so the readers that select from it
--    (findback_query_posts_client, findback_query_posts_nearby_client,
--    findback_match_candidates_client) resolve to the new definition. Their
--    own return shapes are unchanged: they name the fourteen columns
--    explicitly and never selected moderation_visibility.
-- ---------------------------------------------------------------------------
drop view if exists public.findback_visible_posts;

create view public.findback_visible_posts with (security_invoker = true) as
select
  p.id,
  p.user_id,
  p.type,
  p.title,
  p.description,
  p.category,
  p.status,
  p.event_date,
  p.latitude,
  p.longitude,
  p.location_label,
  p.youtube_url,
  p.created_at,
  p.updated_at,
  public.findback_is_blocked_with_me(p.user_id) as blocked_author
from public.item_posts p;

revoke all on public.findback_visible_posts from public, anon, authenticated;
grant select on public.findback_visible_posts to authenticated;

comment on view public.findback_visible_posts is
  $cmt$FindBack ordinary-viewer post projection (CF-060 B2a §2.7 row 16). The visibility predicate now lives in the item_posts SELECT policy, so this view carries NO WHERE and no second copy of it (D11). security_invoker, so it adds no privilege beyond public.item_posts RLS and the caller's own column grants. The projection is EXPLICIT: the fourteen columns granted by 20260914180000_client_post_reads.sql:57-59, plus blocked_author — the caller-scoped, direction-free O5 signal that marks a row whose author is blocked with the caller. Blocking is surfaced, never applied as a row filter. moderation_visibility is NOT projected: the column privilege is revoked and the predicate is the policy's job.$cmt$;

-- ---------------------------------------------------------------------------
-- 4. Row 17 — the inbox reader evaluates the atom EXPLICITLY.
--
--    public.findback_list_notifications_client is a SECURITY DEFINER reader,
--    and a definer bypasses RLS on public.item_posts. Its D21 moderation
--    half used to be enforced by asking the view
--    (`exists (select 1 from public.findback_visible_posts v where v.id = n.post_id)`),
--    and the view's WHERE was the atom. Row 16 removes that WHERE, so without
--    this change the reader would silently stop filtering: a stored-then-
--    hidden row would be rendered again, which is the D21 defect
--    ("a row that shipped before the block is not rendered") reopening in the
--    moderation direction.
--
--    So the atom is evaluated HERE, explicitly, with the same two disjuncts:
--    the target post's author still sees notifications about their own post,
--    and every other recipient sees the notification only while the target
--    post is PUBLISHED. A null post_id keeps the FENCE arm (a post-less row
--    is kept, never dropped).
--
--    This is the ONE recurrence of the atom that a definer forces, exactly as
--    the contract already accepts one recurrence in the notify trigger
--    (20261017070000 §9): a definer answers for a THIRD PARTY, so it cannot
--    ask an invoker object what that party may see. Every other reader of
--    this chain inherits the predicate from the policy or from the view and
--    therefore needs no atom of its own.
--
--    The alias `p` inside the sub-select is THIS file's spec-literal form; it
--    shadows the outer LEFT JOIN alias of the same name for the sub-select
--    only, and both name public.item_posts. The outer `p` still supplies
--    post_title.
-- ---------------------------------------------------------------------------
create or replace function public.findback_list_notifications_client(
  p_deleted boolean default false
)
returns table (
  id text,
  type text,
  preview text,
  read integer,
  created_at text,
  actor_id text,
  actor_username text,
  post_id text,
  post_title text,
  comment_id text,
  reaction_kind text,
  blocked_actor boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return query
    select
      n.id, n.type, n.preview, n.read, n.created_at,
      n.actor_id, u.username as actor_username,
      n.post_id, p.title as post_title,
      n.comment_id, n.reaction_kind,
      public.findback_is_blocked_with_me(n.actor_id) as blocked_actor
    from public.notifications n
    left join public.users u on u.id = n.actor_id
    left join public.item_posts p on p.id = n.post_id
    where n.user_id = v_uid
      -- D21 (moderation half), evaluated EXPLICITLY. The reader is a
      -- definer, so it bypasses the policy; the atom has to be written out
      -- here or the filter would silently stop filtering (row 17).
      and (
        n.post_id is null
        or exists (
          select 1 from public.item_posts p
           where p.id = n.post_id
             and (p.user_id = v_uid or p.moderation_visibility = 'PUBLISHED')
        )
      )
      and (
        (p_deleted and n.deleted_at is not null)
        or (not p_deleted and n.deleted_at is null)
      )
    order by
      case when p_deleted then n.deleted_at else n.created_at end desc,
      n.id desc
    limit 100;
end;
$$;

revoke all on function public.findback_list_notifications_client(boolean) from public, anon;
grant execute on function public.findback_list_notifications_client(boolean) to authenticated;

comment on function public.findback_list_notifications_client(boolean) is
  $cmt$FindBack notification inbox (authenticated): caller-owned rows newest first; p_deleted selects the soft-deleted view. REACTION rows carry the canonical kind in reaction_kind (null on legacy rows). Max 100. blocked_actor is the O5 signal: true when the caller is blocked with the row's actor (caller-scoped, direction-free); the row is returned either way. Moderation still collapses: the D21 moderation half is evaluated EXPLICITLY here (CF-060 B2a §2.7 row 17), because this reader is a definer and a definer bypasses the item_posts SELECT policy; a row whose target post is not visible to this caller is not rendered.$cmt$;

commit;
