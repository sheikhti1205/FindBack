-- FindBack — B1: the visibility kernel, blocking, and the D21 readers.
--
-- WHY THIS FILE EXISTS. FindBack had no way to express "this report is not
-- visible to you" other than "this row does not exist", and no way to express
-- "this person is blocked" at all. Every consumer read therefore had the same
-- meaning it always had: *every* row of public.item_posts, to *every* signed-in
-- caller. This file adds the one object that decides ordinary-viewer post
-- visibility (a security_invoker view), the one table that records a block
-- (public.user_blocks), the block predicate in its two-party INTERNAL form
-- (findback_is_blocked_pair, not client-callable) and its self-subject client
-- surface (findback_is_blocked_with_me), the additive column the predicate
-- reads (public.item_posts.moderation_visibility), the owner-scoped block
-- reader, and
-- the re-creations of the five readers that must read the view / surface the
-- block flag / enforce D21's notification suppression.
--
-- Authority: FindBack-internal/.../trust-backend/MODERATION-CONTRACT-DECISION.md
-- §3 D8–D11, §4 D16–D24, §8 D40–D42, §9 C8, §10 C9 (layers + fixtures M1–M17),
-- and §13.8 D12 amended (the two-function split + the O5 visibility
-- consequence). Nothing is decided here that the contract does not already
-- state; the places where this file is an interpretation are called out inline
-- (D12 SPLIT, O5 SURFACED, D19 SUPERSEDED below, and the column grant in
-- section 3).
--
-- O5 — BLOCKING IS MUTUAL BUT VISIBLE (§13.5, §13.8 item 3). A block severs
-- INTERACTION; it does NOT hide content. The view therefore does not filter a
-- blocked author's PUBLISHED rows out — it returns them and marks them
-- (`blocked_author`). Contract §13.9 makes carrying that bit through the feed
-- and nearby RPCs a REQUIRED integration; those RPCs do not project it yet, so
-- this file claims no blur behaviour on their behalf. The comment reader does
-- the same (`blocked_author`) and the notification inbox does the same
-- (`blocked_actor`). Only the MODERATION direction still
-- collapses: a HIDDEN post is indistinguishable from an absent one (absent ==
-- inaccessible). In THIS file interaction refusal is enforced in exactly one
-- place: the D21 notify trigger below suppresses a notification across a block.
-- There are no comment/reaction writer guards here and none is claimed — the
-- shipped insert policy is ownership + post-existence only, so a blocked
-- party's comment or reaction still writes and is merely not notified (this
-- draft's own `B1-15` inserts a cross-block comment and asserts only that no
-- notification is stored; round-4 review MINOR-2 / round-5 review MINOR-2). The
-- contract's "writer guards" are recorded as owed in README Residual 16, not as
-- shipped behaviour. Refusal is never implemented by deleting rows from a
-- reader. Blocking is therefore NOT a row filter anywhere in this file.
--
-- D19 SUPERSEDED. D19 dropped a blocked author's comment and promoted any
-- surviving reply to its nearest surviving ancestor. O5 (above) supersedes the
-- drop: the reader now returns every comment of the post and flags the blocked
-- ones, so there is nothing left to promote and the recursive promotion walk is
-- not shipped. This is a contract divergence, recorded for the coordinator in
-- README.md Residual 0 alongside the D12 amendment.
--
-- INERT BY CONSTRUCTION. With moderation_visibility all-'PUBLISHED' and
-- user_blocks empty, the view is a pass-through, every flag is false and every
-- guard below is a no-op, so this file changes zero rows of output on every
-- affected reader and zero rows in public.notifications. That is not a claim:
-- it is measured by inertness-selfcheck.mjs, which hashes every affected
-- reader's rows before and after this file on one fixed fixture (layer 1b).
--
-- ADDITIVE ONLY. No column drop, no row rewrite, no DELETE, no UPDATE, no
-- unguarded ADD CONSTRAINT. The complete guarded-drop inventory is:
--   * drop view if exists public.findback_visible_posts          (section 4, this file's own object)
--   * drop constraint if exists item_posts_moderation_visibility_check (section 3, re-added immediately)
--   * drop function if exists public.findback_list_comments_client(text)      (section 8, re-created immediately; one OUT column added for O5)
--   * drop function if exists public.findback_list_notifications_client(boolean) (section 10, re-created immediately; one OUT column added for O5)
-- Each re-created function is dropped ONLY because PostgreSQL cannot change a
-- function's OUT columns with `create or replace`; all four are re-created in
-- the same transaction, and every one is guarded with `if exists`.
-- Nothing else is dropped anywhere.
--
-- REFERENCE-TEXT RECURRENCE (the one interpretation, flagged). D9 requires the
-- visibility predicate to exist once. It does — in the view — but D21 also
-- requires the *trigger* to skip a notification whose target post is no longer
-- visible to the RECIPIENT, and a security_invoker view cannot answer a
-- visibility question for a third party (auth.uid() is the caller, not the
-- recipient). The trigger therefore reads the same MODERATION atom for the
-- recipient, and — because O5 keeps D21's interaction refusal — it ALSO reads
-- the block question between recipient and actor in its two-party INTERNAL form
-- (findback_is_blocked_pair), which the view deliberately no longer carries.
-- The parity block in supabase/tests/migration_parity.test.mjs does not take
-- that on trust: it proves the trigger's moderation atom normalised EQUAL to
-- the view's WHERE moderation atom with the viewer substituted, and pins the
-- trigger's D21 interaction term separately, so neither half can drift.
--
-- ACL CLOSURE (ACL-CLOSURE.md, the fact-#14 default-ACL trap). Every object
-- this file creates is revoked from public/anon/authenticated first and then
-- granted to exactly the role that needs it: anon gains nothing, and
-- authenticated gains EXECUTE on two definer helpers and SELECT on one view.
-- One additional grant is required and is not a new object:
-- authenticated gains SELECT on public.item_posts(moderation_visibility),
-- because a security_invoker view whose body names a column is unusable for a
-- caller who does not hold that column's privilege. That grant, and the
-- indistinguishability residual it creates against the existing
-- `using (true)` SELECT policy on the table, are stated in full in section 3
-- and in README.md.
--
-- EXECUTION STATUS (see EVIDENCE-B1-R3-AUTHOR.md). Layer 1 (static parity),
-- layer 1b (engine behaviour + inertness) and the layer-2 catalog probes are
-- RUN. Section 1 of the verify file has now been executed statement-by-statement
-- against a real PostgreSQL 17.5 cluster with this migration applied on top of
-- the full 60-file chain (61/61 applied, 0 failed), and every probe that could
-- be executed locally has been executed AND shown to go EMPTY under a targeted
-- mutation (negative controls). The D10 audience matrix, the block/unblock
-- behaviour and the notification suppression have likewise been executed
-- locally with `set role authenticated` plus a JWT `sub` claim, and are
-- reported as measurements in that file. What remains owner-only is the run
-- against the hosted project itself (version parity of the deparse output) and
-- the client-side blur/reveal surface, which has no rendered review anywhere.
-- The owner's probes are
-- supabase/tests/verify_20261017070000_visibility_kernel_and_blocks.sql.
--
-- LIVE-PENDING. Reported as pending, never as passed.
--
-- MAJOR-1 (review-cf060-b1). The two-party predicate was ONE client-granted
-- function, so any signed-in caller could ask the truth value of a pair they
-- are not part of — an undisclosed block-graph oracle. It is now split: the
-- pair oracle is INTERNAL (granted to nobody) and the only client surface is
-- the self-subject findback_is_blocked_with_me(p_other). This gives up D12's
-- originally-named two-argument client surface; the contract amendment that
-- documents the substitution is owed and recorded in README.md / EVIDENCE.
-- §13.8 rules the self-subject form NOT an oracle: it is caller-scoped and
-- direction-free, one bit about a named other party, computed only from rows in
-- which the caller is a party. That is exactly the signal O5 needs, which is
-- why the two readers and the view can carry it as a per-row flag with no new
-- surface at all.


-- ===========================================================================
-- 1. public.user_blocks — directional rows, nobody may read them (D16/D18)
-- ===========================================================================
-- One row per ACT, so an unblock (D22) can be per-direction. Both FKs are
-- `on delete cascade`: a block to or from a deleted account is meaningless, and
-- a deletion is not an unblock the user performed.
--
-- D18 is enforced by ABSENCE OF GRANT plus RLS with ZERO POLICIES, because
-- Supabase's default ACL grants authenticated table-level rights on every new
-- table, so "no policy" alone would not be "no access". With no SELECT grant
-- and no policy, the symmetric term of the predicate is also unreachable from a
-- client: it is answered only by the definer helper in section 2, which never
-- returns rows.
create table if not exists public.user_blocks (
  blocker_user_id text not null references public.users(id) on delete cascade,
  blocked_user_id text not null references public.users(id) on delete cascade,
  created_at text not null,
  primary key (blocker_user_id, blocked_user_id),
  constraint user_blocks_self_check check (blocker_user_id <> blocked_user_id)
);

alter table public.user_blocks enable row level security;

revoke all on public.user_blocks from public, anon, authenticated;

comment on table public.user_blocks is
  'FindBack block rows (directional act, symmetric effect). No client reads this table: findback_is_blocked_with_me() answers the predicate for the caller and findback_my_blocks() exposes the caller''s own outgoing rows. No grant, no policy, by design (D18).';

-- ===========================================================================
-- 2. public.findback_is_blocked_pair(text, text) -> boolean (D12, INTERNAL)
--    public.findback_is_blocked_with_me(text)    -> boolean (D18, the surface)
-- ===========================================================================
-- TWO functions, deliberately. The predicate itself is symmetric and takes both
-- parties, because the D21 trigger answers it for a THIRD PARTY: a notification
-- recipient is not the caller, and a security_invoker view cannot speak for
-- them. But handing that two-argument form to `authenticated` is an inverse
-- reader: (me, X) = true while X is not in findback_my_blocks() tells the
-- blocked party that X blocked them, and — because BOTH arguments are
-- caller-supplied text — any pair of OTHER users (author ids are public) is
-- answerable the same way. That is the block-graph oracle D18 exists to forbid
-- (REVIEW-CF060-B1 MAJOR-1, measured on a PG16 engine: as u4, a caller in no
-- block, ('u1','u2') returned true).
--
-- So the predicate is INTERNAL: revoked from public, anon AND authenticated, and
-- reachable only from inside the definer functions that need it (the D21
-- trigger, and the wrapper below). It returns a BOOLEAN and never a row set
-- either way: a row-returning helper would let a caller enumerate who blocked
-- whom (fixture M5 pins prorettype).
--
-- The CLIENT-CALLABLE surface is findback_is_blocked_with_me(p_other): the first
-- party is auth.uid(), NEVER a parameter, so a caller can only ask "am I blocked
-- with X?" — the question its own feeds already answer. This is the
-- least-privilege form: it gives up the ability to ask about a pair the caller
-- is not part of, and nothing else; every sanctioned call site in this file
-- passes exactly one third party next to the caller. It is also the self-subject
-- signalling surface the owner's "blocking is mutual and visible" ruling
-- sanctions (a client can label a blocked-pair row without learning who blocked
-- whom). The contract's D12 names the two-argument form as the client callable;
-- this split is the amendment recorded in README.md, not a silent deviation.
--
-- The disjunction is symmetric on purpose (D17): the ACT is one-sided, but the
-- EFFECT is mutual, and that is what the confirmation copy promises the user.
-- A NULL argument is never a match, so a row with no actor (a STATUS
-- notification) is never suppressed, and a caller with no auth.uid() is never
-- told it is blocked with anyone.
create or replace function public.findback_is_blocked_pair(p_a text, p_b text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.user_blocks b where (b.blocker_user_id = p_a and b.blocked_user_id = p_b) or (b.blocker_user_id = p_b and b.blocked_user_id = p_a));
$$;

-- Nobody may call it directly: not public, not anon, not authenticated. The only
-- reachable paths are the two definer functions in this section and the D21
-- trigger, all of which run with the owner's privileges.
revoke all on function public.findback_is_blocked_pair(text, text) from public, anon, authenticated;

comment on function public.findback_is_blocked_pair(text, text) is
  'FindBack block predicate, INTERNAL (not client-callable): true when a block row exists in either direction between the two users. Callable only from the definer functions of this chain; findback_is_blocked_with_me() is the client surface (D18).';

-- The self-subject surface. auth.uid() supplies the first party, so the only
-- thing a caller controls is the second argument, and the answer is never about
-- a pair the caller is not part of. A NULL auth.uid() makes the predicate false
-- (a NULL argument is never a match), which is the same no-identity posture the
-- view takes; there is no silent "you are blocked" for a caller with no subject,
-- and anon holds no EXECUTE anyway.
create or replace function public.findback_is_blocked_with_me(p_other text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.findback_is_blocked_pair(auth.uid()::text, p_other);
$$;

revoke all on function public.findback_is_blocked_with_me(text) from public, anon;
grant execute on function public.findback_is_blocked_with_me(text) to authenticated;

comment on function public.findback_is_blocked_with_me(text) is
  'FindBack block predicate, client surface (authenticated): true when auth.uid() and p_other are blocked in either direction. Self-subject only, so it can never answer for a pair the caller is not part of (D18). Not granted to anon. Returns a boolean, never rows.';

-- ===========================================================================
-- 3. public.item_posts.moderation_visibility (additive, no writer) (D8)
-- ===========================================================================
-- The column is ADDITIVE and has NO WRITER in this chain: no RPC inserts it, no
-- UPDATE grant names it, and the owner-writable status column stays what it is
-- ("Recovered"), so an owner cannot clear their own moderation by writing
-- status (fixture M4 pins the UPDATE grant list). `not null default` is
-- applied by the catalog without rewriting an existing row, and no backfill
-- runs. No index: nothing filters on it yet (R9).
alter table public.item_posts
  add column if not exists moderation_visibility text not null default 'PUBLISHED';

alter table public.item_posts
  drop constraint if exists item_posts_moderation_visibility_check;
alter table public.item_posts
  add constraint item_posts_moderation_visibility_check
  check (moderation_visibility in ('PUBLISHED', 'PENDING_REVIEW', 'HIDDEN', 'REMOVED'));

-- REQUIRED GRANT, NOT OPTIONAL (measured, not reasoned). D9 makes the view
-- security_invoker, so every privilege the view body exercises is checked
-- against the CALLER. The body names moderation_visibility (in the predicate)
-- and expands p.*, and PostgreSQL refuses a security_invoker view whose body
-- names a column the caller cannot read: without the line below every
-- authenticated read of findback_visible_posts — and therefore both feed
-- readers, which read the view — fails with 42501 `permission denied for
-- view`, i.e. B1 would ship a dead feed. The grant is column-scoped, the
-- precedent (20261015174749_client_read_grants_invoker_paths.sql) is a
-- column-scoped read-repair, and anon gains nothing.
--
-- RESIDUAL, STATED NOT HIDDEN. public.item_posts carries a SELECT policy
-- `using (true)` (20260914180000_client_post_reads.sql:71-73), so this grant
-- also makes the moderation state of any post directly readable by any
-- signed-in client (select id, moderation_visibility from item_posts). While
-- every row is 'PUBLISHED' that is inert, and it is inert for the whole life of
-- B1 because B1 has no writer; it becomes an indistinguishability (P1/D11)
-- oracle the moment B2 writes the column. Closing it needs a second predicate
-- (an RLS tightening on item_posts), which D11 forbids, so it is recorded as an
-- owner decision in README.md rather than fixed here.
grant select (moderation_visibility) on public.item_posts to authenticated;

-- ===========================================================================
-- 4. public.findback_visible_posts — the single predicate (D9)
-- ===========================================================================
-- THIS IS THE ONLY OBJECT THAT DECIDES ORDINARY-VIEWER POST VISIBILITY. Every
-- consumer path that used to read item_posts for a report the viewer did not
-- author reads this instead, so feed, nearby, direct-by-id, search, profile and
-- the comment card are the same rows by construction and there is no second
-- predicate to disagree with.
--
--   * security_invoker = true: RLS on item_posts still applies and the view
--     adds no privilege of its own (fixture M3 pins the reloption).
--   * the owner clause keeps the author's own list complete in every state, so
--     the owner can be told "This report is being reviewed".
--   * `anon` cannot read it: anon holds no grant on item_posts and none on the
--     view.
--   * the aggregate subqueries do NOT move in here — counts stay global and
--     viewer-independent (D14).
--
-- O5 SURFACED, NOT FILTERED (§13.5 / §13.8 item 3). There is NO block term in
-- the WHERE. A block relationship between the caller and an author is surfaced
-- as the projected boolean `blocked_author`, computed with the caller-scoped,
-- direction-free findback_is_blocked_with_me(), so every PUBLISHED report stays
-- visible to every viewer and the client can blur the row and offer
-- tap-to-reveal. Deleting the row is what this revision removed: with a WHERE
-- filter the client could not render the content at all, which is the opposite
-- of what the owner ruled. The atom that DOES remain in the WHERE is
-- moderation: a HIDDEN/PENDING_REVIEW/REMOVED report is absent to everyone but
-- its author, which is still the "absent == inaccessible" collapse (§13.1).
-- `blocked_author` is true only for rows the caller is a party to, so a third
-- party's read is bit-for-bit what it was before this file (measured in
-- EVIDENCE-B1-R3-AUTHOR.md).
drop view if exists public.findback_visible_posts;

create view public.findback_visible_posts with (security_invoker = true) as
select p.*,
       public.findback_is_blocked_with_me(p.user_id) as blocked_author
from public.item_posts p
where p.user_id = (select auth.uid())::text
   or p.moderation_visibility = 'PUBLISHED';

revoke all on public.findback_visible_posts from public, anon, authenticated;
grant select on public.findback_visible_posts to authenticated;

comment on view public.findback_visible_posts is
  'FindBack ordinary-viewer post visibility (D9 + O5): the viewer''s own rows in any state, plus every PUBLISHED row of every author. Blocking does not remove a row: the projected boolean blocked_author marks a row whose author is blocked with the caller (caller-scoped, direction-free). Contract §13.9 requires a feed reader that projects this bit to carry it through; the feed RPCs do not project it yet. Moderation still collapses: a non-PUBLISHED report is absent to everyone but its author. security_invoker, so it adds no privilege beyond public.item_posts RLS.';

-- ===========================================================================
-- 5. public.findback_my_blocks() — the caller's own outgoing rows (D18)
-- ===========================================================================
-- Exactly two columns and no inverse reader: the direction and the actor are
-- unknowable from the client (a blocked user's experience under O5 is "blurred
-- content, flagged", never "blocked, by them"). Definer because user_blocks is
-- granted to nobody; the
-- auth.uid() guard is the whole authorization model.
create or replace function public.findback_my_blocks()
returns table (
  blocked_user_id text,
  created_at text
)
language plpgsql
stable
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
    select b.blocked_user_id, b.created_at
    from public.user_blocks b
    where b.blocker_user_id = v_uid
    order by b.created_at desc, b.blocked_user_id asc;
end;
$$;

revoke all on function public.findback_my_blocks() from public, anon;
grant execute on function public.findback_my_blocks() to authenticated;

comment on function public.findback_my_blocks() is
  'FindBack blocked-users list (authenticated): the caller''s OWN outgoing block rows only (blocked_user_id, created_at). No inverse reader exists (D18).';


-- ===========================================================================
-- 6. public.findback_query_posts_client — reads the view (D9)
-- ===========================================================================
-- Re-created from 20261015154642_attachment_dimensions.sql:316-498 with exactly
-- ONE delta: the report source, `from item_posts p` -> `from public.
-- findback_visible_posts p`. Signature, return shape, filters, aggregates,
-- keyset cursor, page clamp and comment are byte-identical to the applied text
-- (assemble.mjs asserts the round-trip; the parity block re-derives it).
-- Because the view exposes p.* plus the O5 flag column, the reader carries NO
-- visibility term of its own: the predicate is not repeated here, it is
-- inherited, and `blocked_author` reaches a caller through the view for any
-- caller that wants it (the feed readers below do not project it, so their
-- return shape is byte-identical to the applied text).

create or replace function public.findback_query_posts_client(
  p_user_id text default null,
  p_type text default null,
  p_category text default null,
  p_status text default null,
  p_q text default null,
  p_date_from text default null,
  p_date_to text default null,
  p_cursor_created_at text default null,
  p_cursor_id text default null,
  p_order text default 'desc',
  p_limit integer default 10,
  p_post_id text default null
)
returns table (
  id text,
  user_id text,
  type text,
  title text,
  description text,
  category text,
  status text,
  event_date text,
  latitude double precision,
  longitude double precision,
  location_label text,
  youtube_url text,
  created_at text,
  updated_at text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text,
  like_count bigint,
  dislike_count bigint,
  rating_avg numeric,
  rating_count bigint,
  comment_count bigint,
  attachments jsonb,
  total_count bigint,
  reaction_counts jsonb,
  reaction_total bigint,
  my_reaction text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with filtered as (
    select
      p.*,
      u.username as author_username,
      u.email_verified as author_email_verified,
      u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url,
      u.created_at as author_created_at,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'LIKE') as like_count,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'DISLIKE') as dislike_count,
      (select avg(ra.score) from ratings ra where ra.post_id = p.id) as rating_avg,
      (select count(ra.id) from ratings ra where ra.post_id = p.id) as rating_count,
      (select count(c.id) from comments c where c.post_id = p.id) as comment_count,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'post_id', a.post_id,
            'file_url', a.file_url,
            'mime_type', a.mime_type,
            'file_name', a.file_name,
            'file_size', a.file_size,
            'created_at', a.created_at,
            'display_order', a.display_order,
            'width', a.width,
            'height', a.height
          ) order by a.display_order asc, a.created_at asc, a.id asc
        )
        from attachments a
        where a.post_id = p.id
      ), '[]'::jsonb) as attachments,
      count(*) over() as total_count,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                 count(*) as n
          from public.reactions r
          where r.post_id = p.id
          group by 1
        ) t
      ), '{}'::jsonb) as reaction_counts,
      (select count(r.id) from reactions r where r.post_id = p.id) as reaction_total,
      (select r.type from reactions r
        where r.post_id = p.id and r.user_id = auth.uid()::text
        limit 1) as my_reaction
    from public.findback_visible_posts p
    join users u on u.id = p.user_id
    where
      (p_post_id is null or p.id = p_post_id)
      and (p_user_id is null or p.user_id = p_user_id)
      and (p_type is null or p.type = p_type)
      and (p_category is null or p.category = p_category)
      and (p_status is null or p.status = p_status)
      and (
        p_q is null
        or lower(p.title) like '%' || lower(p_q) || '%'
        or lower(p.description) like '%' || lower(p_q) || '%'
      )
      and (p_date_from is null or p.event_date >= p_date_from)
      and (p_date_to is null or p.event_date <= p_date_to)
  )
  select
    id,
    user_id,
    type,
    title,
    description,
    category,
    status,
    event_date,
    latitude,
    longitude,
    location_label,
    youtube_url,
    created_at,
    updated_at,
    author_username,
    author_email_verified,
    author_phone_verified,
    author_avatar_url,
    author_created_at,
    like_count,
    dislike_count,
    rating_avg,
    rating_count,
    comment_count,
    attachments,
    total_count,
    reaction_counts,
    reaction_total,
    my_reaction
  from filtered
  where
    p_cursor_created_at is null
    or (
      p_order = 'asc'
      and (
        created_at > p_cursor_created_at
        or (created_at = p_cursor_created_at and id > coalesce(p_cursor_id, ''))
      )
    )
    or (
      p_order <> 'asc'
      and (
        created_at < p_cursor_created_at
        or (created_at = p_cursor_created_at and id < coalesce(p_cursor_id, ''))
      )
    )
  order by
    (case when p_order = 'asc' then created_at end) asc,
    (case when p_order = 'asc' then id end) asc,
    (case when p_order <> 'asc' then created_at end) desc,
    (case when p_order <> 'asc' then id end) desc
  limit least(greatest(p_limit, 0), 20);
$$;


revoke all on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) from public;

revoke all on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) from anon;

grant execute on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) to authenticated;

comment on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) is 'FindBack client feed/listing (authenticated): post + public author + aggregates + display_order-ranked attachments with keyset pagination, exact post lookup and total_count window. reaction_counts/reaction_total/my_reaction are the canonical reaction truth (LIKE folded to LOVE); like_count/dislike_count remain as compat. Never returns author email/phone. Page size clamped to 20.';

-- ===========================================================================
-- 7. public.findback_query_posts_nearby_client — reads the view (D9)
-- ===========================================================================
-- Same single delta as section 6, from the same applied file (:501-705).

create or replace function public.findback_query_posts_nearby_client(
  p_user_id text default null,
  p_type text default null,
  p_category text default null,
  p_status text default null,
  p_q text default null,
  p_date_from text default null,
  p_date_to text default null,
  p_cursor_created_at text default null,
  p_cursor_id text default null,
  p_order text default 'desc',
  p_limit integer default 10,
  p_near_lat double precision default null,
  p_near_lng double precision default null,
  p_radius_m double precision default null
)
returns table (
  id text,
  user_id text,
  type text,
  title text,
  description text,
  category text,
  status text,
  event_date text,
  latitude double precision,
  longitude double precision,
  location_label text,
  youtube_url text,
  created_at text,
  updated_at text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text,
  like_count bigint,
  dislike_count bigint,
  rating_avg numeric,
  rating_count bigint,
  comment_count bigint,
  attachments jsonb,
  total_count bigint,
  reaction_counts jsonb,
  reaction_total bigint,
  my_reaction text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with filtered as (
    select
      p.*,
      u.username as author_username,
      u.email_verified as author_email_verified,
      u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url,
      u.created_at as author_created_at,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'LIKE') as like_count,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'DISLIKE') as dislike_count,
      (select avg(ra.score) from ratings ra where ra.post_id = p.id) as rating_avg,
      (select count(ra.id) from ratings ra where ra.post_id = p.id) as rating_count,
      (select count(c.id) from comments c where c.post_id = p.id) as comment_count,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'post_id', a.post_id,
            'file_url', a.file_url,
            'mime_type', a.mime_type,
            'file_name', a.file_name,
            'file_size', a.file_size,
            'created_at', a.created_at,
            'display_order', a.display_order,
            'width', a.width,
            'height', a.height
          ) order by a.display_order asc, a.created_at asc, a.id asc
        )
        from attachments a
        where a.post_id = p.id
      ), '[]'::jsonb) as attachments,
      count(*) over() as total_count,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                 count(*) as n
          from public.reactions r
          where r.post_id = p.id
          group by 1
        ) t
      ), '{}'::jsonb) as reaction_counts,
      (select count(r.id) from reactions r where r.post_id = p.id) as reaction_total,
      (select r.type from reactions r
        where r.post_id = p.id and r.user_id = auth.uid()::text
        limit 1) as my_reaction
    from public.findback_visible_posts p
    join users u on u.id = p.user_id
    where
      (p_user_id is null or p.user_id = p_user_id)
      and (p_type is null or p.type = p_type)
      and (p_category is null or p.category = p_category)
      and (p_status is null or p.status = p_status)
      and (
        p_q is null
        or lower(p.title) like '%' || lower(p_q) || '%'
        or lower(p.description) like '%' || lower(p_q) || '%'
      )
      and (p_date_from is null or p.event_date >= p_date_from)
      and (p_date_to is null or p.event_date <= p_date_to)
      -- Only rows with numeric coordinates can be proven nearby; typed-only
      -- posts are excluded from this scope by design.
      and p.latitude is not null
      and p.longitude is not null
      and (
        p_near_lat is null
        or p_near_lng is null
        or p_radius_m is null
        or (
          6371000 * 2 * asin(sqrt(least(1, greatest(0,
            power(sin(radians(p.latitude - p_near_lat) / 2), 2)
            + cos(radians(p_near_lat)) * cos(radians(p.latitude))
              * power(sin(radians(p.longitude - p_near_lng) / 2), 2)
          )))) <= p_radius_m
        )
      )
  )
  select
    id,
    user_id,
    type,
    title,
    description,
    category,
    status,
    event_date,
    latitude,
    longitude,
    location_label,
    youtube_url,
    created_at,
    updated_at,
    author_username,
    author_email_verified,
    author_phone_verified,
    author_avatar_url,
    author_created_at,
    like_count,
    dislike_count,
    rating_avg,
    rating_count,
    comment_count,
    attachments,
    total_count,
    reaction_counts,
    reaction_total,
    my_reaction
  from filtered
  where
    p_cursor_created_at is null
    or (
      p_order = 'asc'
      and (
        created_at > p_cursor_created_at
        or (created_at = p_cursor_created_at and id > coalesce(p_cursor_id, ''))
      )
    )
    or (
      p_order <> 'asc'
      and (
        created_at < p_cursor_created_at
        or (created_at = p_cursor_created_at and id < coalesce(p_cursor_id, ''))
      )
    )
  order by
    (case when p_order = 'asc' then created_at end) asc,
    (case when p_order = 'asc' then id end) asc,
    (case when p_order <> 'asc' then created_at end) desc,
    (case when p_order <> 'asc' then id end) desc
  limit least(greatest(p_limit, 0), 20);
$$;


revoke all on function public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
) from public;

revoke all on function public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
) from anon;

grant execute on function public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
) to authenticated;

comment on function public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
) is 'FindBack nearby feed (authenticated): client feed filters plus Haversine radius scope (p_near_lat, p_near_lng, p_radius_m). Only map-pin rows qualify; total_count is the full proximity-filtered total before the keyset cursor. reaction_counts/reaction_total/my_reaction are the canonical reaction truth (LIKE folded to LOVE); like_count/dislike_count remain as compat. Attachments are display_order-ranked. Never returns author email/phone or distance. Page size clamped to 20.';

-- ===========================================================================
-- 8. public.findback_list_comments_client — O5 block flag (D19 superseded)
-- ===========================================================================
-- Re-created from the frozen M2 revision 2 text
-- (draft-m2/20261017052000_comment_report_reference.sql, the file B1 depends
-- on). The projection, the attachment aggregate and the reaction aggregate are
-- untouched; ONE column is appended and the D19 drop is removed.
--
-- D19 SUPERSEDED BY O5 (§13.8 item 3). D19 dropped a comment whose author was
-- blocked from the caller and promoted its replies to the nearest surviving
-- ancestor. O5 rules that content crossing a blocked pair stays VISIBLE
-- (blurred, tap-to-reveal), so no comment is dropped and there is nothing to
-- promote. The reader therefore returns every comment of the post, with
-- `blocked_author` true on the ones the caller is blocked from — the same
-- caller-scoped, direction-free bit the view projects. The recursive promotion
-- walk (`thread` / `chain` / `visible_chain` / `nearest` / `promoted`) is not
-- shipped; `parent_id` and `depth` come straight from the stored row, which is
-- also what removes the reader's dependence on the
-- `depth == ancestor count` invariant.
--
-- `blocked_author` is appended LAST so every existing positional consumer of
-- the row is unaffected. The function is dropped first because PostgreSQL
-- cannot add an OUT column with `create or replace`; the drop is guarded and
-- the re-create is in the same transaction.
drop function if exists public.findback_list_comments_client(text);

create or replace function public.findback_list_comments_client(p_post_id text)
returns table (
  id text,
  post_id text,
  parent_id text,
  depth integer,
  body text,
  created_at text,
  updated_at text,
  author_id text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text,
  reaction_counts jsonb,
  my_reaction text,
  attachments jsonb,
  blocked_author boolean
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    c.id, c.post_id, c.parent_id, c.depth, c.body, c.created_at, c.updated_at,
    c.user_id as author_id,
    u.username as author_username,
    u.email_verified as author_email_verified,
    u.phone_verified as author_phone_verified,
    u.avatar_url as author_avatar_url,
    u.created_at as author_created_at,
    coalesce((
      select jsonb_object_agg(t.kind, t.n)
      from (
        select case when cr.type = 'LIKE' then 'LOVE' else cr.type end as kind,
               count(*) as n
        from public.comment_reactions cr
        where cr.comment_id = c.id
        group by 1
      ) t
    ), '{}'::jsonb) as reaction_counts,
    (select cr2.type from public.comment_reactions cr2
      where cr2.id = md5('comment_reaction|' || c.id || '|' || (select auth.uid())::text))
      as my_reaction,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'kind', a.kind,
          'provider', a.provider,
          'display_order', a.display_order,
          'report_post_id', a.report_post_id,
          'remote_url', a.remote_url,
          'preview_url', a.preview_url,
          'mime_type', a.mime_type,
          'file_name', a.file_name,
          'file_size', a.file_size,
          'width', a.width,
          'height', a.height,
          'created_at', a.created_at
        ) order by a.display_order asc, a.created_at asc, a.id asc
      )
      from public.comment_attachments a
      where a.comment_id = c.id
    ), '[]'::jsonb) as attachments,
    -- O5: the caller-scoped, direction-free block bit. Never a row filter, and
    -- never about a pair the caller is not part of.
    public.findback_is_blocked_with_me(c.user_id) as blocked_author
  from public.comments c
  join public.users u on u.id = c.user_id
  where c.post_id = p_post_id
  order by c.created_at asc
  limit 500;
$$;

revoke all on function public.findback_list_comments_client(text) from public, anon;
grant execute on function public.findback_list_comments_client(text) to authenticated;

comment on function public.findback_list_comments_client(text)
  is 'FindBack comment list (authenticated): public comment tree + author projection + per-comment per-kind reaction_counts and caller my_reaction + display_order-ranked attachments (public-safe fields only; never user_id or storage_path; report_post_id is the content-free pointer of a report reference and is NULL for every other kind). Never returns reaction user ids. blocked_author is the O5 signal: true when the caller is blocked with the author (caller-scoped, direction-free); the row is returned either way, never dropped.';

-- ===========================================================================
-- 9. public.findback_notify_comment — D21 suppression guards
-- ===========================================================================
-- Re-created from 20260203 (20261002030000_nested_comments.sql:150-223) with
-- the SAME structure, the same three notification targets and the same copy;
-- only the two D21 guards are added before each findback_insert_notification.
-- Suppressing in the trigger and not only in the reader is deliberate (D21):
-- the push path is not a reader, and a row a recipient may no longer see must
-- never be delivered.
--
-- The guard is the D9 predicate instantiated at the RECIPIENT, conjoined with
-- the D17 block term between recipient and ACTOR. See REFERENCE-TEXT RECURRENCE
-- in the header for why the atoms are repeated here, and the parity block for
-- the equality proof.

create or replace function public.findback_notify_comment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text;
  v_title text;
  v_handle text;
  v_mentioned_id text;
  v_parent_author text;
  v_seen text[] := '{}';
  v_post_visible boolean;
begin
  -- D21 guard 2 reads the D9 view's own atoms for the RECIPIENT, who is not
  -- the caller: a security_invoker view cannot answer for a third party. This
  -- is the single recurrence of D9's predicate in the chain, and the parity
  -- block proves the guard expression below equal to the view's WHERE text
  -- with the viewer substituted and this boolean standing in for the
  -- moderation atom. coalesce(..., false) keeps a post-less row (impossible
  -- while the comments FK cascades, kept as a fence) from evaluating to NULL.
  select p.user_id,
         p.title,
         coalesce(p.moderation_visibility = 'PUBLISHED', false)
    into v_owner, v_title, v_post_visible
  from public.item_posts p
  where p.id = new.post_id;

  if v_owner is not null and v_owner <> new.user_id
     and not public.findback_is_blocked_pair(v_owner, new.user_id) then
    perform public.findback_insert_notification(
      v_owner, new.user_id, 'COMMENT', new.post_id, new.id, new.body
    );
  end if;

  if new.parent_id is not null then
    select c.user_id into v_parent_author
    from public.comments c
    where c.id = new.parent_id;
    if v_parent_author is not null
       and v_parent_author <> new.user_id
       and v_parent_author is distinct from v_owner
       and not public.findback_is_blocked_pair(v_parent_author, new.user_id)
       and ( v_owner = v_parent_author
             or ( v_post_visible
                  and not public.findback_is_blocked_pair(v_parent_author, v_owner) ) ) then
      perform public.findback_insert_notification(
        v_parent_author, new.user_id, 'COMMENT', new.post_id, new.id, new.body
      );
    end if;
  end if;

  for v_handle in
    select distinct m[1]
    from regexp_matches(new.body, '@([A-Za-z0-9_]{1,30})', 'g') as m
  loop
    if v_handle = any (v_seen) then
      continue;
    end if;
    v_seen := v_seen || v_handle;
    select u.id into v_mentioned_id
    from public.users u
    where lower(u.username) = lower(v_handle);
    if v_mentioned_id is null then
      continue;
    end if;
    if v_mentioned_id = new.user_id
       or v_mentioned_id = v_owner
       or v_mentioned_id is not distinct from v_parent_author then
      continue;
    end if;
    if public.findback_is_blocked_pair(v_mentioned_id, new.user_id) then
      continue;
    end if;
    if not ( v_owner = v_mentioned_id
             or ( v_post_visible
                  and not public.findback_is_blocked_pair(v_mentioned_id, v_owner) ) ) then
      continue;
    end if;
    if exists (
      select 1 from public.notifications n
      where n.user_id = v_mentioned_id
        and n.comment_id = new.id
        and n.type = 'MENTION'
    ) then
      continue;
    end if;
    perform public.findback_insert_notification(
      v_mentioned_id, new.user_id, 'MENTION', new.post_id, new.id, new.body
    );
  end loop;

  return new;
end;
$$;

revoke all on function public.findback_notify_comment() from public, anon, authenticated;

-- ===========================================================================
-- 10. public.findback_list_notifications_client — D21 reader filter + O5 flag
-- ===========================================================================
-- Re-created from 20261011000000_reaction_notification_feed.sql:180-231 with
-- its signature and p_deleted contract unchanged; ONE OUT column is appended.
--
-- The MODERATION half of D21 stays exactly as designed: a stored-then-hidden row
-- remains in storage and stops being rendered, because the target post is no
-- longer in the D9 view for this caller (absent == inaccessible).
--
-- The BLOCK half of D21 is superseded by O5, for the same reason as the comment
-- reader: a notification is a pointer to content the caller can still see
-- (blurred), so hiding it would be the "empty result" collapse O5 retires for
-- the block direction. The caller-scoped, direction-free bit is surfaced as
-- `blocked_actor` instead. What PREVENTS the interaction is unchanged and
-- unaffected by this line: the D21 guards in findback_notify_comment() mean a
-- notification is never DELIVERED across a block in the first place.

drop function if exists public.findback_list_notifications_client(boolean);

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
      -- D21 (moderation half, unchanged): a stored-then-hidden row is fine in
      -- storage, never in the inbox. Every row the chain can write carries a
      -- real post_id — the STATUS trigger stores the status post's own id and
      -- the FK cascades — so the null arm below is unreachable through the
      -- chain and is kept as a FENCE, not as STATUS handling (round-4 review
      -- MINOR-2: the previous comment claimed STATUS rows have a null post FK,
      -- which is measurably false). B1-28 pins the fence's behaviour: a
      -- post-less row is KEPT rather than dropped silently.
      and (
        n.post_id is null
        or exists (
          select 1 from public.findback_visible_posts v where v.id = n.post_id
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

comment on function public.findback_list_notifications_client(boolean)
  is 'FindBack notification inbox (authenticated): caller-owned rows newest first; p_deleted selects the soft-deleted view. REACTION rows carry the canonical kind in reaction_kind (null on legacy rows). Max 100. blocked_actor is the O5 signal: true when the caller is blocked with the row''s actor (caller-scoped, direction-free); the row is returned either way. Moderation still collapses: a row whose target post is no longer in the caller''s view is not rendered.';

-- ===========================================================================
-- Execution status (see EVIDENCE-B1-R3-AUTHOR.md for the measured record)
-- ===========================================================================
-- Owner probes: supabase/tests/verify_20261017070000_visibility_kernel_and_blocks.sql
--   section 1 catalog probes (executed locally, 1 row each) and section 2
--   behavioural probes (executed locally with `set role authenticated` + a JWT
--   `sub` claim).
-- EXECUTED LOCALLY on PostgreSQL 17.5 with this migration applied over the
-- full 60-file chain (61/61 applied, 0 failed): the D10 audience matrix row by
-- row; O5 — a blocked author's PUBLISHED report is RETURNED (not filtered) and
-- flagged; a third party's read is unchanged and unflagged; the moderation
-- collapse (HIDDEN indistinguishable from absent); B''s findback_my_blocks() is
-- empty and a direct SELECT on user_blocks raises 42501; an owner UPDATE of
-- moderation_visibility on their own row FAILS; a reply notification across a
-- block is not inserted. Every section-1 probe has a negative control that
-- makes it go EMPTY under a targeted mutation.
-- STILL OWNER-ONLY: the run against the hosted project (PostgreSQL version
-- parity of the deparse output), and the client-side blur/reveal surface, which
-- has no rendered review anywhere yet.
--
-- LIVE-PENDING. Reported as pending, never as passed.
