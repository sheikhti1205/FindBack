-- LIVE-PENDING verification for 20261013010000_comment_attachments_update_bind.sql.
--
-- Run ONLY after the migration applies. Section 1 is read-only catalog
-- probes (database owner session, e.g. Supabase dashboard SQL editor).
-- Section 2 documents the live-run behavioral probes (a) + (b): run them on
-- a disposable test backend under the supabase/tests/run-live.sh
-- conventions — same env contract (TEST_SUPABASE_URL,
-- TEST_SUPABASE_PUBLISHABLE_KEY, TEST_USER_A_JWT, TEST_USER_B_JWT), never
-- against production, values never printed. Expected: every probe below
-- returns a row (no EXCEPTION); sections 2a/2b are owner-executed REST
-- steps whose expected HTTP codes are recorded inline.
--
-- What this migration closes (FB-AUD-03): the pre-existing
-- comment_attachments_update_own policy (from
-- 20261011020000_comment_attachments_relation.sql, already applied live)
-- gated USING/WITH CHECK on user_id only, so an owner could reassign
-- their attachment row to another comment_id they do not own. The new
-- policy requires comment ownership in BOTH clauses.

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes.
-- ---------------------------------------------------------------------------

-- P1. UPDATE policy exists, authenticated-only, UPDATE command.
select 'P1 update-policy present' as probe
where exists (
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_update_own'
    and cmd = 'UPDATE'
    and roles = '{authenticated}'
);
-- EXPECT: 1 row.

-- NOTE ON MATCHING: pg_policies.qual / with_check are DEPARSED by the engine
-- (keywords upper-cased, `auth.uid()` rendered as `( SELECT auth.uid() AS uid)`,
-- joins schema-unqualified). Raw lowercase substring matches never hit. Every
-- expression probe below therefore compares against the whitespace-stripped,
-- lower-cased form: regexp_replace(lower(<expr>), '\s', '', 'g').

-- P2. USING binds the row to a caller-owned comment (INSERT-pattern EXISTS).
select 'P2 using binds comment ownership' as probe
where exists (
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_update_own'
    and regexp_replace(lower(qual), '\s', '', 'g') like '%user_id=((selectauth.uid()asuid))::text)%'
    and regexp_replace(lower(qual), '\s', '', 'g') like '%exists(select1fromcommentscwhere((c.id=comment_attachments.comment_id)and(c.user_id=((selectauth.uid()asuid))::text)))%'
);
-- EXPECT: 1 row. A user_id-only USING is the FB-AUD-03 hole — it must NOT
-- match; the EXISTS anti-join on public.comments must be present.

-- P3. WITH CHECK binds the rewritten row the same way (closes reassignment).
select 'P3 with-check binds comment ownership' as probe
where exists (
  select 1 from pg_policies
  where schemaname = 'public'
    and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_update_own'
    and regexp_replace(lower(with_check), '\s', '', 'g') like '%user_id=((selectauth.uid()asuid))::text)%'
    and regexp_replace(lower(with_check), '\s', '', 'g') like '%exists(select1fromcommentscwhere((c.id=comment_attachments.comment_id)and(c.user_id=((selectauth.uid()asuid))::text)))%'
);
-- EXPECT: 1 row. Reassigning comment_id to a foreign comment must fail the
-- WITH CHECK even when user_id is unchanged.

-- P4. Sibling policies untouched: select/insert/delete still owner-only and
-- the INSERT policy still carries the same comment-ownership EXISTS.
select 'P4 siblings untouched' as probe
where exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_select_own' and cmd = 'SELECT'
)
and exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_insert_own' and cmd = 'INSERT'
    and regexp_replace(lower(with_check), '\s', '', 'g') like '%exists(select1fromcommentscwhere((c.id=comment_attachments.comment_id)and(c.user_id=((selectauth.uid()asuid))::text)))%'
)
and exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_delete_own' and cmd = 'DELETE'
);
-- EXPECT: 1 row.

-- ---------------------------------------------------------------------------
-- 2. Live-run behavioral probes (disposable backend only; run-live.sh env).
-- ---------------------------------------------------------------------------
-- Setup (owner session): two comments on a scratch post — comment A owned by
-- TEST_USER_A, comment B owned by TEST_USER_B — plus one attachment row
-- owned by A on comment A (insert via the atomic RPC or an owner insert
-- that satisfies the INSERT policy).
--
-- (a) Owner display_order edit still allowed. As TEST_USER_A_JWT:
--   curl -s -o /tmp/a_body -w "%{http_code}" \
--     -X PATCH "$TEST_SUPABASE_URL/rest/v1/comment_attachments?id=eq.<ATTACH_A_ID>" \
--     -H "apikey: $TEST_SUPABASE_PUBLISHABLE_KEY" \
--     -H "Authorization: Bearer $TEST_USER_A_JWT" \
--     -H "Content-Type: application/json" \
--     -H "Prefer: return=representation" \
--     -d '{"display_order":2}'
-- EXPECT: HTTP 200 with the row returned (USING passed: own row on own
-- comment; WITH CHECK passed: user_id and comment_id unchanged, comment
-- still owned). Restore display_order afterwards.
--
-- (b) Reassignment to a foreign comment_id rejected by WITH CHECK.
-- As TEST_USER_A_JWT:
--   curl -s -o /tmp/b_body -w "%{http_code}" \
--     -X PATCH "$TEST_SUPABASE_URL/rest/v1/comment_attachments?id=eq.<ATTACH_A_ID>" \
--     -H "apikey: $TEST_SUPABASE_PUBLISHABLE_KEY" \
--     -H "Authorization: Bearer $TEST_USER_A_JWT" \
--     -H "Content-Type: application/json" \
--     -d '{"comment_id":"<COMMENT_B_ID>"}'
-- EXPECT: non-2xx (new-row violates WITH CHECK: target comment is owned by
-- B, not the caller), error body mentions row-level security / policy, and
-- a follow-up GET as A still shows comment_id = <COMMENT_A_ID>.
