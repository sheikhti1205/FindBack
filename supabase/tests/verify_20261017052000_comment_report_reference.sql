-- LIVE-PENDING verification for 20261017052000_comment_report_reference.sql.
--
-- Run ONLY after the migration applies. Section 1 is read-only catalog probes
-- (database owner session, e.g. the Supabase dashboard SQL editor): every probe
-- selects a row when the invariant holds, and returns no row when it does not.
-- No probe writes anything. Section 2 documents the behavioural probes that
-- need a write, so they run on a DISPOSABLE test backend under the
-- supabase/tests/run-live.sh conventions (TEST_SUPABASE_URL,
-- TEST_SUPABASE_PUBLISHABLE_KEY, TEST_USER_A_JWT, TEST_USER_B_JWT) and never
-- against production. Values are never printed.
--
-- What this migration adds (CF-060 M2): a comment's attachment tray may carry a
-- typed report reference — a tagged `comment_attachments` row with
-- kind = 'report' and report_post_id set, no media/provenance field, and
-- report_post_id nullable with `on delete set null` so deleting a referenced
-- report never fails and leaves a tombstone whose pointer was nulled (the row
-- itself carries no media or provenance column, because the RPC is its only
-- writer and the policies refuse a client-authored report row).
--
-- DEPARSED-EXPRESSION NOTE: pg_policies.qual / with_check and pg_get_constraintdef
-- are rendered by the engine (keywords upper-cased, `auth.uid()` as
-- `( SELECT auth.uid() AS uid)`), so every expression probe below compares the
-- whitespace-stripped, lower-cased form via
-- regexp_replace(lower(<expr>), '\s', '', 'g').

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes. EXPECT: 1 row each.
-- ---------------------------------------------------------------------------

-- P1. The kind vocabulary admits 'report'.
select 'P1 kind check admits report' as probe
where exists (
  select 1 from pg_constraint
  where conrelid = 'public.comment_attachments'::regclass
    and conname = 'comment_attachments_kind_check'
    and regexp_replace(lower(pg_get_constraintdef(oid)), '\s', '', 'g')
        like '%kind=any(array[''photo''::text,''video''::text,''gif''::text,''sticker''::text,''report''::text])%'
);

-- P2. remote_url is nullable now (a report row has no URL).
select 'P2 remote_url nullable' as probe
where exists (
  select 1 from pg_attribute
  where attrelid = 'public.comment_attachments'::regclass
    and attname = 'remote_url' and attnotnull = false
);

-- P3. source_xor is kind-aware: exactly-one-of applies to media kinds, and a
-- report row must carry neither source.
select 'P3 source_xor kind-aware' as probe
where exists (
  select 1 from pg_constraint
  where conrelid = 'public.comment_attachments'::regclass
    and conname = 'comment_attachments_source_xor'
    and regexp_replace(lower(pg_get_constraintdef(oid)), '\s', '', 'g')
        like '%when(kind=''report''::text)then((storage_pathisnull)and(klipy_slugisnull))%'
);

-- P4. The pointer exists, references item_posts, and nulls on delete.
select 'P4 report_post_id fk set null' as probe
where exists (
  select 1 from pg_constraint
  where conrelid = 'public.comment_attachments'::regclass
    and conname = 'comment_attachments_report_post_id_fkey'
    and confrelid = 'public.item_posts'::regclass
    and confdeltype = 'n'
);

-- P5. The index exists (no sequential scan resolving a pointer).
select 'P5 report_post_id index' as probe
where exists (
  select 1 from pg_indexes
  where schemaname = 'public' and tablename = 'comment_attachments'
    and indexname = 'idx_comment_attachments_report_post'
);

-- P6. Deliberately NOT present: a CHECK forcing report_post_id non-null on a
-- report row. It would make the FK's SET NULL fail and block report deletion.
select 'P6 no non-null pointer check' as probe
where not exists (
  select 1 from pg_constraint
  where conrelid = 'public.comment_attachments'::regclass
    and contype = 'c'
    and regexp_replace(lower(pg_get_constraintdef(oid)), '\s', '', 'g')
        like '%report_post_idisnotnull%'
);

-- P7. READ: the select policy is exactly the owner branch OR the content-free
-- report branch — and nothing else. Containment alone cannot see a widened qual
-- (`... or kind = 'report' or true` would make every attachment row, including
-- every media row, world-readable while still containing both expected atoms),
-- so the probe also requires the two branches to be adjacent in one expression
-- and refuses any `true` atom outright. The deparse text is engine-dependent, so
-- this is the strongest live form; the source-level assertion in
-- supabase/tests/migration_parity.test.mjs pins the expression exactly.
select 'P7 select policy report branch' as probe
where exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_select_own' and cmd = 'SELECT'
    and regexp_replace(lower(qual), '\s', '', 'g') like '%kind=''report''::text%'
    and regexp_replace(lower(qual), '\s', '', 'g') like '%user_id=((selectauth.uid()asuid))::text)%'
    and regexp_replace(lower(qual), '\s', '', 'g')
        like '%((selectauth.uid()asuid))::text)or(kind=''report''::text)%'
    and regexp_replace(lower(qual), '\s', '', 'g') not like '%true%'
    and regexp_replace(lower(qual), '\s', '', 'g') not like '%1=1%'
);

-- P8. WRITE: the insert policy refuses report rows outright and keeps the
-- comment-ownership bind.
select 'P8 insert policy refuses report' as probe
where exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_insert_own' and cmd = 'INSERT'
    and regexp_replace(lower(with_check), '\s', '', 'g') like '%kind<>''report''::text%'
    and regexp_replace(lower(with_check), '\s', '', 'g')
        like '%exists(select1fromcommentscwhere((c.id=comment_attachments.comment_id)and(c.user_id=((selectauth.uid()asuid))::text)))%'
);

-- P9. WRITE: the update policy refuses report rows in BOTH clauses (USING
-- hides them from UPDATE, WITH CHECK refuses a flip) and keeps the ownership
-- bind in both.
select 'P9 update policy refuses report' as probe
where exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_update_own' and cmd = 'UPDATE'
    and regexp_replace(lower(qual), '\s', '', 'g') like '%kind<>''report''::text%'
    and regexp_replace(lower(with_check), '\s', '', 'g') like '%kind<>''report''::text%'
    and regexp_replace(lower(qual), '\s', '', 'g')
        like '%exists(select1fromcommentscwhere((c.id=comment_attachments.comment_id)and(c.user_id=((selectauth.uid()asuid))::text)))%'
    and regexp_replace(lower(with_check), '\s', '', 'g')
        like '%exists(select1fromcommentscwhere((c.id=comment_attachments.comment_id)and(c.user_id=((selectauth.uid()asuid))::text)))%'
);

-- P10. DELETE stays owner-only and undocumented-by-kind (an author detaching
-- their own pointer leaks nothing and cannot create a reference).
select 'P10 delete policy untouched' as probe
where exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'comment_attachments'
    and policyname = 'comment_attachments_delete_own' and cmd = 'DELETE'
    and regexp_replace(lower(qual), '\s', '', 'g') like '%user_id=((selectauth.uid()asuid))::text)%'
);

-- P11. The writer branches on a report descriptor and validates the target
-- report before inserting.
select 'P11 writer validates report target' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_add_comment_with_attachments'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') like '%ifv_kind=''report''then%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%ifnotexists(select1frompublic.item_postspwherep.id=v_report)then%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') like '%reportreferencecarriesnomediafields%'
);

-- P12. The D7 content rule: a blank body is legal only with a descriptor, and
-- the over-length rule is unchanged.
select 'P12 body rule relaxed only with descriptors' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_add_comment_with_attachments'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%ifchar_length(btrim(p_body))<1andv_count=0then%'
    and regexp_replace(lower(p.prosrc), '\s', '', 'g')
        like '%ifchar_length(btrim(p_body))>1000then%'
);

-- P13. The list RPC adds the pointer to the projection and stays an invoker
-- reader; the writer stays a definer with an empty search_path.
select 'P13 reader projection + security modes' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_list_comments_client'
    and p.prosecdef = false
    and regexp_replace(lower(p.prosrc), '\s', '', 'g') like '%''report_post_id'',a.report_post_id%'
)
and exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_add_comment_with_attachments'
    and p.prosecdef = true
    and regexp_replace(lower(coalesce(array_to_string(p.proconfig, ','), '')), '\s', '', 'g')
        like '%search_path=public,pg_temp%'
);

-- P14. Grants unchanged: authenticated keeps table DML on the relation and
-- EXECUTE on both RPCs; anon keeps nothing but the two RPC revokes.
select 'P14 grants unchanged' as probe
where has_table_privilege('authenticated', 'public.comment_attachments', 'SELECT')
  and has_table_privilege('authenticated', 'public.comment_attachments', 'INSERT')
  and has_table_privilege('authenticated', 'public.comment_attachments', 'UPDATE')
  and has_table_privilege('authenticated', 'public.comment_attachments', 'DELETE')
  and not has_any_column_privilege('anon', 'public.comment_attachments', 'SELECT')
  and has_function_privilege('authenticated', 'public.findback_add_comment_with_attachments(text,text,text,jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.findback_list_comments_client(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.findback_add_comment_with_attachments(text,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.findback_list_comments_client(text)', 'EXECUTE');

-- P15. The untouched coherence checks are still there and still NOT VALID, so
-- the apply rescanned nothing and no live row changed.
select 'P15 untouched coherence checks stay NOT VALID' as probe
where (
  select count(*) from pg_constraint
  where conrelid = 'public.comment_attachments'::regclass
    and conname in (
      'comment_attachments_provider_check',
      'comment_attachments_provider_source_check',
      'comment_attachments_owned_key_check',
      'comment_attachments_slug_shape_check',
      'comment_attachments_url_https_check',
      'comment_attachments_size_check',
      'comment_attachments_dims_check'
    )
    and not convalidated
) = 7;

-- P16. No report row exists immediately after the apply (the migration itself
-- writes no data). Run this once, right after the apply; a later run will
-- legitimately see rows written by real use — that is not a failure.
select 'P16 no data written by the migration' as probe
where (
  select count(*) from public.comment_attachments where kind = 'report'
) = 0;

-- P17. comment_attachments carries exactly four policies — the three this
-- migration re-creates plus the pre-existing delete policy — and no fifth one
-- rode along. P7–P10 are keyed by policy name, so an *added* policy is invisible
-- to them; this probe closes that blind spot (review R2 MINOR-R2-2). A widened
-- predicate on an existing policy is P7's job; an extra policy is this one's.
select 'P17 exactly four policies on comment_attachments' as probe
where (
  select array_agg(policyname::text order by policyname) from pg_policies
  where schemaname = 'public' and tablename = 'comment_attachments'
) = array[
  'comment_attachments_delete_own',
  'comment_attachments_insert_own',
  'comment_attachments_select_own',
  'comment_attachments_update_own'
]::text[];

-- ---------------------------------------------------------------------------
-- 2. Behavioral probes (disposable backend only; run-live.sh env).
-- ---------------------------------------------------------------------------
-- Setup (owner session): three reports — REPORT_A published by TEST_USER_A,
-- REPORT_B published by TEST_USER_B, and REPORT_C published by TEST_USER_A as
-- the scratch target the pointer comment lives on. COMMENT_A (owned by A) lives
-- on REPORT_C and carries two descriptors: a media row (order 1, a scratch
-- storage object) and a report pointer (order 2) to REPORT_A. COMMENT_D (owned
-- by A) lives on REPORT_A itself. Every curl below runs with the run-live.sh env
-- contract and never prints a token.
--
-- Why the pointer comment lives on REPORT_C and not on REPORT_A: comments.post_id
-- and comment_attachments.comment_id are both ON DELETE CASCADE, so a comment on
-- the deleted report takes its own pointer row with it, and the tombstone case
-- would be unobservable. (c1) is the same-post cascade case and (c2) is the
-- cross-post tombstone case.
--
-- Probe (c) deletes REPORT_A. Every later probe that needs a live target uses
-- REPORT_C (owned by A, never deleted) or REPORT_B.
--
-- (a) The pointer is written by the RPC, is visible to another viewer of the
--   comment, and does not drag the comment's media row with it.
--   A creates a second comment with a report descriptor only:
--     -d '{"p_post_id":"<REPORT_C_ID>","p_body":"about your report",
--          "p_attachments":[{"kind":"report","display_order":1,
--                            "report_post_id":"<REPORT_A_ID>"}]}'
--   EXPECT: HTTP 200, one comment row and exactly one attachment row.
--   Then, as TEST_USER_B, GET
--   /rest/v1/comment_attachments?comment_id=eq.<COMMENT_A_ID>&select=kind,report_post_id&order=display_order
--   EXPECT: HTTP 200 and exactly ONE row — `{"kind":"report","report_post_id":"<REPORT_A_ID>"}`.
--   B does not own COMMENT_A, so the content-free pointer is readable; the media
--   row of the same comment is NOT, and that absence is the assertion: the
--   widening is the report branch alone, not the table. A qual carrying an extra
--   disjunct would return two rows here.
--
-- (b) The card resolves to the same thing whether the target is absent or
-- inaccessible. Using the client's canonical read (fetchPost):
--   * an id that never existed -> `Post not found`;
--   * REPORT_B while signed in as a user who cannot read it -> the same
--     `Post not found` shape.
--   EXPECT: identical mapped output ("Report unavailable") for (i) a deleted
--   report and (ii) an unreadable report; no title, photo or location is
--   retained for either.
--
-- (c1) Deleting a report that a comment hangs off SUCCEEDS, and cascades.
--   As TEST_USER_A: delete REPORT_A. COMMENT_D lives on REPORT_A, so it and its
--   attachment rows must disappear with it (comments.post_id and
--   comment_attachments.comment_id are both ON DELETE CASCADE).
--   EXPECT: HTTP 204/no error — nothing blocks the delete — then GET by id shows
--   COMMENT_D's comment row and its attachments gone.
--
-- (c2) Deleting a referenced report SUCCEEDS and leaves a TOMBSTONE.
--   The same delete removes REPORT_A while COMMENT_A (on REPORT_C) still
--   references it. As A or B, GET
--   /rest/v1/comment_attachments?comment_id=eq.<COMMENT_A_ID>&select=kind,report_post_id&order=display_order
--   EXPECT: HTTP 200 with the pointer row still present, kind = 'report' and
--   report_post_id IS NULL, and the card renders "Report unavailable".
--   (c1) and (c2) are deliberately separate: (c1) proves the delete was not
--   refused, (c2) proves the pointer outlived it through the FK's SET NULL.
--   Together they distinguish a working SET NULL from both an erroring delete
--   and a pointer that was never nulled (a migration that made report_post_id
--   NOT NULL after the ADD COLUMN fails (c1) outright).
--
-- (d) A client cannot insert a report row directly.
--   As TEST_USER_A, POST /rest/v1/comment_attachments with
--   {"comment_id":"<COMMENT_A_ID>","user_id":"<A_UID>","kind":"report",
--    "display_order":2,"report_post_id":"<REPORT_A_ID>"}
--   EXPECT: non-2xx, RLS refuses the row (WITH CHECK carries `kind <> 'report'`),
--   and a follow-up GET shows no second row.
--
-- (e) A client cannot flip a media row into a reference.
--   As TEST_USER_A, PATCH /rest/v1/comment_attachments?id=eq.<ATTACH_A_ID>
--   with {"kind":"report","report_post_id":"<REPORT_A_ID>"}
--   EXPECT: non-2xx or 0 rows updated (USING carries `kind <> 'report'` for the
--   existing media row; the flip would also violate source_xor). Follow-up GET
--   shows kind still 'photo' and report_post_id still NULL.
--
-- (f) A client cannot retarget an existing reference.
--   With the row from (a) still present, as TEST_USER_A PATCH it with
--   {"report_post_id":"<REPORT_B_ID>"}.
--   EXPECT: non-2xx or 0 rows updated; follow-up GET shows the original id.
--
-- (g) The 4-cap counts a reference like any attachment.
--   Send two descriptors + a third reference so the total is 5.
--   EXPECT: HTTP 400, body mentions "At most 4 attachments" (22023), nothing
--   persisted (a follow-up GET shows no comment at that body).
--
-- (h) A duplicate display_order is refused.
--   Send descriptors [1, 1].
--   EXPECT: HTTP 400, 22023, nothing persisted.
--
-- (i) A blank body is accepted only with a descriptor.
--   (i1) p_body "   " with a report descriptor pointing at REPORT_C (still live
--        after (c)) -> HTTP 200 and the stored body is blank.
--   (i2) p_body "   " with p_attachments [] -> HTTP 400, 22023
--        ("Comment must be 1-1000 characters"), nothing persisted.
--
-- (j) A 1001-character body is still refused (with or without a descriptor).
--   EXPECT: HTTP 400, 22023 ("Comment must be 0-1000 characters").
--
-- (k) A report descriptor carrying media fields is refused.
--   {"kind":"report","display_order":1,"report_post_id":"<REPORT_A_ID>",
--    "remote_url":"https://example.test/x.png"}
--   EXPECT: HTTP 400, 22023, nothing persisted.
--
-- (l) A report descriptor pointing at a non-existent report is refused.
--   {"kind":"report","display_order":1,"report_post_id":"does-not-exist"}
--   EXPECT: HTTP 400 with code P0002 ("Report not found"), nothing persisted.
--
-- (m) The media path still demands an https URL. (The negative half of the
--   nullable remote_url change: nullability was widened for the report kind
--   only, and the RPC still refuses a media descriptor without a URL.)
--   {"kind":"photo","display_order":1,"storage_key":"<A_UID>/scratch.png",
--    "remote_url":null}
--   EXPECT: HTTP 400, 22023 ("attachment needs an https url").
--
-- (n) No bytes are enqueued for a reference row.
--   After (a): select count(*) from public.comment_media_cleanup_queue where
--   storage_path is not null and created_at > <apply_ts>;
--   EXPECT: 0 rows attributable to the reference row, and the cleanup consumer
--   reports no new claimable keys.
--
-- (p) NEGATIVE READ — the leak detector for a widened select policy.
--   As TEST_USER_B: GET /rest/v1/comment_attachments?id=eq.<ATTACH_MEDIA_A_ID>&select=id,kind
--   EXPECT: HTTP 200 with an empty array. RLS hides A's media row from B.
--   Then as TEST_USER_A: the same GET returns the row, because the owner branch
--   is intact. The two halves together bracket the policy: the first fails if the
--   policy was widened (any extra disjunct, e.g. `or true`, returns the media row
--   to B), the second fails if it was narrowed instead.
--   This is the probe MAJOR-2 of REVIEW-CF060-M2-TRANCHE.md asked for: no other
--   behavioural probe asks a non-owner to read a media row.

-- (o) Client-side (recorded here, asserted in the app suite): an attachment row
--   whose kind is not 'report' is never rendered as a report card even if
--   report_post_id is non-null. The pointer on a media row is inert by
--   construction — it is not part of the media insert path — and the mapper
--   gates on `kind`, which the client suite pins.
--
-- (q) THE COMMENT READ IS COMMENT-BOUND, NOT GLOBAL (review R2 MAJOR-R2-1).
--   This is the probe MAJOR-R2-1 asked for, and it is the only probe that calls
--   the list RPC and inspects the returned `attachments` array.
--   (q1) As TEST_USER_B: POST /rest/v1/rpc/findback_list_comments_client with
--     -d '{"p_post_id":"<REPORT_C_ID>"}'
--   then take the row whose id is <COMMENT_A_ID>. EXPECT: its `attachments`
--   array has exactly ONE element, and that element's `id` is <ATTACH_REF_A_ID>
--   (the content-free pointer on COMMENT_A). B does not own the media row on the
--   same comment, so the media descriptor is correctly absent — one element, not
--   two, and never two pointers.
--   Measured failure it detects: `... where a.comment_id = c.id or a.kind =
--   'report'` returns COMMENT_A with TWO elements (B's own pointer from another
--   comment rides inside another comment's card).
--   (q2) As TEST_USER_A: the same call returns COMMENT_A with TWO elements, and
--   the ORDER is asserted, not merely the count: element 1 has kind <> 'report'
--   (the media descriptor at display_order 1), element 2 has kind = 'report'
--   (the pointer at display_order 2), and the `display_order` values are
--   ascending. Counting alone is not enough — a reordered array still has two
--   elements. The bracketing half: (q1) fails if the attachment bind was
--   widened, (q2) fails if it was narrowed, reordered, or the ordering clause
--   was dropped.
--   (q3) As TEST_USER_B: the same call for <REPORT_B_ID> returns only rows whose
--   `post_id` is <REPORT_B_ID>. Measured failure it detects: `where c.post_id =
--   p_post_id or true` returns comments from REPORT_C inside REPORT_B's list —
--   a whole-list cross-post leak. Note REPORT_B is published by B, so the
--   comments on it are readable by B regardless of the report pointer feature.
--   None of (q1)–(q3) can be satisfied by a catalog probe: they are the only
--   evidence that the RPC an ordinary user actually calls is bound to its own
--   comment and its own post.
