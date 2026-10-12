-- LIVE-PENDING verification for 20261012010000_phone_cooldown_hardening.sql.
--
-- Run ONLY against the live/test project AFTER the migration applies, as a
-- database owner (Supabase dashboard SQL editor). Section 1 is read-only.
-- Section 2 needs two scratch authenticated sessions (it calls the same
-- read-only RPCs a client would; nothing is written). NEVER run against
-- production user rows; the script writes nothing itself.
--
-- Expected: every check below returns a row (no EXCEPTION).

-- ---------------------------------------------------------------------------
-- 1. Read-only: objects, shapes, grants (owner session).
-- ---------------------------------------------------------------------------

-- 1a. Safe-parse helper exists, immutable, no client EXECUTE.
select
  p.proname as function,
  pg_get_function_identity_arguments(p.oid) as args,
  p.provolatile as volatility, -- 'i' == immutable
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'findback_safe_eligible_at';
-- EXPECT: 1 row, volatility 'i', anon_exec false, auth_exec false.

-- 1b. Garbage parses to NULL (eligible), canonical form parses (gate).
select public.findback_safe_eligible_at('not-a-date') is null as garbage_is_null;
-- EXPECT: true.
select public.findback_safe_eligible_at(null) is null as null_is_null;
-- EXPECT: true.
select public.findback_safe_eligible_at('') is null as empty_is_null;
-- EXPECT: true.
select public.findback_safe_eligible_at('2030-01-01T00:00:00.000Z') is not null as canonical_parses;
-- EXPECT: true.

-- 1c. Client grants preserved exactly: authenticated may EXECUTE both RPCs,
--     anon may EXECUTE neither; trigger helper stays fully revoked.
select p.proname,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('phone_change_eligibility', 'request_phone_change',
                    'maintain_phone_change_cooldown', 'findback_safe_eligible_at')
order by 1;
-- EXPECT: eligibility + request_phone_change auth true / anon false;
--         maintain_* + safe_* both false.

-- 1d. Advisory-lock serialization present in the gate source.
select position('pg_advisory_xact_lock' in pg_get_functiondef(p.oid)) > 0 as gate_serializes
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'request_phone_change';
-- EXPECT: true (one row; overload: single text arg).

-- ---------------------------------------------------------------------------
-- 2. Authenticated smoke (scratch sessions only; read-only RPCs).
--    As scratch user A (no recorded cooldown): both RPCs must report
--    eligible=true. As scratch user B holding a cooldown (eligible_at in the
--    future), request_phone_change('<a-different-valid-number>') must raise
--    P0001 with message starting PHONE_CHANGE_COOLDOWN; same-number input
--    must report eligible=true.
-- ---------------------------------------------------------------------------
-- A: select * from public.phone_change_eligibility();
-- A: select * from public.request_phone_change('+8801812345678');
-- B (different number, gate held): expect ERROR P0001 PHONE_CHANGE_COOLDOWN.
-- B (same number): expect eligible=true, no cooldown restart (re-read
--    phone_change_eligible_at afterwards: unchanged).
