-- Live verification for the CF-060 R10 reader pair:
--   20261020090000_cf060_r10_feed_block_flag.sql      (findback_query_posts_client)
--   20261020090500_cf060_r10_nearby_block_flag.sql    (findback_query_posts_nearby_client)
--
-- STATUS OF THIS FILE: NOTHING IN THIS FILE HAS BEEN EXECUTED. Every stanza
-- below is marked **UNRUN**. This file is a hosted-run checklist; it was not
-- sent to a hosted project and it is not what the local harness executed.
--
-- WHAT *WAS* EXECUTED (2026-10-21, disposable local PostgreSQL 17, never a
-- hosted project): the R10 worktree's own migration chain plus one fixture
-- file applied cleanly (the harness prints APPLIED 64/63 because its numerator
-- includes that fixture, FAILED 0). The separate executable assertion file
-- sessions/trust-backend/harness/r10/verify_r10_flags.sql reported 39 successful
-- SELECT probes including subject switches, zero EMPTY and zero ERROR:
--   F2/F3/F7/F8/F9/F10/F11 PASS for BOTH feed and numeric-coordinate nearby readers
--     (including one-direction unblock retaining the reverse block's flag)
--   F4/F13 PASS: internal predicate/private block table and both anon reader
--     calls refused with SQLSTATE 42501; authenticated view read allowed
--   C1/C2/C3/C4 PASS: last OUT column is blocked_author boolean on BOTH readers,
--     invoker, authenticated-only ACL, and no re-derived predicate in reader
-- C1 originally used pg_type.typrelid, which cannot inspect an anonymous
-- RETURNS TABLE record. It now uses proargnames/proargmodes/proallargtypes.
-- Expected-denial DO blocks catch only 42501; unexpected permission raises an
-- uncaught error and fails the harness, rather than counting as success.
-- Reproduction: sessions/trust-backend/harness/r10-verify-final.sh; raw log:
-- sessions/trust-backend/harness/r10-final-logs/engine.log.
-- F7/F12 additionally ran nine nonempty snapshots across four separate
-- baseline/R10 blocked/empty engine runs: fields/rows/order/cursor windows identical after
-- removing only blocked_author; both readers clamp 50 requested rows to 20;
-- feed total_count=27 and numeric-radius nearby total_count=26 on the fixture.
-- Reproduction: sessions/trust-backend/harness/r10-f12-differential.py.
-- Hosted execution remains unmeasured; local engine evidence is not hosted proof.
--
-- No PostgreSQL engine, no local cluster, no hosted project and no PostgREST
-- endpoint is contacted by this file itself. A static parity check
-- (supabase/tests/migration_parity.test.mjs, describe "CF-060 R10 feed block
-- flag") proves that the two re-created readers differ from the applied B1 text
-- by exactly one appended OUT column and one appended projection entry, and that
-- the ACL, invoker rights and page clamp are preserved. A lexer guard
-- (supabase/tests/migration_sql_syntax.test.mjs) proves every migration is
-- lexically balanced, which is the defect class that once made these two files
-- unparseable. Neither is behaviour evidence.
--
-- WHY THIS FILE EXISTS SEPARATELY FROM THE MIGRATION: the design (§2.5) and the
-- R10 work order require the verification stanzas to ship with the change and to
-- be honest about execution. A green static suite must never be presented as
-- hosted execution.
--
-- HOW TO RUN (when an engine is available)
--   * Local, disposable cluster: the trust-backend harness applies the real
--     migration chain to a throwaway local PostgreSQL and drives it with
--     `set role authenticated` plus
--     `set_config('request.jwt.claim.sub', '<uid>', false)`; the same shape as
--     harness/chain.mjs used for B1. Record the tallies in an evidence file.
--   * Hosted: only on a DISPOSABLE test project under the
--     supabase/tests/run-live.sh conventions
--     (TEST_SUPABASE_URL, TEST_SUPABASE_PUBLISHABLE_KEY, TEST_USER_A_JWT,
--     TEST_USER_B_JWT). Never against production. Values are never printed.
--
-- FIXTURES the stanzas assume (all created by the disposable test setup, never
-- by this file): users A, B and C; a PUBLISHED post P authored by B; a HIDDEN
-- post H authored by C; and a row in public.user_blocks with
-- blocker_user_id = A, blocked_user_id = B.
--
-- INVARIANTS UNDER TEST (design §2.2 and §13.8 item 3)
--   1. A blocked pair never removes a row: the row is PRESENT and flagged.
--   2. The flag is caller-scoped and direction-free: it says "a block exists
--      between the caller and this author", never who blocked whom.
--   3. The flag is computed by the view's helper, never re-derived by a reader:
--      no reader reads public.user_blocks and none calls the pair predicate.
--   4. Own rows are never flagged (a self-pair is impossible).
--   5. Moderation collapse is untouched: a non-PUBLISHED row stays absent.
--   6. The drop/re-create restored the full ACL; anon gained nothing.

-- ---------------------------------------------------------------------------
-- Section 1 — catalog probes (read-only; database owner session)
-- ---------------------------------------------------------------------------

-- 1.1 Both readers expose the appended column, LAST, and no other new column.
--     Expect: exactly one row per function; blocked_author is the final OUT
--     column of each.
-- [UNRUN]
select p.proname,
       array_agg(a.name order by a.ord) as out_columns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(p.proargnames, p.proargmodes)
    with ordinality as a(name, mode, ord)
 where n.nspname = 'public'
    and p.proname in ('findback_query_posts_client', 'findback_query_posts_nearby_client')
    and a.mode in ('o', 'b', 't')
  group by p.oid, p.proname
 having (array_agg(a.name order by a.ord desc))[1] = 'blocked_author';

-- 1.2 The readers stayed security invoker and stable.
--     Expect: two rows, prosecdef = false for both.
-- [UNRUN]
select p.proname, p.prosecdef, p.provolatile
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('findback_query_posts_client', 'findback_query_posts_nearby_client');

-- 1.3 The non-owner EXECUTE membership is the authored one (F13, static half).
--     Assert MEMBERSHIP, never set equality: a re-create by a different grantor
--     legitimately adds that grantor's default grantee, and the owner appears in
--     its own ACL. Expect: authenticated present, anon absent, owner ignored.
-- [UNRUN]
select p.proname,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       has_function_privilege('anon', p.oid, 'execute')          as anon_can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('findback_query_posts_client', 'findback_query_posts_nearby_client');

-- 1.4 The readers never read the block table or the pair predicate themselves.
--     Expect: zero rows — any hit means a reader re-derived a predicate instead
--     of carrying the view's bit.
-- [UNRUN]
select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('findback_query_posts_client', 'findback_query_posts_nearby_client')
   and (pg_get_functiondef(p.oid) ilike '%user_blocks%'
        or pg_get_functiondef(p.oid) ilike '%findback_is_blocked_pair%'
        or pg_get_functiondef(p.oid) ilike '%findback_is_blocked_with_me%');

-- ---------------------------------------------------------------------------
-- Section 2 — behavioural matrix (disposable project only; writes fixtures)
-- ---------------------------------------------------------------------------
-- Every stanza runs as the named caller inside one transaction and rolls back.
-- Each one states the exact expectation; a stanza that returns no row has
-- passed, a stanza that returns a row has failed, and the failure message names
-- which invariant broke.

-- F2 — A (blocked with B) reads B's PUBLISHED post through the feed reader.
-- Invariant 1 and 2: the row is PRESENT and blocked_author = TRUE.
-- A counter that treats "no row" as success is the exact defect O5 removed.
-- [UNRUN]
--   set local role authenticated;
--   select set_config('request.jwt.claim.sub', '<A>', true);
--   select count(*) as rows_present, bool_and(blocked_author) as all_flagged
--     from public.findback_query_posts_client(p_post_id => '<P>', p_limit => 20);
--   -- expect: rows_present = 1, all_flagged = true
--   rollback;

-- F3 — C (party to no block) reads the same row.
-- Invariant 2: the bit is caller-scoped. Expect blocked_author = FALSE for a
-- stranger even though the same row is flagged for A.
-- [UNRUN]
--   set local role authenticated;
--   select set_config('request.jwt.claim.sub', '<C>', true);
--   select blocked_author from public.findback_query_posts_client(p_post_id => '<P>', p_limit => 20);
--   -- expect: false
--   rollback;

-- F4 — C attempts the internal pair predicate directly.
-- Invariant 3 / B1 review MAJOR-1: a non-party viewer must not be able to ask
-- the question at all. Expect SQLSTATE 42501 (insufficient_privilege), NOT a
-- boolean.
-- [UNRUN]
--   set local role authenticated;
--   select set_config('request.jwt.claim.sub', '<C>', true);
--   select public.findback_is_blocked_pair('<A>', '<B>');
--   -- expect: ERROR 42501, never true/false
--   rollback;

-- F8 — unblock semantics. After A unblocks B (the row is deleted from
-- user_blocks), re-reading P clears the flag; and while BOTH directions exist
-- (A blocked B and B blocked A) the flag stays TRUE for both readers.
-- Invariant 2: direction-free and symmetric.
-- [UNRUN]
--   set local role authenticated;
--   select set_config('request.jwt.claim.sub', '<A>', true);
--   -- while present:
--   select blocked_author from public.findback_query_posts_client(p_post_id => '<P>', p_limit => 20);
--   -- expect: true
--   -- (delete the pair as the writer, then re-read)
--   select blocked_author from public.findback_query_posts_client(p_post_id => '<P>', p_limit => 20);
--   -- expect: false, and the row was never missing in either read
--   rollback;

-- F9 — bidirectional read. A reads B and B reads A; both see TRUE, and neither
-- read discloses the initiator. Expect two rows, both true.
-- [UNRUN]
--   set local role authenticated;
--   select set_config('request.jwt.claim.sub', '<A>', true);
--   select blocked_author from public.findback_query_posts_client(p_post_id => '<P>', p_limit => 20);
--   select set_config('request.jwt.claim.sub', '<B>', true);
--   select blocked_author from public.findback_query_posts_client(p_post_id => '<H_or_B_post>', p_limit => 20);
--   -- expect: true and true
--   rollback;

-- F13 — ACL at the engine (dynamic half of 1.3).
--   (a) as anon: EXECUTE on both readers is refused (42501).
--   (b) as authenticated: a direct SELECT on public.user_blocks is refused (42501).
--   (c) as authenticated: SELECT through public.findback_visible_posts succeeds.
-- [UNRUN]
--   set local role anon;
--   select count(*) from public.findback_query_posts_client(p_limit => 1);   -- expect 42501
--   rollback;
--   set local role authenticated;
--   select set_config('request.jwt.claim.sub', '<A>', true);
--   select * from public.user_blocks limit 1;                                 -- expect 42501
--   select count(*) from public.findback_visible_posts;                        -- expect allowed
--   rollback;

-- ---------------------------------------------------------------------------
-- Stanzas deliberately NOT shipped here
-- ---------------------------------------------------------------------------
-- F1 (mutant: OUT column removed), F5 (client renderer ignores the bit),
-- F6 (block re-applied as a WHERE filter), F14 (client wire-name mutant) and
-- F15 (cache round-trip) are falsified by executable tests, not by SQL:
--   F1/F6  supabase/tests/migration_parity.test.mjs (the R10 describe block)
--   F5     apps/mobile/src/components/BlockedByViewerShield.test.tsx
--   F14    apps/mobile/src/services/posts.test.ts ("O5 block bit mapping")
--   F15    apps/mobile/src/hooks/feedCache.test.ts
-- F10 (own rows unflagged), F11 (hidden rows stay hidden) and F12 (row set,
-- order, window) were executed by the local engine run recorded above and are
-- PASS there. What remains owed is the **hosted** run of the stanzas in this
-- file — the same matrix at the layer this checklist covers, including F2/F3/
-- F4/F8/F9/F13. The two statements describe the same items at different layers:
-- engine execution (local, done) and hosted checklist execution (not done, and
-- deliberately not claimed anywhere in this file).
