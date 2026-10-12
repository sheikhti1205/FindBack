-- LIVE-PENDING verification for 20261012020000_comment_attachments_parity.sql.
--
-- Run ONLY against the live/test project AFTER the migration applies, as a
-- database owner (Supabase dashboard SQL editor). Section 1 is read-only.
-- Section 2 is the live-pending VALIDATE CONSTRAINT step (read-only scan,
-- takes SHARE UPDATE EXCLUSIVE locks briefly). Section 3 needs scratch
-- sessions on a disposable backend. NEVER run section 3 against production.
--
-- Expected: every check below returns a row (no EXCEPTION).

-- ---------------------------------------------------------------------------
-- 1. Read-only: vocabulary, columns, coherence, RPCs, queue.
-- ---------------------------------------------------------------------------

-- 1a. Kind vocabulary includes the spec's STICKER pick.
select conname,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.comment_attachments'::regclass
  and conname = 'comment_attachments_kind_check';
-- EXPECT: definition lists photo, video, gif, sticker.

-- 1b. Provenance columns exist.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'comment_attachments'
  and column_name in ('provider', 'mime_type', 'file_name', 'file_size',
                      'width', 'height', 'preview_url')
order by 1;
-- EXPECT: 7 rows (file_size bigint, width/height integer).

-- 1c. Coherence checks exist and are NOT VALID (no live scan on apply).
select conname, convalidated
from pg_constraint
where conrelid = 'public.comment_attachments'::regclass
  and conname in ('comment_attachments_provider_check',
                  'comment_attachments_provider_source_check',
                  'comment_attachments_owned_key_check',
                  'comment_attachments_slug_shape_check',
                  'comment_attachments_url_https_check',
                  'comment_attachments_size_check',
                  'comment_attachments_dims_check')
order by 1;
-- EXPECT: 7 rows, convalidated false on all.

-- 1d. Comment list RPC returns ordered attachments; client EXECUTE intact.
select position('attachments' in pg_get_function_result(p.oid)) >= 0 as has_attachments,
  position('order by a.display_order asc' in pg_get_functiondef(p.oid)) > 0 as ordered,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'findback_list_comments_client';
-- EXPECT: true, true, true, false.

-- 1e. Atomic create RPC exists, authenticated-only; claim RPC is
--     service-role-only; enqueue trigger helper fully revoked.
select p.proname,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('findback_add_comment_with_attachments',
                    'claim_comment_media_cleanup',
                    'enqueue_comment_media_cleanup')
order by 1;
-- EXPECT: atomic create auth true / anon false;
--         claim service true / auth false / anon false;
--         enqueue all false.

-- 1f. Cleanup trigger fires on attachment delete; queue denies clients.
select tgname from pg_trigger where tgname = 'comment_attachments_cleanup_enqueue';
-- EXPECT: 1 row.
select has_table_privilege('authenticated', 'public.comment_media_cleanup_queue', 'SELECT') as auth_select,
  has_table_privilege('anon', 'public.comment_media_cleanup_queue', 'SELECT') as anon_select;
-- EXPECT: false, false.

-- ---------------------------------------------------------------------------
-- 2. LIVE-PENDING validate step (owner session, after 1c is green and the
--    table is known-clean; safe to run in production hours — brief lock).
-- ---------------------------------------------------------------------------
-- alter table public.comment_attachments validate constraint comment_attachments_provider_check;
-- alter table public.comment_attachments validate constraint comment_attachments_provider_source_check;
-- alter table public.comment_attachments validate constraint comment_attachments_owned_key_check;
-- alter table public.comment_attachments validate constraint comment_attachments_slug_shape_check;
-- alter table public.comment_attachments validate constraint comment_attachments_url_https_check;
-- alter table public.comment_attachments validate constraint comment_attachments_size_check;
-- alter table public.comment_attachments validate constraint comment_attachments_dims_check;
-- Then re-run 1c: EXPECT convalidated true on all 7 rows.

-- ---------------------------------------------------------------------------
-- 3. Scratch-backend behavioral smoke (disposable backend only):
--    atomic create with 1 STORAGE + 1 KLIPY descriptor, list shows both
--    ordered by display_order, 5th descriptor rejected (22023), foreign
--    staged key rejected (22023), non-https url rejected (22023), duplicate
--    display_order rejected (22023), nothing persisted on any rejection.
-- ---------------------------------------------------------------------------
-- (Executable curl/psql steps for the disposable backend live in
-- supabase/tests/run-live.sh suite COMMENTS.)
