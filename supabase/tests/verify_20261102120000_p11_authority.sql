-- P11 — authority closure: live verification.
--
-- Covers ONLY the seams the P11 handoff requires proof for, in one rolled-back
-- transaction:
--   * raw consumer table writes / reads are refused, canonical RPCs still work;
--   * staging metadata is verified (fabricated key, size, foreign folder);
--   * report media is private: the owner and a legitimately authorized reader
--     can read it, a hidden report's object cannot be read, legacy public-URL
--     rows keep working;
--   * deleting a report queues the exact object key and nothing else;
--   * a stale staging purge removes an abandoned upload but can never touch
--     published media;
--   * the message-scoped chat wake claim is service-role only and re-checks the
--     sender, while the scheduled lane's claim stays untouched.
--
-- Run AFTER 20261102120000_p11_authority_closure.sql applies. Everything below
-- is transaction-local: `rollback;` at the end leaves the database unchanged.
-- Expected: every row in `public.p11_verify_results` has ok = true.

begin;

-- ---------------------------------------------------------------------------
-- 0. Scratch result table (rolled back with everything else).
-- ---------------------------------------------------------------------------
create table public.p11_verify_results (
  step text primary key,
  ok boolean not null,
  detail text
);
create table public.p11_ctx (
  key text primary key,
  value text
);
grant select, insert on public.p11_verify_results to authenticated, service_role;
grant select, insert, update on public.p11_ctx to authenticated, service_role;
-- This project auto-enables RLS on new public tables; these are transaction-local
-- scratch tables, so RLS is switched off explicitly for the probe session.
alter table public.p11_verify_results disable row level security;
alter table public.p11_ctx disable row level security;

-- ---------------------------------------------------------------------------
-- 1. Fixtures (database owner; bypasses RLS by design, this is test setup).
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'p11owner@example.test',
   '{"username": "p11owner", "phone": "+8801712345678"}'::jsonb, now(), now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'p11reader@example.test',
   '{"username": "p11reader", "phone": "+8801812345678"}'::jsonb, now(), now()),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'p11other@example.test',
   '{"username": "p11other", "phone": "+8801912345678"}'::jsonb, now(), now());
-- `handle_new_auth_user` created the matching public.users rows.

-- The object whose key every probe names. Staging ids double as upload ids.
insert into storage.objects (bucket_id, name, metadata) values
  ('findback-report-media',
   '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001.jpg',
   '{"size": 1234, "mimetype": "image/jpeg"}'::jsonb),
  ('findback-report-media',
   '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000002.jpg',
   '{"size": 4321, "mimetype": "image/jpeg"}'::jsonb),
  ('findback-report-media',
   '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000003.jpg',
   '{"size": 999, "mimetype": "image/jpeg"}'::jsonb),
  ('findback-report-media',
   '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000004.jpg',
   '{"size": 555, "mimetype": "image/jpeg"}'::jsonb),
  -- A report the ordinary reader must NOT be able to reach (moderation HIDDEN
  -- below), so its bytes must stop being served.
  ('findback-report-media',
   '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000005.jpg',
   '{"size": 777, "mimetype": "image/jpeg"}'::jsonb);

insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at, moderation_visibility)
values
  -- Backdated so this fixture never spends the account's daily post allowance
  -- or its burst cooldown (findback_enforce_interaction_limit).
  ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'LOST', 'P11 hidden report', 'hidden', 'Electronics', 'OPEN', '2026-09-01',
   to_char(now() - interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   to_char(now() - interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'HIDDEN');

insert into public.attachments (id, post_id, file_url, mime_type, file_name, file_size, created_at, storage_path)
values
  ('cccccccc-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
   '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000005.jpg',
   'image/jpeg', 'hidden.jpg', 777, now()::text,
   '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000005.jpg');

-- Chat wake fixtures: one message the owner sent, one queued wake for the reader.
insert into public.chat_conversations (id, user_a, user_b, state, initiated_by)
values ('ffffffff-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
        'CONNECTED', '11111111-1111-4111-8111-111111111111');
insert into public.chat_messages (id, conversation_id, sender_id, body, message_type)
values ('ffffffff-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111', 'p11 wake', 'TEXT');
insert into public.device_tokens (id, user_id, token, platform, created_at, updated_at)
values ('ffffffff-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222',
        'p11-fake-token', 'android', now()::text, now()::text);
insert into public.chat_external_wakes (id, message_id, conversation_id, recipient_id, kind)
values ('ffffffff-0000-4000-8000-000000000004', 'ffffffff-0000-4000-8000-000000000002',
        'ffffffff-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
        'CHAT_CONNECTED');
insert into public.chat_external_wake_devices (wake_id, device_id)
values ('ffffffff-0000-4000-8000-000000000004', 'ffffffff-0000-4000-8000-000000000003');

-- ---------------------------------------------------------------------------
-- 2. Catalog probes (no role switch needed).
-- ---------------------------------------------------------------------------
insert into public.p11_verify_results (step, ok, detail)
select 'C1 report-media bucket exists and is private',
       coalesce((select not b.public from storage.buckets b where b.id = 'findback-report-media'), false),
       coalesce((select 'public=' || b.public::text from storage.buckets b where b.id = 'findback-report-media'), 'bucket missing');

insert into public.p11_verify_results (step, ok, detail)
select 'C2 published media is gated by report readability',
       exists (
         select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'findback_report_media_select_authorized'
            and coalesce(qual, '') like '%findback_can_read_post%'
       )
       -- The policy must call the caller-derived form, not the two-argument one
       -- a client cannot execute and whose viewer id must never be caller-chosen.
       and not exists (
         select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'findback_report_media_select_authorized'
            and coalesce(qual, '') like '%findback_can_read_post_for%'
       ),
       'policy findback_report_media_select_authorized';

insert into public.p11_verify_results (step, ok, detail)
select 'C3 staging derives the key and verifies the stored object',
       exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'findback_stage_upload' and p.prosecdef
            and position('storage.objects' in pg_get_functiondef(p.oid)) > 0
            and position('v_uid || ''/'' || p_id' in pg_get_functiondef(p.oid)) > 0
       ),
       'findback_stage_upload is definer and reads storage.objects';

insert into public.p11_verify_results (step, ok, detail)
select 'C4 publish RPCs are definer; update joins them',
       (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('findback_create_post_client', 'findback_create_post_client_multi')
           and p.prosecdef)
       and (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'findback_update_post_client'),
       'definer + owner check inside each body';

insert into public.p11_verify_results (step, ok, detail)
select 'C5 cleanup queue is service-role only',
       not has_table_privilege('authenticated', 'public.report_media_cleanup_queue', 'SELECT')
       and not has_table_privilege('anon', 'public.report_media_cleanup_queue', 'SELECT')
       and has_function_privilege('service_role',
             (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'claim_report_media_cleanup'), 'EXECUTE')
       and not has_function_privilege('authenticated',
             (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'claim_report_media_cleanup'), 'EXECUTE')
       and not has_function_privilege('authenticated',
             (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'ack_report_media_cleanup'), 'EXECUTE')
       and not has_function_privilege('authenticated',
             (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'purge_abandoned_staging_uploads'), 'EXECUTE'),
       'queue + claim/ack/purge grants';

insert into public.p11_verify_results (step, ok, detail)
select 'C6 message-scoped wake claim is service-role only and re-checks the sender',
       has_function_privilege('service_role',
             (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'findback_claim_chat_external_wakes_for_message'), 'EXECUTE')
       and not has_function_privilege('authenticated',
             (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'findback_claim_chat_external_wakes_for_message'), 'EXECUTE')
       and not has_function_privilege('anon',
             (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'findback_claim_chat_external_wakes_for_message'), 'EXECUTE')
       and exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'findback_claim_chat_external_wakes_for_message'
            and position('m.sender_id = p_actor' in pg_get_functiondef(p.oid)) > 0
       ),
       'the scheduled findback_claim_chat_external_wakes is untouched';

insert into public.p11_verify_results (step, ok, detail)
select 'C7 read RPCs stand in for the revoked table reads',
       (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef
           and p.proname in ('findback_query_posts_client', 'findback_query_posts_nearby_client',
                             'findback_match_candidates_v2')
           and position('findback_can_read' in pg_get_functiondef(p.oid)) > 0)
       and (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.prosecdef
               and p.proname in ('findback_feed_reaction_state_client', 'findback_post_social_state_client')),
       '3 post readers carry the predicate; 2 own-reaction readers are definer';

insert into public.p11_verify_results (step, ok, detail)
select 'C8 hot FK indexes exist',
       (select count(*) from pg_indexes
         where schemaname = 'public' and indexname like '%_idx'
           and indexname in ('appeals_moderation_action_idx','appeals_resolved_by_idx','appeals_sanction_idx',
                             'chat_conversations_initiated_by_idx','chat_external_wakes_conversation_idx',
                             'chat_mailbox_conversation_idx','chat_media_attachments_author_idx',
                             'chat_media_attachments_conversation_idx','chat_messages_unsent_by_idx',
                             'comment_attachments_user_idx','notifications_actor_idx','notifications_comment_idx',
                             'notifications_post_idx','successful_returns_confirmed_by_idx',
                             'successful_returns_found_post_idx','attachments_storage_path_idx')) = 16,
       '15 FK indexes + attachments.storage_path';

-- C9. The explicit column revokes above must cover everything the catalogue
-- actually holds. A surviving column grant is exactly the hole a table-level
-- REVOKE leaves, and it is invisible to a behavioural probe that only tries the
-- columns the app happens to name.
insert into public.p11_verify_results (step, ok, detail)
select 'C9 no client write privilege survives at column level',
       not exists (
         select 1
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(a.attacl) p
           join pg_roles g on g.oid = p.grantee
          where n.nspname = 'public'
            and g.rolname = 'authenticated'
            and c.relname in ('item_posts', 'attachments', 'uploads', 'comments',
                              'comment_attachments', 'reactions', 'ratings', 'comment_reactions')
            and (
              p.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
              or c.relname in ('reactions', 'ratings', 'comment_reactions')
            )
       ),
       'column ACLs after the migration';

-- C10. Table-level counterpart: the write flags and the three reaction tables.
insert into public.p11_verify_results (step, ok, detail)
select 'C10 no client write privilege survives at table level',
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relname in ('item_posts', 'attachments', 'uploads', 'comments', 'comment_attachments')
           and (has_table_privilege('authenticated', c.oid, 'INSERT')
                or has_table_privilege('authenticated', c.oid, 'UPDATE')
                or has_table_privilege('authenticated', c.oid, 'DELETE'))) = 0
       and not has_table_privilege('authenticated', 'public.reactions', 'SELECT')
       and not has_table_privilege('authenticated', 'public.ratings', 'SELECT')
       and not has_table_privilege('authenticated', 'public.comment_reactions', 'SELECT'),
       'table ACLs after the migration';

-- ---------------------------------------------------------------------------
-- 3. Authority: raw consumer writes are refused (as the owning account).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;

do $$
declare v_step text;
begin
  -- A1..A6: one refused statement each. A 42501 is the expected answer; any
  -- success is a regression and is recorded as such.
  begin
    insert into public.item_posts (id, user_id, type, title, description, category, event_date, created_at, updated_at)
    values ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
            'LOST', 'raw', 'raw', 'Electronics', '2026-09-01', now()::text, now()::text);
    insert into public.p11_verify_results values ('A1 raw report insert refused', false, 'insert succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A1 raw report insert refused', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
  end;
  begin
    insert into public.attachments (id, post_id, file_url, mime_type, file_name, file_size, created_at)
    values ('dddddddd-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001',
            'https://example.test/x.jpg', 'image/jpeg', 'x.jpg', 10, now()::text);
    insert into public.p11_verify_results values ('A2 raw attachment insert refused', false, 'insert succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A2 raw attachment insert refused', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
  end;
  begin
    insert into public.uploads (id, user_id, file_name, mime_type, file_size, file_url, created_at)
    values ('dddddddd-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
            'x.jpg', 'image/jpeg', 10, 'https://example.test/x.jpg', now()::text);
    insert into public.p11_verify_results values ('A3 raw staging insert refused', false, 'insert succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A3 raw staging insert refused', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
  end;
  begin
    insert into public.comments (id, post_id, user_id, body, created_at, updated_at)
    values ('dddddddd-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000001',
            '11111111-1111-4111-8111-111111111111', 'raw', now()::text, now()::text);
    insert into public.p11_verify_results values ('A4 raw comment insert refused', false, 'insert succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A4 raw comment insert refused', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
  end;
  begin
    insert into public.comment_attachments (id, comment_id, user_id, kind, display_order, storage_path, created_at)
    values ('dddddddd-0000-4000-8000-000000000005', 'dddddddd-0000-4000-8000-000000000004',
            '11111111-1111-4111-8111-111111111111', 'photo', 1, null, now()::text);
    insert into public.p11_verify_results values ('A5 raw comment-media insert refused', false, 'insert succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A5 raw comment-media insert refused', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
  end;
  begin
    perform 1 from public.reactions limit 1;
    insert into public.p11_verify_results values ('A6 raw reactions read refused', false, 'select succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A6 raw reactions read refused', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
  end;

  -- A7: a staging row claiming an object that does not exist is refused.
  begin
    perform public.findback_stage_upload(
      'aaaaaaaa-0000-4000-8000-000000000099',
      '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000099.jpg',
      'ghost.jpg', 'image/jpeg', 1, null, null);
    insert into public.p11_verify_results values ('A7 fabricated staging key refused', false, 'staging succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A7 fabricated staging key refused', sqlstate = '22023', sqlstate || ' ' || sqlerrm);
  end;

  -- A8: the declared size must match the stored object.
  begin
    perform public.findback_stage_upload(
      'aaaaaaaa-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001.jpg',
      'probe.jpg', 'image/jpeg', 999999, null, null);
    insert into public.p11_verify_results values ('A8 fabricated staging size refused', false, 'staging succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A8 fabricated staging size refused', sqlstate = '22023', sqlstate || ' ' || sqlerrm);
  end;

  -- A9: the key is derived, so another account's folder cannot be addressed.
  begin
    perform public.findback_stage_upload(
      'aaaaaaaa-0000-4000-8000-000000000002',
      '22222222-2222-4222-8222-222222222222/aaaaaaaa-0000-4000-8000-000000000002.jpg',
      'probe.jpg', 'image/jpeg', 4321, null, null);
    insert into public.p11_verify_results values ('A9 foreign staging folder refused', false, 'staging succeeded');
  exception when others then
    insert into public.p11_verify_results values ('A9 foreign staging folder refused', sqlstate = '22023', sqlstate || ' ' || sqlerrm);
  end;

  -- A10: the honest path stages.
  begin
    perform public.findback_stage_upload(
      'aaaaaaaa-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001.jpg',
      'probe.jpg', 'image/jpeg', 1234, 100, 100);
    insert into public.p11_verify_results values ('A10 canonical staging succeeds', true, 'findback_stage_upload');
  exception when others then
    insert into public.p11_verify_results values ('A10 canonical staging succeeds', false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- A11: the canonical publish consumes the staging row into a private attachment.
do $$
declare v_post text;
begin
  v_post := public.findback_create_post_client_multi(
    'LOST', 'P11 probe report', 'probe description', 'Electronics', '2026-09-01',
    array['aaaaaaaa-0000-4000-8000-000000000001'], null, null, null, null);
  insert into public.p11_ctx values ('published_post', v_post)
    on conflict (key) do update set value = excluded.value;
  insert into public.p11_verify_results values (
    'A11 canonical publish creates a private attachment',
    exists (select 1 from public.attachments a
             where a.post_id = v_post
               and a.storage_path = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001.jpg'
               and a.file_url = a.storage_path)
    and not exists (select 1 from public.uploads u
                     where u.id = 'aaaaaaaa-0000-4000-8000-000000000001'),
    v_post);
exception when others then
  insert into public.p11_verify_results values ('A11 canonical publish creates a private attachment', false, sqlstate || ' ' || sqlerrm);
end $$;

-- A12/A13: canonical comment creation works; a new video attachment does not.
do $$
declare v_post text;
begin
  select value into v_post from public.p11_ctx where key = 'published_post';
  if v_post is null then
    insert into public.p11_verify_results values ('A12 canonical comment creation succeeds', false, 'publish did not run');
    insert into public.p11_verify_results values ('A13 new video comment attachment refused', false, 'publish did not run');
    return;
  end if;
  begin
    perform 1 from public.findback_add_comment_client(v_post, 'P11 probe comment', null);
    insert into public.p11_verify_results values ('A12 canonical comment creation succeeds', true, 'findback_add_comment_client');
  exception when others then
    insert into public.p11_verify_results values ('A12 canonical comment creation succeeds', false, sqlstate || ' ' || sqlerrm);
  end;
  begin
    -- A separate account posts this one: the first comment of the day clears
    -- the burst cooldown, so the refusal that follows is the video rule and not
    -- the interaction limit.
    perform set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
    perform 1 from public.findback_add_comment_with_attachments(
      v_post, 'video probe', null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'video', 'display_order', 1,
        'storage_key', '33333333-3333-4333-8333-333333333333/clip.mp4',
        'remote_url', 'https://example.test/clip.mp4',
        'mime_type', 'video/mp4', 'file_name', 'clip.mp4')));
    perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
    insert into public.p11_verify_results values ('A13 new video comment attachment refused', false, 'accepted');
  exception when others then
    perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
    insert into public.p11_verify_results values ('A13 new video comment attachment refused',
      sqlstate = '22023' and sqlerrm ilike '%video%', sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- A14: the owner can read their own staged/published object.
do $$
declare v_count integer;
begin
  select count(*) into v_count from storage.objects
   where bucket_id = 'findback-report-media'
     and name = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001.jpg';
  insert into public.p11_verify_results values ('A14 owner reads own private media', v_count = 1, 'rows=' || v_count::text);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Readability of another account's private media.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);

do $$
declare v_post text; v_visible integer; v_hidden integer;
begin
  select value into v_post from public.p11_ctx where key = 'published_post';
  select count(*) into v_visible from storage.objects
   where bucket_id = 'findback-report-media'
     and name = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001.jpg';
  insert into public.p11_verify_results values (
    'B1 authorized reader reads published private media', v_visible = 1, 'rows=' || v_visible::text);

  select count(*) into v_hidden from storage.objects
   where bucket_id = 'findback-report-media'
     and name = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000005.jpg';
  insert into public.p11_verify_results values (
    'B2 hidden report media is not readable', v_hidden = 0, 'rows=' || v_hidden::text);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Report deletion queues exactly the owned object.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

do $$
declare v_post text; v_key text;
begin
  select value into v_post from public.p11_ctx where key = 'published_post';
  v_key := '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001.jpg';
  perform public.findback_delete_post_client(v_post);
  insert into public.p11_verify_results values (
    'A15 report delete removes the report',
    not exists (select 1 from public.item_posts p where p.id = v_post),
    v_post);
exception when others then
  insert into public.p11_verify_results values ('A15 report delete removes the report', false, sqlstate || ' ' || sqlerrm);
end $$;

-- The queue itself is owner-only, so its exact contents are asserted at the end.

-- ---------------------------------------------------------------------------
-- 6. Discard + stale-staging purge never touch published media.
-- ---------------------------------------------------------------------------
-- A second, still-published report whose object must survive every sweep.
do $$
declare v_post text;
begin
  perform public.findback_stage_upload(
    'aaaaaaaa-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000002.jpg',
    'keep.jpg', 'image/jpeg', 4321, 200, 150);
  v_post := public.findback_create_post_client_multi(
    'FOUND', 'P11 keeper report', 'keeper description', 'Electronics', '2026-09-02',
    array['aaaaaaaa-0000-4000-8000-000000000002'], null, null, null, null);
  insert into public.p11_ctx values ('keeper_post', v_post)
    on conflict (key) do update set value = excluded.value;
  insert into public.p11_verify_results values ('A16 second publish keeps its private attachment',
    exists (select 1 from public.attachments a where a.post_id = v_post
             and a.storage_path = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000002.jpg'),
    v_post);
exception when others then
  insert into public.p11_verify_results values ('A16 second publish keeps its private attachment', false, sqlstate || ' ' || sqlerrm);
end $$;

do $$
begin
  perform public.findback_stage_upload(
    'aaaaaaaa-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000003.jpg',
    'discard.jpg', 'image/jpeg', 999, null, null);
  perform public.findback_discard_staged_upload('aaaaaaaa-0000-4000-8000-000000000003');
  insert into public.p11_verify_results values ('A17 discard removes the staging row',
    not exists (select 1 from public.uploads u where u.id = 'aaaaaaaa-0000-4000-8000-000000000003'), 'findback_discard_staged_upload');
exception when others then
  insert into public.p11_verify_results values ('A17 discard removes the staging row', false, sqlstate || ' ' || sqlerrm);
end $$;

-- D1: a client session cannot call the message-scoped claim at all. The grant
-- probe (C6) says the same statically; this proves the call is refused.
do $$
begin
  perform 1 from public.findback_claim_chat_external_wakes_for_message(
    'ffffffff-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 10);
  insert into public.p11_verify_results values ('D1 client sessions cannot claim wakes', false, 'call succeeded');
exception when others then
  insert into public.p11_verify_results values ('D1 client sessions cannot claim wakes', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
end $$;

-- Abandoned staging older than the grace window. Created as the owner session
-- because a client can no longer write `uploads` directly (that is A3). The
-- service-role RPCs below are executed by the owner session too: their
-- service-role-only grant is asserted in C5/C6, and this section proves the
-- behaviour of the bodies.
reset role;
insert into public.uploads (id, user_id, file_name, mime_type, file_size, file_url, object_key, created_at)
values ('aaaaaaaa-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111',
        'stale.jpg', 'image/jpeg', 555,
        '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000004.jpg',
        '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000004.jpg',
        to_char(now() - interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

do $$
declare v_purged integer;
begin
  v_purged := public.purge_abandoned_staging_uploads(200, interval '24 hours');
  insert into public.p11_verify_results values ('A18 stale staging purge removes the staging row',
    v_purged >= 1
    and not exists (select 1 from public.uploads u where u.id = 'aaaaaaaa-0000-4000-8000-000000000004'),
    'purged=' || v_purged::text);
exception when others then
  insert into public.p11_verify_results values ('A18 stale staging purge removes the staging row', false, sqlstate || ' ' || sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Chat wake claim: sender re-check, service-role only.
-- ---------------------------------------------------------------------------
do $$
declare v_foreign integer; v_own integer;
begin
  select count(*) into v_foreign
    from public.findback_claim_chat_external_wakes_for_message(
      'ffffffff-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 10);
  insert into public.p11_verify_results values ('D2 a non-sender claims nothing', v_foreign = 0, 'rows=' || v_foreign::text);

  select count(*) into v_own
    from public.findback_claim_chat_external_wakes_for_message(
      'ffffffff-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 10);
  insert into public.p11_verify_results values ('D3 the sender claims exactly this message''s wake', v_own = 1, 'rows=' || v_own::text);

  insert into public.p11_verify_results values ('D4 the claim leases the device, it does not send',
    exists (select 1 from public.chat_external_wake_devices d
             where d.wake_id = 'ffffffff-0000-4000-8000-000000000004'
               and d.state = 'CLAIMED' and d.attempts = 1 and d.claim_token is not null),
    'state/attempts/claim_token');
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 8. Lifecycle end state (owner session): the queue holds exact keys only.
-- ---------------------------------------------------------------------------
insert into public.p11_verify_results (step, ok, detail)
select 'E1 deleted report queued its exact object key',
       exists (select 1 from public.report_media_cleanup_queue q
                where q.object_key = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001.jpg'),
       'attachments_report_media_cleanup';

insert into public.p11_verify_results (step, ok, detail)
select 'E2 discarded staging queued its exact object key',
       exists (select 1 from public.report_media_cleanup_queue q
                where q.object_key = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000003.jpg'),
       'findback_discard_staged_upload';

insert into public.p11_verify_results (step, ok, detail)
select 'E3 stale staging purge queued its exact object key',
       exists (select 1 from public.report_media_cleanup_queue q
                where q.object_key = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000004.jpg'),
       'purge_abandoned_staging_uploads';

insert into public.p11_verify_results (step, ok, detail)
select 'E4 published media was never queued for deletion',
       not exists (select 1 from public.report_media_cleanup_queue q
                    where q.object_key = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000002.jpg')
       and exists (select 1 from public.attachments a
                    where a.storage_path = '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000002.jpg'),
       'keeper report object + row untouched';

insert into public.p11_verify_results (step, ok, detail)
select 'E5 a legacy public-URL attachment is still readable and queues nothing',
       exists (select 1 from public.attachments a
                where a.post_id = 'bbbbbbbb-0000-4000-8000-000000000001' and a.storage_path is not null)
       and not exists (select 1 from public.report_media_cleanup_queue q
                        where q.object_key like 'https://%'),
       'storage_path is the only authority; file_url may be a legacy URL';

-- ---------------------------------------------------------------------------
-- 9. Result.
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.p11_verify_results where ok) as passed,
  (select count(*) from public.p11_verify_results where not ok) as failed,
  (select coalesce(jsonb_agg(jsonb_build_object('step', step, 'ok', ok, 'detail', detail) order by step), '[]'::jsonb)
     from public.p11_verify_results) as results;

rollback;
