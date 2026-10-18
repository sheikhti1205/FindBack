-- Live verification for 20261017070000_visibility_kernel_and_blocks.sql.
--
-- STATUS OF THIS FILE. Section 1's catalog probes HAVE BEEN EXECUTED, and the
-- behavioural matrix behind Section 2 has been executed too. Both runs are on
-- PostgreSQL 17.5: the real supabase/migrations chain plus this migration,
-- applied to a disposable local cluster by sessions/trust-backend/harness/
-- chain.mjs (`--extra <draft-b1>`), with the behaviour driving the same cluster
-- through `set role authenticated` and
-- `set_config('request.jwt.claim.sub', <uid>, false)`. MEASURED TALLIES, the
-- exact commands and the mutation controls are in EVIDENCE-B1-R3-AUTHOR.md and
-- EVIDENCE-B1-R4-AUTHOR.md.
--
-- Section 2 below is the OWNER-RUN SHEET, not executable SQL: it states the
-- expectations the owner checks on a disposable backend. The executable form of
-- the same matrix is `probes/block-matrix-local.sql` (55 labelled rows, run on
-- the local chain), and its controls are
-- `block-matrix-negative-controls.mjs` (base 55/55; every one of the three
-- privacy mutations blinds its probe and exits 1). Reading this file as if its
-- own statements were runnable would be a category error; the executed artifact
-- is the probe file. Every expectation below except the FOUR marked
-- "[UNRUN HERE]" has been measured locally — the three live fixtures (M13, M15,
-- M17) plus the live-backend inertness probe. Those four cannot be measured by a
-- local apply, and the reason is stated at each one. Nothing here ran against
-- any hosted project, and no probe in Section 1 writes anything.
--
-- Section 1 is read-only catalog probes (database owner session, e.g. the
-- Supabase dashboard SQL editor): every probe selects a row when the invariant
-- holds, and returns no row when it does not. Section 2 is the behavioural
-- matrix that needs a write, so on a real backend it belongs on a DISPOSABLE
-- test project under the supabase/tests/run-live.sh conventions
-- (TEST_SUPABASE_URL, TEST_SUPABASE_PUBLISHABLE_KEY, TEST_USER_A_JWT,
-- TEST_USER_B_JWT); it never goes near production. Values are never printed.
--
-- What this migration adds (CF-060 B1): the ONE object that decides
-- ordinary-viewer post visibility (public.findback_visible_posts, a
-- security_invoker view over public.item_posts), the block table
-- (public.user_blocks), the two-function block predicate
-- (public.findback_is_blocked_pair(text,text), INTERNAL, and
-- public.findback_is_blocked_with_me(text), the client surface), the additive
-- moderation column (public.item_posts.moderation_visibility, default
-- PUBLISHED, no writer), the owner-scoped block reader
-- (public.findback_my_blocks), the re-created readers that must read the view
-- (feed, nearby) and enforce D21's suppression (the notify trigger and the
-- inbox reader's moderation term), and — per §13.8 item 3, ruling O5 — the
-- SURFACED block bit on the view and on both client readers. O5 supersedes
-- D19: nothing is dropped for a block, so the reply "promotion" walk is not
-- shipped and the stored parent_id/depth are returned as stored.
--
-- Layer 1 (supabase/tests/migration_parity.test.mjs + draft-b1/parity-block.mjs)
-- and layer 1b (draft-b1/inertness-selfcheck.mjs) are the pre-apply runs;
-- draft-b1/EVIDENCE-B1-R3-AUTHOR.md reports all of them, with numbers.
--
-- DEPARSED-EXPRESSION NOTE: pg_policies.qual / with_check, pg_get_constraintdef,
-- pg_get_viewdef, pg_get_function_result and pg_proc.prosrc are rendered by the
-- engine (keywords upper-cased, `auth.uid()` as `( SELECT auth.uid() AS uid)`),
-- so every expression probe below compares the whitespace-stripped lower-cased
-- form via regexp_replace(lower(<expr>), '\s', '', 'g'). The exact source text
-- of the view WHERE and of the trigger guard is pinned by the layer-1 parity
-- block, not here.

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes. EXPECT: 1 row each.
-- ---------------------------------------------------------------------------

-- P1. The block table exists with the authored shape: a two-column primary key
-- (one row per directional act) and a self-block CHECK written inline in the
-- CREATE TABLE (never a separate, unguarded ADD CONSTRAINT).
select 'P1 user_blocks shape' as probe
where exists (
  select 1 from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'user_blocks' and c.relkind = 'r'
)
and exists (
  select 1 from pg_constraint
  where conrelid = 'public.user_blocks'::regclass and contype = 'p'
    and conname = 'user_blocks_pkey'
    and regexp_replace(lower(array_to_string(conkey, ',')), '\s', '', 'g') <> ''
)
and exists (
  select 1 from pg_constraint
  where conrelid = 'public.user_blocks'::regclass and contype = 'c'
    and conname = 'user_blocks_self_check'
    and regexp_replace(lower(pg_get_constraintdef(oid)), '\s', '', 'g')
        like '%blocker_user_id<>blocked_user_id%'
);

-- P2. Both ends of a block CASCADE: a block to or from a deleted account is
-- meaningless, and an account deletion must never be blocked by one.
select 'P2 both block FKs cascade' as probe
where (
  select count(*) from pg_constraint
  where conrelid = 'public.user_blocks'::regclass and contype = 'f'
    and confrelid = 'public.users'::regclass and confdeltype = 'c'
) = 2;

-- P3. D18: the table is granted to NOBODY. RLS is enabled, there are ZERO
-- policies, and neither authenticated nor anon holds any table privilege.
-- Supabase's default ACL grants authenticated rights on every new table, so the
-- explicit revoke is what makes "no policy" mean "no access" (fact #14).
select 'P3 user_blocks unreadable' as probe
where (select relrowsecurity from pg_class where oid = 'public.user_blocks'::regclass)
  and (
    select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'user_blocks'
  ) = 0
  and not has_table_privilege('authenticated', 'public.user_blocks', 'SELECT')
  and not has_table_privilege('authenticated', 'public.user_blocks', 'INSERT')
  and not has_table_privilege('authenticated', 'public.user_blocks', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.user_blocks', 'DELETE')
  and not has_any_column_privilege('authenticated', 'public.user_blocks', 'SELECT')
  and not has_table_privilege('anon', 'public.user_blocks', 'SELECT')
  and not has_table_privilege('anon', 'public.user_blocks', 'INSERT')
  and not has_table_privilege('anon', 'public.user_blocks', 'UPDATE')
  and not has_table_privilege('anon', 'public.user_blocks', 'DELETE')
  and not has_any_column_privilege('anon', 'public.user_blocks', 'SELECT');

-- P4. The predicate is TWO functions with a deliberate privilege split.
--   * public.findback_is_blocked_pair(p_a text, p_b text) is the pair oracle:
--     boolean-returning, stable, definer SQL with a locked search_path whose
--     body ORs the two directions. It is INTERNAL: revoked from public, anon
--     and authenticated and granted to nobody, so only the definer context of
--     the readers (and findback_is_blocked_with_me, below) can reach it. This
--     is what closes the MAJOR-1 oracle: a signed-in caller can no longer ask
--     "is X blocked from Y" for two strangers.
--   * public.findback_is_blocked_with_me(p_other text) is the client surface:
--     definer, stable, locked search_path, forwarding auth.uid() and p_other
--     to the pair oracle. A row-returning helper (fixture M5) would let a
--     caller enumerate who blocked whom, which D18 forbids, so both return
--     types are part of the contract.
select 'P4 block predicate shapes' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_is_blocked_pair'
    and p.pronargs = 2
    and p.prorettype = 'boolean'::regtype
    and p.provolatile = 's'
    and p.prosecdef = true
    and regexp_replace(lower(coalesce(array_to_string(p.proconfig, ','), '')), '\s', '', 'g')
        like '%search_path=public,pg_temp%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%b.blocker_user_id=p_aandb.blocked_user_id=p_b%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%b.blocker_user_id=p_bandb.blocked_user_id=p_a%'
)
and exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_is_blocked_with_me'
    and p.pronargs = 1
    and p.prorettype = 'boolean'::regtype
    and p.provolatile = 's'
    and p.prosecdef = true
    and regexp_replace(lower(coalesce(array_to_string(p.proconfig, ','), '')), '\s', '', 'g')
        like '%search_path=public,pg_temp%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%findback_is_blocked_pair(auth.uid()::text,p_other)%'
);

-- P5. The moderation column is additive and inert: present, NOT NULL, with the
-- PUBLISHED default applied by the catalog (no rewrite, no backfill).
select 'P5 moderation column additive' as probe
where exists (
  select 1 from pg_attribute a
  join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = 'public.item_posts'::regclass
    and a.attname = 'moderation_visibility'
    and a.attnotnull
    and regexp_replace(lower(pg_get_expr(d.adbin, d.adrelid)), '\s', '', 'g') = '''published''::text'
);

-- P6. The vocabulary CHECK admits exactly the four moderation states (and was
-- replaced, not duplicated: one constraint of that name).
select 'P6 moderation vocabulary check' as probe
where (
  select count(*) from pg_constraint
  where conrelid = 'public.item_posts'::regclass
    and conname = 'item_posts_moderation_visibility_check'
    and regexp_replace(lower(pg_get_constraintdef(oid)), '\s', '', 'g')
        like '%moderation_visibility=any(array[''published''::text,''pending_review''::text,''hidden''::text,''removed''::text])%'
) = 1;

-- P7. THE SINGLE PREDICATE, PLUS O5. findback_visible_posts is an ordinary view
-- (not a matview) carrying security_invoker. Its WHERE is exactly two
-- disjuncts: the owner clause and the moderation atom. Per §13.8 item 3 (O5) it
-- carries NO block term — a blocked author's PUBLISHED content must be
-- RETURNED, not filtered, and the block is SURFACED as a projected column
-- instead. That column is the caller-scoped one-argument surface
-- (findback_is_blocked_with_me), never the two-argument internal oracle. The
-- exact source expression is pinned by the layer-1 parity block; this is the
-- live form. It refuses an added `true` disjunct (fixture M1), a re-introduced
-- block filter (fixture M2, re-pointed by O5), a dropped flag, and the pair
-- oracle.
select 'P7 view is the single predicate, with the block surfaced not filtered' as probe
where exists (
  select 1 from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'findback_visible_posts'
    and c.relkind = 'v'
    and regexp_replace(lower(coalesce(array_to_string(c.reloptions, ','), '')), '\s', '', 'g')
        like '%security_invoker=true%'
)
and (
  select
    regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
  like '%user_id=((selectauth.uid()asuid))::text%'
  and regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
      like '%moderation_visibility=''published''::text%'
  and regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
      like '%findback_is_blocked_with_me(user_id)asblocked_author%'
  and regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
      not like '%where%findback_is_blocked%'
  and regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
      not like '%findback_is_blocked_pair%'
  and regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
      not like '%true%'
  and regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
      not like '%1=1%'
);

-- P8. ACL of the view and the required column privilege. authenticated holds
-- SELECT on the view; anon holds none. authenticated also holds SELECT on
-- public.item_posts(moderation_visibility) — REQUIRED, because a
-- security_invoker view whose body names a column is refused (42501) for a
-- caller without that column privilege, so without this line both feed readers
-- fail. anon holds neither. The residual this column grant creates against the
-- table's `using (true)` SELECT policy is an owner decision (README.md).
select 'P8 view ACL and column privilege' as probe
where has_table_privilege('authenticated', 'public.findback_visible_posts', 'SELECT')
  and not has_table_privilege('anon', 'public.findback_visible_posts', 'SELECT')
  and has_column_privilege('authenticated', 'public.item_posts', 'moderation_visibility', 'SELECT')
  and not has_column_privilege('anon', 'public.item_posts', 'moderation_visibility', 'SELECT');

-- P9. findback_my_blocks exposes exactly the caller's own outgoing rows: two
-- output columns, no inverse, plpgsql, stable, definer, locked search_path.
-- (The direction and the actor are unknowable from the client.)
select 'P9 my_blocks is caller-scoped' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_my_blocks'
    and p.pronargs = 0
    and p.proretset = true
    and p.provolatile = 's'
    and p.prosecdef = true
    and regexp_replace(lower(pg_get_function_result(p.oid)), '\s', '', 'g')
        = 'table(blocked_user_idtext,created_attext)'
    and regexp_replace(lower(coalesce(array_to_string(p.proconfig, ','), '')), '\s', '', 'g')
        like '%search_path=public,pg_temp%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%whereb.blocker_user_id=v_uid%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%orderbyb.created_atdesc,b.blocked_user_idasc%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') not like '%blocked_user_id=v_uid%'
);

-- P10. THE PREDICATE EXISTS ONCE, LIVE. No re-created reader names the
-- moderation atom, the block table, or the two-argument internal oracle in its
-- own executable body: the readers inherit row visibility from the view, and
-- the O5 block bit is obtained only through the caller-scoped
-- findback_is_blocked_with_me surface. SQL comment lines are stripped first,
-- because a comment that mentions `user_blocks` is prose, not a second
-- predicate. (The notify trigger is deliberately NOT in this list: it answers
-- for a third-party recipient, so §13.8 item 4 binds it to the internal pair
-- form — P14 pins that instead.)
select 'P10 readers carry no second predicate' as probe
where (
  select count(*) from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'findback_query_posts_client',
      'findback_query_posts_nearby_client',
      'findback_list_comments_client',
      'findback_list_notifications_client'
    )
    and (
      regexp_replace(regexp_replace(lower(p.prosrc), '--[^\n]*', '', 'g'), '\s', '', 'g')
          like '%moderation_visibility%'
      or regexp_replace(regexp_replace(lower(p.prosrc), '--[^\n]*', '', 'g'), '\s', '', 'g')
          like '%user_blocks%'
      or regexp_replace(regexp_replace(lower(p.prosrc), '--[^\n]*', '', 'g'), '\s', '', 'g')
          like '%findback_is_blocked_pair%'
    )
) = 0;

-- P11. The readers read the view (feed, nearby, inbox) and the comments table
-- (comments list). query_posts/nearby stay invoker; the inbox stays the
-- caller-scoped definer; the comment reader stays an invoker. The comments
-- reader carries the O5 flag and NO promotion walk (no `with recursive`, no
-- `promoted` source) — D19 is superseded — and the inbox carries the O5 flag
-- about the actor and NO block filter, only its D21 moderation term.
select 'P11 readers read the view, comments read the table, with the O5 flags' as probe
where (
  select count(*) from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef = false
    and p.proname in ('findback_query_posts_client', 'findback_query_posts_nearby_client')
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') like '%frompublic.findback_visible_postsp%'
) = 2
and exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef = false
    and p.proname = 'findback_list_comments_client'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') like '%frompublic.commentsc%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%public.findback_is_blocked_with_me(c.user_id)asblocked_author%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') not like '%andnotpublic.findback_is_blocked%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') not like '%withrecursive%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') not like '%promotedc%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') not like '%findback_is_blocked_pair%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') not like '%storage_path%'
)
and exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef = true
    and p.proname = 'findback_list_notifications_client'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%frompublic.findback_visible_postsvwherev.id=n.post_id%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%public.findback_is_blocked_with_me(n.actor_id)asblocked_actor%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') not like '%andnotpublic.findback_is_blocked%'
);

-- P12. EXECUTE: authenticated holds it on the self-subject predicate, the
-- owner-scoped reader and the three client readers; anon holds none of them.
-- The INTERNAL pair oracle is executable by NOBODY but the definer context:
-- authenticated and anon are both refused, so the MAJOR-1 oracle is closed at
-- the privilege layer as well as by the absence of an RPC surface. The notify
-- trigger is reachable by nobody.
select 'P12 execute grants' as probe
where has_function_privilege('authenticated', 'public.findback_is_blocked_with_me(text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.findback_my_blocks()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.findback_list_comments_client(text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.findback_list_notifications_client(boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.findback_is_blocked_with_me(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.findback_my_blocks()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.findback_is_blocked_pair(text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.findback_is_blocked_pair(text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.findback_notify_comment()', 'EXECUTE');

-- P13. M4, live: nobody can write the moderation state. No column-level UPDATE
-- privilege names moderation_visibility for any grantee other than the table
-- owner (the owner's implicit UPDATE is not a grantee grant, so it is excluded
-- by grantee <> current_user; if the apply were run from another role, the
-- explicit role checks below still hold). The owner-writable post-update grant
-- must not have carried the column along, and the column keeps its PUBLISHED
-- default so a write that DID slip through could not clear moderation silently.
select 'P13 no UPDATE on moderation_visibility' as probe
where not exists (
  select 1 from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'item_posts'
    and column_name = 'moderation_visibility' and privilege_type = 'UPDATE'
    and grantee <> current_user
)
and not has_column_privilege('authenticated', 'public.item_posts', 'moderation_visibility', 'UPDATE')
and not has_column_privilege('anon', 'public.item_posts', 'moderation_visibility', 'UPDATE');

-- P14. The notify trigger keeps its definer shape and waits only on the D21
-- guards; it reads the moderation atom ONCE into a boolean, calls the INTERNAL
-- pair oracle with the RECIPIENT first (the caller is not the recipient here,
-- which is exactly why the self-subject surface cannot be used in the trigger)
-- and never writes the column itself. All THREE D21 branches are pinned by
-- identity: the owner branch refuses on (owner, actor), the reply branch on
-- (parent author, actor) AND on (parent author, owner) for the post-visibility
-- conjunct, and the mention branch on (mentioned, actor). After O5 the trigger's
-- guard is NO LONGER textually equal to the view's WHERE — §13.8 item 4 keeps
-- D21's interaction refusal while O5 removed the view's block term — so the
-- equality the parity block proves is the MODERATION atom plus the view's
-- predicate with the interaction term stripped, and these four literals pin the
-- interaction term that is deliberately still there.
select 'P14 notify trigger D21 guards' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_notify_comment'
    and p.prosecdef = true
    and regexp_replace(lower(coalesce(array_to_string(p.proconfig, ','), '')), '\s', '', 'g')
        like '%search_path=public,pg_temp%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') like '%v_post_visibleboolean%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%coalesce(p.moderation_visibility=''published'',false)%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%intov_owner,v_title,v_post_visible%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%v_post_visibleandnotpublic.findback_is_blocked_pair(v_parent_author,v_owner)%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%notpublic.findback_is_blocked_pair(v_owner,new.user_id)%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%andnotpublic.findback_is_blocked_pair(v_parent_author,new.user_id)%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%findback_is_blocked_pair(v_mentioned_id,new.user_id)%'
);

-- P15. O5, LIVE: the block bit is SURFACED on every surface that renders
-- content, and it is the caller-scoped surface everywhere. The view projects
-- `blocked_author`; the comment reader projects `blocked_author`; the inbox
-- reader projects `blocked_actor`. The internal pair oracle appears in NONE of
-- them (P7/P10/P11 pin that). Each reader's new column is its LAST OUT column,
-- so a positional consumer is unaffected; the view's flag sits after `p.*`, so
-- it is likewise appended. A dropped flag, an inverted bit and a flag about the
-- wrong party are all caught by the layer-1 parity block (fixtures B1-X6,
-- B1-X18, B1-X19); this probe is the live shape.
select 'P15 O5 block bit surfaced on the view and both client readers' as probe
where regexp_replace(lower(pg_get_viewdef('public.findback_visible_posts'::regclass)), '\s', '', 'g')
        like '%findback_is_blocked_with_me(user_id)asblocked_author%'
  and exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'findback_list_comments_client'
      and regexp_replace(lower(pg_get_function_result(p.oid)), '\s', '', 'g')
          like '%attachmentsjsonb,blocked_authorboolean%'
  )
  and exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'findback_list_notifications_client'
      and regexp_replace(lower(pg_get_function_result(p.oid)), '\s', '', 'g')
          like '%reaction_kindtext,blocked_actorboolean%'
  );

-- P16. DATA HEALTH, not a B1 dependency. `comments.depth == number of
-- ancestors` was the invariant the (now-superseded) D19 promotion rested on; B1
-- no longer recomputes anything, so this probe is no longer a precondition of
-- any B1 behaviour. It is kept because the invariant is the tree's contract with
-- the client, and a violation is a finding either way: a broken writer or a
-- pre-existing bad row. This is the read-only check on the live table: EXPECT 1
-- row when no row violates it. (Layer 1b asserts it on its fixture too.)
with recursive anc as (
  select c.id as leaf, c.parent_id as node, 0 as level
  from public.comments c
  union all
  select a.leaf, p.parent_id, a.level + 1
  from anc a
  join public.comments p on p.id = a.node
  where a.level < 100
)
select 'P16 depth equals ancestor count' as probe
where not exists (
  select 1
  from public.comments c
  left join (
    select leaf, count(*) as n from anc where level > 0 group by leaf
  ) d on d.leaf = c.id
  where c.depth is distinct from coalesce(d.n, 0)
);

-- P17. No data was written by the migration itself: user_blocks is empty and
-- every item_posts row is PUBLISHED immediately after the apply. Run this ONCE,
-- right after the apply; a later run may legitimately see rows written by real
-- use — that is not a failure.
select 'P17 no data written by the migration' as probe
where (select count(*) from public.user_blocks) = 0
  and (select count(*) from public.item_posts where moderation_visibility <> 'PUBLISHED') = 0;

-- ---------------------------------------------------------------------------
-- 2. Behavioural matrix (executed locally; on a real backend: disposable only,
--    run-live.sh env).
-- ---------------------------------------------------------------------------
-- Setup: users A, B and C, each with one PUBLISHED report (P_A, P_B, P_C).
-- SCRATCH is the post the thread probes hang comments off. Every curl on a real
-- backend runs with the run-live.sh env contract and never prints a token. A
-- block row is written ONLY through the app's block action (the client cannot
-- insert one directly — P3 proves it holds no privilege).
--
-- EXECUTED LOCALLY. Every item below except (h-m), (j), (k) and (m) was run on
-- the disposable local cluster described in the header, with the readers called
-- under `set role authenticated` plus
-- `set_config('request.jwt.claim.sub', <uid>, false)`. The measured rows are in
-- EVIDENCE-B1-R3-AUTHOR.md §5, EVIDENCE-B1-R4-AUTHOR.md §3 and
-- EVIDENCE-B1-R5-AUTHOR.md §2. The four exceptions say why they cannot be run
-- here; three of them are mutations, not applies. (h)'s APPLY half IS run — the
-- exception is (h-m), its mutation half; round-4 review MINOR-3.
--
-- (a) THE D10 AUDIENCE MATRIX, WITH O5. With A holding a block row acting on B
--   (blocker = A, blocked = B), and a HIDDEN post P_C authored by C:
--   * as A, findback_query_posts_client() -> P_A (own), P_B (blocked author, but
--     PUBLISHED and therefore RETURNED — O5), P_C absent (HIDDEN);
--   * as B, the same call -> P_B (own), P_A (published, returned, O5), P_C
--     absent (HIDDEN);
--   * as C (a stranger to the block), -> P_A, P_B AND C's OWN P_C all present:
--     the owner clause returns the author's own rows in every moderation state,
--     so P_C is present for C and absent for A and B. That asymmetry IS the
--     design; it is not a leak of anyone else's row.
--   EXPECT: exactly that, row for row. A single missing/extra row is the failure
--   mode (an `or true` in the view shows every HIDDEN post to B; a dropped owner
--   clause hides A's own row from A; a re-introduced block filter hides P_B from
--   A and P_A from B, which is exactly the O5 defect). The block bit rides on the
--   view's `blocked_author` column: true for the other party's rows, false for a
--   stranger's.
--
-- (b) DIRECT-BY-ID INDISTINGUISHABILITY (P1/D11). As B, fetch P_C (HIDDEN,
--   authored by C) by id through the feed reader with p_post_id = P_C.
--   EXPECT: the same empty result as an id that never existed — no row, and no
--   distinguishable error. The client maps both to "Post not found". O5 does not
--   weaken this: the P_C row is removed by the MODERATION atom, and no block bit
--   can bring it back.
--
-- (c) BLOCK SYMMETRY (D12/D17), AND THE SAME SESSION CANNOT DERIVE DIRECTION.
--   * As A: findback_my_blocks() returns exactly B's user id (one row).
--   * As B: findback_my_blocks() returns NO row for A — B's list never names A,
--     so B cannot learn A blocked them.
--   * A direct GET /rest/v1/user_blocks as B -> non-2xx (42501): no privilege,
--     no policy.
--   * As A: findback_is_blocked_with_me(B) is true; as B:
--     findback_is_blocked_with_me(A) is also true (the effect is mutual), yet
--     only one row exists in the table. The two-argument pair form
--     (findback_is_blocked_pair) is not reachable by a client at all: it is
--     revoked from public/anon/authenticated (P12), so the MAJOR-1 oracle is
--     closed and direction stays unanswerable from a signed-in session.
--   EXPECT: one outgoing row for A, none for B, 42501 for the direct read, and
--   both self-subject calls true — the effect is symmetric while the act is
--   evidence of one direction only.
--
-- (d) UNBLOCK (D22, both directions). Remove the block row for the pair; then
--   findback_is_blocked_with_me(B) is false for A and
--   findback_is_blocked_with_me(A) is false for B, and (a) restores to the
--   no-block matrix (every PUBLISHED row returned, every flag false). EXPECT: a
--   per-direction delete is sufficient because the predicate asks both
--   directions.
--
-- (e) THE COMMENT READER UNDER O5 (this replaces the D19 promotion probe). Build
--   a thread on SCRATCH: comment c1 by C, reply c2 by C (parent c1, depth 1),
--   reply c3 by A (parent c2, depth 2). A blocks C and calls
--   findback_list_comments_client(SCRATCH).
--   EXPECT: c1, c2 AND c3 all returned, in stored order, with their STORED
--   parent_id and depth (c1 -> null/0, c2 -> c1/1, c3 -> c2/2) and
--   blocked_author true on C's two rows and false on A's. Nothing is dropped, so
--   nothing is promoted: a reply is never re-parented and a depth is never
--   recomputed. The client blurs rather than deletes.
--   (f) NEGATIVE HALF OF (e): as C, the same call returns the same three rows
--   with the flag on A's row instead — the bit is caller-scoped. As a third
--   party (D), all three rows come back with every flag false.
--
-- (g) INBOX, MODERATION HALF (D21) AND O5 BLOCK HALF. As B, with a stored
--   COMMENT notification on P_A authored by A: A blocks B, then B calls
--   findback_list_notifications_client(false).
--   EXPECT: the row is RETURNED (storage is untouched and O5 does not filter on
--   a block) with blocked_actor = true, and the actor's id is not otherwise
--   disclosed by the flag. Separately, set P_A to HIDDEN and re-call: now the
--   row IS absent — that is the MODERATION half, which stays. The two halves are
--   distinguishable by which one moves the row. Repeat the moderation half in
--   ALL THREE non-PUBLISHED states (HIDDEN, PENDING_REVIEW, REMOVED), per item
--   (o). Measured locally for all three: B1-25, B1-25b, B1-25d.
--
-- (h) NOTIFICATION SUPPRESSION, TRIGGER HALF — OWNER BRANCH (D21, §13.8 item 4).
--   A blocks C; C comments on A's post P_A. EXPECT: no COMMENT notification row
--   is inserted for A. Measured locally for the owner branch: B1-15 (suppressed)
--   and B1-16 (the positive control, which delivers when no block applies) —
--   see §5 of the R3 evidence.
--   (h-m) [UNRUN HERE] THE MUTATION HALF of (h): fixture M15 form — "the
--   trigger's block guard is removed" — is meaningful only against a mutated
--   apply, because the killing observation is that the cross-block notification
--   IS inserted when the guard is gone. The owner and mention branches are
--   covered at layer 2 by block-matrix-negative-controls.mjs; a mutation of the
--   owner branch is not in that set.
--
-- (h2) NOTIFICATION SUPPRESSION, TRIGGER HALF — REPLY BRANCH (D21). A parent
--   comment by C on a post owned by a third party (B, or D's own post), and a
--   reply to it by a third party (D, or A):
--   EXPECT, on the positive case (D replies to C on B's post P_B): exactly TWO
--   rows are stored for that comment — B via the OWNER branch and C via the
--   REPLY branch — with the responder (D) as actor on both, and no third party
--   a recipient. EXPECT, on the suppression case (A replies to C on D's post
--   P_D, where A blocks C but not D): exactly ONE row, D's own, and NOTHING for
--   C — the reply branch's (parent author, actor) pair guard is what suppresses
--   it, since the owner branch still delivers and C and D are not a blocked
--   pair. EXPECT, on the no-duplicate case (D replies to a comment authored by
--   the owner B): exactly ONE row for B, never two. Measured locally: B1-19f,
--   B1-19e, B1-19a, B1-19b, B1-19i, B1-19h, B1-19c, B1-19d, B1-19g.
--   THE MUTATION HALF IS RUN, at layer 2, by
--   block-matrix-negative-controls.mjs: mut-reply-pair-guard (goes blind on
--   B1-19c), mut-reply-recipient and mut-reply-actor (B1-19a),
--   mut-reply-extra-copy — an unrelated third party receiving the comment body,
--   i.e. a real disclosure (B1-19b), and mut-reply-duplicates-owner (B1-19d).
--   Round-4 review MAJOR-1: before this item, all five of those defects passed
--   both executed instruments with exit 0.
--
-- (h3) THE BLOCK TABLE'S ACL (D18/D12) IS ASSERTED, NOT ASSUMED. EXPECT: the
--   block table carries no anon/authenticated privilege, and the migration's
--   `revoke all on public.user_blocks …` is what removes it. Measured locally
--   WITH the platform default ACL modelled
--   (probes/user-blocks-acl.sql): B1-27a proves the model is in force, B1-27
--   asserts the revoke defeats it, B1-27b records RLS-with-no-policy as the
--   second layer. The mutation half — deleting the revoke — is RUN at layer 2
--   (mut-user-blocks-revoke-deleted goes blind on B1-27). Without the modelled
--   default this instrument is vacuous and the mutation survives; round-4
--   review MINOR-1 measured exactly that on the unmodelled harness.
--
-- (i) MENTION ACROSS A BLOCK (D21, the third branch). As C (blocked by A),
--   comment on P_A mentioning @B. EXPECT: no MENTION notification for B from
--   that comment. The mention branch is the THIRD deliver branch, and this item
--   asserts only its own guard: the recipient (B) is a third party, so the pair
--   guard is the internal form. The reply branch is a DIFFERENT branch with a
--   different recipient and its own additional gates (a distinct-from-owner
--   test and the post-visibility conjunct), and it is specified and measured
--   separately in (h2) above; round-4 review MINOR-3 flagged the earlier wording
--   as reading as though the two branches shared one guard.
--
-- (j) D19 PROMOTION REMOVED (fixture M17). [UNRUN HERE] — and now SUPERSEDED
--   (§13.8 item 3): the mutation this fixture describes (deleting the promotion
--   walk from findback_list_comments_client) no longer names a rule B1 ships, so
--   it cannot be killed by probe (e). Its replacement is B1-X5 in
--   draft-b1/must-fail-fixtures.mjs: "the comment reader re-applies the block as
--   a filter", killed at layer 1 and measured at layer 2 by 2(e), whose killing
--   observation is that c2 disappears instead of being flagged. Recorded as an
--   owed amendment in draft-b1/README.md Residual 0.
--
-- (k) LIMITS STAY BLOCK-IMMUNE (fixture M13, D29). [UNRUN HERE] The limit guard
--   belongs to B2's publish RPC, which does not exist in B1, so this probe can
--   only be written, not run: after B2 lands, a user whose POST is under an
--   inbound block must still see that post count toward their daily limit.
--   The mutation makes the guard read findback_visible_posts; the killing
--   observation is that the blocked user's own post stops counting and a
--   second publish is wrongly allowed. O5 makes this MORE important, not less:
--   a reader that surfaces blocks is still not permission for the limit guard
--   to read the view.
--
-- (l) M4, LIVE. As A (owner of P_A), PATCH /rest/v1/item_posts?id=eq.<P_A_ID>
--   with {"moderation_visibility":"PUBLISHED"} after a moderator has set it to
--   REMOVED. EXPECT: non-2xx or 0 rows updated — no UPDATE grant names the
--   column (P13 pins the catalog half). Then GET the row as A: A still sees it
--   because the owner clause keeps the author's own list complete in every
--   state, and the client maps it to "This report is being reviewed".
--
-- (m) INERTNESS ON A PRE-B1 SNAPSHOT. [UNRUN HERE on a real backend] On a
--   disposable backend restored to a pre-B1 dump, hash every affected reader's
--   output (findback_query_posts_client, _nearby, findback_list_comments_client,
--   findback_list_notifications_client) and the full public.notifications table
--   with moderation_visibility all-PUBLISHED and user_blocks empty; apply B1 and
--   re-hash. EXPECT: identical hashes, row for row, on the two readers that
--   gained a column compared over their pre-existing columns (the appended
--   column is the intended delta and is checked separately). This HAS been
--   measured on the local engine by draft-b1/inertness-selfcheck.mjs, pre-B1 vs
--   B1, on a fixed fixture; the live form on real data is still owed.
--
-- (n) CROSS-USER INBOX ISOLATION (round-3 MAJOR-1, the first blind spot). Seed a
--   stored COMMENT notification for D on a PUBLISHED post, in addition to B's
--   two rows. Measure three things:
--   * as D, findback_list_notifications_client(false) returns EXACTLY D's one row
--     (id, actor, blocked_actor = false) and NONE of B's;
--   * as B, the same call returns exactly B's two rows and never D's;
--   * total stored rows are unchanged by any of it.
--   EXPECT: each caller sees only their own inbox, row for row. The killing
--   mutation is deleting the reader's `where n.user_id = v_uid` term: every
--   caller then reads every user's inbox. Measured locally: B1-22a, B1-23,
--   B1-23b, B1-24; the mutation blinds B1-23/B1-23b/B1-24 and the run exits 1
--   (block-matrix-negative-controls.mjs, control 1).
--
-- (o) THE MODERATION HALF IN EVERY NON-PUBLISHED STATE (round-3 MAJOR-1, the
--   second blind spot). With B's two notifications targeting P_C, set P_C to
--   HIDDEN, then PENDING_REVIEW, then REMOVED, re-calling the reader as B each
--   time; then restore PUBLISHED.
--   EXPECT: the inbox is EMPTY in all three non-PUBLISHED states and returns
--   both rows again after the restore (so "empty" is not the reader being broken).
--   A third party's row on a different PUBLISHED post must survive every one of
--   those transitions — the state change is not a cross-user effect. Measured
--   locally: B1-25, B1-25b, B1-25c, B1-25d, B1-25e. Exposing PENDING_REVIEW or
--   REMOVED through the view blinds B1-25b / B1-25d respectively and exits 1
--   (block-matrix-negative-controls.mjs, controls 2 and 3).
