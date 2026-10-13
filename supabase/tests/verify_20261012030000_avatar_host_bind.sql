-- LIVE verification for 20261012030000_avatar_url_host_bind.sql.
-- Run against the chosen live/disposable project AFTER the migration applies.
-- Conventions: read-only probes first; state-changing probes use a throwaway
-- user and clean up; every probe prints PASS/FAIL via raise notice on failure.

-- P1. Helper predicate exists with the exact signature.
-- NOTE: pg_get_function_identity_arguments() returns names AND types
-- (`p_url text, p_uid text`), so the probe must match that form — a
-- type-only `'text, text'` never matches on this engine.
select 'P1 predicate present' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'is_own_avatar_public_url'
    and pg_get_function_identity_arguments(p.oid) = 'p_url text, p_uid text'
);

-- P2. Lookalike host rejected (pure SQL, no auth needed for the predicate).
select 'P2 lookalike' as probe
where public.is_own_avatar_public_url(
  'https://nfjhpigbsyyoaaktfaev.supabase.co.evil.example/storage/v1/object/public/findback-images/avatars/UID/x.jpg',
  'UID'
) = false;

-- P3. Multi-label subdomain rejected.
select 'P3 subdomain' as probe
where public.is_own_avatar_public_url(
  'https://a.b.supabase.co/storage/v1/object/public/findback-images/avatars/UID/x.jpg',
  'UID'
) = false;

-- P4. Plain http rejected.
select 'P4 http' as probe
where public.is_own_avatar_public_url(
  'http://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-images/avatars/UID/x.jpg',
  'UID'
) = false;

-- P5. Other uid rejected.
select 'P5 other-uid' as probe
where public.is_own_avatar_public_url(
  'https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-images/avatars/OTHER/x.jpg',
  'UID'
) = false;

-- P6. Bare prefix (no object name) rejected.
select 'P6 bare-prefix' as probe
where public.is_own_avatar_public_url(
  'https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-images/avatars/UID/',
  'UID'
) = false;

-- P7. Traversal rejected (raw and encoded).
select 'P7 traversal' as probe
where public.is_own_avatar_public_url(
  'https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-images/avatars/UID/../x.jpg',
  'UID'
) = false
and public.is_own_avatar_public_url(
  'https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-images/avatars/UID/%2e%2e/x.jpg',
  'UID'
) = false;

-- P8. Well-formed own URL accepted by the predicate (shape only; the RPCs
-- additionally require the Storage object to exist where applicable).
select 'P8 well-formed' as probe
where public.is_own_avatar_public_url(
  'https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-images/avatars/UID/photo-1.jpg',
  'UID'
) = true;

-- P9 (live, authenticated as TEST_USER_A_JWT). update_my_avatar with a
-- lookalike-host URL must raise 22023 and persist nothing:
--   select public.update_my_avatar('https://evil.example/findback-images/avatars/<uid>/x.jpg');
-- expect: ERROR 22023 'invalid avatar url'; avatar_url unchanged afterwards.
-- P10 (live). update_my_avatar_by_key with a lookalike-host URL must raise
-- 22023 likewise (needs an existing owned object for the positive path;
-- upload one to avatars/<uid>/ first, then delete it after).
