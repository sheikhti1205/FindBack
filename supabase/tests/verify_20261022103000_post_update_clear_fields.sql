-- Verification for 20261022103000_post_update_clear_fields.sql (explicit clear).
--
-- STATUS, STATED PLAINLY. This migration has NOT been applied to the hosted
-- project (LIVE-PENDING). THE PROBES IN THIS FILE HAVE NOT BEEN EXECUTED.
-- Nothing here may be quoted as a passing result until it has been run and
-- its output recorded.
--
-- HOW TO RUN IT. Section 1 is read-only catalog probes: run them in the
-- Supabase dashboard SQL editor (or as the database owner) AFTER the
-- migration is applied. Section 2 is behavioural: it switches to the
-- `authenticated` role with a JWT subject claim
-- (`set_config('request.jwt.claim.sub', <uid>, false)`) and writes scratch
-- rows, so run it on a DISPOSABLE PostgreSQL 17 with the whole migration
-- chain applied on top — never on production — and wrap it in a transaction
-- that ROLLBACKs. Section 3 is the post-apply READBACK of the hosted
-- project.
--
-- The properties under test, in the order the migration states them:
--   1. the RPC still has its ten original arguments, plus ONE trailing
--      `p_clear_fields text[] default null`;
--   2. the OLD ten-argument signature is gone (no leftover overload that a
--      caller could reach instead of the new one);
--   3. a null array clears nothing — every existing caller behaves exactly
--      as before;
--   4. only 'location_label', 'latitude' and 'longitude' can be cleared;
--   5. required fields and unknown names are refused (22023);
--   6. the coordinates are one field;
--   7. an explicit value beats a clear request for the same field;
--   8. the MERGED row is validated — the values the row will have after the
--      caller's arguments are coalesced with the stored ones — exactly as
--      the deployed function validates it, and the row is still written under
--      the caller's own id.

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes.
-- ---------------------------------------------------------------------------

-- P1. The RPC exists with ELEVEN arguments, the eleventh being
--     `p_clear_fields text[]` with a null default.
select 'P1 the clear argument exists' as probe
where exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'findback_update_post_client'
    and p.pronargs = 11
    and p.proargnames[11] = 'p_clear_fields'
    and p.proargtypes[11] = 'text[]'
    and p.proargdefaultvals[11] is not null
);
-- EXPECT: 1 row.

-- P2. The OLD ten-argument signature is gone: there is exactly ONE
--     `findback_update_post_client` in the schema.
select 'P2 no leftover overload' as probe
where (
  select count(*)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_update_post_client'
) = 1;
-- EXPECT: 1 row.

-- P3. The ten original argument names are unchanged, in order.
select 'P3 the original arguments are unchanged' as probe
where exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'findback_update_post_client'
    and p.proargnames[1:10] = array[
      'p_post_id', 'p_type', 'p_title', 'p_description', 'p_category',
      'p_event_date', 'p_latitude', 'p_longitude', 'p_location_label',
      'p_youtube_url'
    ]::name[]
);
-- EXPECT: 1 row.

-- P4. The function is still SECURITY INVOKER with a locked search_path, and
--     it still returns boolean.
select 'P4 security posture unchanged' as probe
where exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'findback_update_post_client'
    and not p.prosecdef
    and p.proconfig @> array['search_path=public, pg_temp']::text[]
    and p.prorettype = 'boolean'::regtype
);
-- EXPECT: 1 row.

-- P5. `authenticated` may EXECUTE the new signature; anon and PUBLIC may not.
select 'P5 grants are exact' as probe
where exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'findback_update_post_client'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
    and not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    )
);
-- EXPECT: 1 row.

-- P6. The body refuses an unknown clear name and a required field, and
--     keeps the ownership guard (`user_id = auth.uid()`).
select 'P6 the body refuses what it must' as probe
where exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'findback_update_post_client'
    and position('Unknown field to clear' in pg_get_functiondef(p.oid)) > 0
    and position('is required on every report and cannot be cleared' in pg_get_functiondef(p.oid)) > 0
    and position('user_id = v_uid' in pg_get_functiondef(p.oid)) > 0
    and position('findback_validate_post_fields' in pg_get_functiondef(p.oid)) > 0
);
-- EXPECT: 1 row.

-- ---------------------------------------------------------------------------
-- 2. Behavioural probes (disposable backend only; wrap in a transaction and
--    ROLLBACK). Setup: one account A with one report P_A that has a
--    location label 'Old place' and coordinates (1.5, 2.5).
-- ---------------------------------------------------------------------------

-- (a) AS A: findback_update_post_client(P_A, p_title => 'A new title')
--     changes the title and leaves everything else exactly as it was.
-- EXPECT: true; title = 'A new title'; location_label and coordinates
-- unchanged. This is the EXISTING CALLER contract — it must not change.

-- (b) AS A: findback_update_post_client(P_A, p_clear_fields => NULL)
--     changes nothing at all.
-- EXPECT: true; every stored column identical to the state before the call.

-- (c) AS A: findback_update_post_client(P_A, p_clear_fields =>
--     array['location_label']) empties the label and KEEPS the coordinates.
-- EXPECT: true; location_label IS NULL; latitude/longitude unchanged.

-- (d) AS A: findback_update_post_client(P_A, p_clear_fields =>
--     array['latitude']) empties BOTH coordinates (they are one field).
-- EXPECT: true; latitude IS NULL AND longitude IS NULL; location_label
-- unchanged (still NULL from probe (c) if it was not re-set).

-- (e) AS A: findback_update_post_client(P_A, p_clear_fields =>
--     array['category']) is REFUSED.
-- EXPECT: SQLSTATE 22023 with the message naming the field; no column of
-- the row changed.

-- (f) AS A: findback_update_post_client(P_A, p_clear_fields =>
--     array['nonsense']) is REFUSED.
-- EXPECT: SQLSTATE 22023; no column of the row changed.

-- (g) AS A: findback_update_post_client(P_A, p_clear_fields =>
--     array['latitude'], p_latitude => 3.5) is REFUSED (the coordinates may
--     be cleared or set, never both in one call).
-- EXPECT: SQLSTATE 22023; no column of the row changed.

-- (h) AS A: findback_update_post_client(P_A, p_location_label => 'New place',
--     p_clear_fields => array['location_label']) keeps 'New place' — an
--     explicit value beats a clear request for the same field.
-- EXPECT: true; location_label = 'New place'.

-- (i) AS A: findback_update_post_client(P_A, p_title => 'x') is REFUSED by
--     the shared validator (a title needs 3-120 characters), and the stored
--     title is unchanged.
-- EXPECT: SQLSTATE 22023.

-- (j) AS B (a different account): findback_update_post_client(P_A, ...)
--     is REFUSED — a report that is not the caller's cannot be edited.
-- EXPECT: SQLSTATE 42501; P_A is unchanged.

-- (k) AS ANON (set role anon): the RPC raises 42501.
-- EXPECT: 42501.

-- (l) NO SESSION (auth.uid() is null): the RPC raises 28000.
-- EXPECT: 28000.

-- (m) AS A: a report whose STORED values do not satisfy the shared validator
--     (a legacy row with an empty event_date, an empty description or an
--     empty category) is REFUSED when its owner tries to edit it, and the
--     stored row is left untouched.
-- EXPECT: 22023 (or whatever the shared validator raises for that row); the
-- stored values are unchanged. This is the DEPLOYED rule: the validator sees
-- the MERGED row, so a stored row the validator would refuse cannot be
-- edited — not even in an unrelated field. The migrated function keeps that
-- rule; it does not weaken it.

-- ---------------------------------------------------------------------------
-- 3. POST-APPLY READBACK (hosted project, after the migration is applied).
--    Read-only; safe to run in the dashboard SQL editor.
-- ---------------------------------------------------------------------------

-- R1. The signature that landed.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       pg_get_function_result(p.oid) as returns,
       p.prosecdef as security_definer,
       p.proconfig as function_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'findback_update_post_client';
-- EXPECT: exactly one row; the identity arguments end with
-- `p_clear_fields text[]`; returns boolean; security_definer = false;
-- function_settings contains {search_path=public, pg_temp}.

-- R2. The argument list, with the default of the new argument.
select p.proargnames, p.proargtypes, p.proargdefaultvals
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'findback_update_post_client';
-- EXPECT: eleven names ending in p_clear_fields; the eleventh default is
-- NULL (a null array clears nothing).

-- R3. The grants on the new signature.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where specific_schema = 'public'
  and routine_name = 'findback_update_post_client'
order by grantee, privilege_type;
-- EXPECT: one row — grantee = authenticated, privilege_type = EXECUTE. No
-- row for anon and no row for PUBLIC.

-- R4. The body, as it landed.
select pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'findback_update_post_client';
-- EXPECT: the body refuses an unknown clear name, refuses a required field,
-- refuses clearing and setting the coordinates together, keeps the
-- ownership guard (`where id = p_post_id and user_id = v_uid`) and still
-- calls findback_validate_post_fields on the MERGED row — the values the row
-- will have after the clear request is honoured — and it does so BEFORE the
-- update. It must NOT contain the old weaker form (a validation of the
-- incoming arguments only, guarded by `if p_type is not null`).
