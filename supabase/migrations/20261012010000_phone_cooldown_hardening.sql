-- FindBack — phone-change cooldown hardening (follow-up to 20261012000000).
--
-- ADDITIVE ONLY. The Supabase GitHub integration auto-applies migrations on
-- push, so this file must be safe to run once against the live schema: one
-- new IMMUTABLE helper, two same-signature RPC recreations (grants carried
-- over unchanged), no column drops, no row rewrites, no user/auth data
-- removal, no edits to any applied migration.
-- LIVE-PENDING (owner-deferred, 2026-10-12): verify on the live project
-- before PASS — see supabase/tests/verify_20261012010000_phone_cooldown.sql
-- (no live run ships in this change):
--   (a) phone_change_eligibility responds for a caller with and without
--       recorded cooldown state;
--   (b) request_phone_change still rejects a different verified phone with
--       PHONE_CHANGE_COOLDOWN + eligible_at while first/same-phone succeeds;
--   (c) a corrupt phone_change_eligible_at value reads as eligible instead
--       of raising an unhandled 500 (safe-parse path).
--
-- WHY (gap vs spec 25, found comparing 20261012000000 against the spec):
--   1. Corrupt-eligible_at 500. The base gate compares
--      `(now() ...) < (v_eligible_at)::timestamptz` with no guard. One
--      malformed stored value (anything that is not a castable timestamptz)
--      aborts the gate with an unhandled data_exception instead of resolving
--      to eligible-or-cooldown. The eligibility read caught only
--      invalid_datetime_format; other cast failures (e.g. out-of-range)
--      escaped there too. Both RPCs now parse through a single
--      server-owned safe helper that yields NULL on ANY garbage, and NULL
--      means "no recorded gate" (eligible) — a corrupt value can never lock
--      an account out, nor can it bypass a real gate (real gates are always
--      written by the trigger in canonical ISO form).
--   2. Concurrent-gate race. Spec 25 requires two replacement attempts to be
--      unable to both win. The final commit was already serialized through
--      the trigger-maintained row state, but the advisory gate itself
--      evaluated concurrently: two request_phone_change calls could both
--      observe "eligible" before either challenge completed. The gate now
--      takes a per-account transaction-scoped advisory lock first, so
--      concurrent evaluations for the same uid serialize; the device clock
--      still cannot affect the outcome (server now() only), OTP failure
--      still leaves the old phone and eligibility untouched (the gate writes
--      nothing — only the verified-replacement trigger restamps), and
--      first/same-phone still never wait and never restart the clock.
--
-- ---------------------------------------------------------------------------
-- 1. Safe eligible-at parse. IMMUTABLE, server-owned, no grants: only the
--    two SECURITY DEFINER RPCs below call it.
-- ---------------------------------------------------------------------------
create or replace function public.findback_safe_eligible_at(p_eligible_at text)
returns timestamptz
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_eligible_at is null or nullif(btrim(p_eligible_at), '') is null then
    return null;
  end if;
  return (p_eligible_at)::timestamptz;
exception when others then
  return null;
end;
$$;

revoke all on function public.findback_safe_eligible_at(text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Self-only eligibility read (same signature/shape/grants as the base).
--    Eligible when nothing is recorded, when the recorded date no longer
--    parses (safe helper -> NULL), or when server now() has reached it.
-- ---------------------------------------------------------------------------
create or replace function public.phone_change_eligibility()
returns table (
  eligible boolean,
  eligible_at text,
  phone_verified boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := public.findback_uid();
  v_eligible_at text;
  v_verified boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select u.phone_change_eligible_at, coalesce(u.phone_verified, 0) <> 0
    into v_eligible_at, v_verified
    from public.users u
   where u.id = v_uid;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;

  if public.findback_safe_eligible_at(v_eligible_at) is null then
    return query select true, null::text, v_verified;
    return;
  end if;

  return query select
    (now() at time zone 'utc') >= public.findback_safe_eligible_at(v_eligible_at),
    v_eligible_at,
    v_verified;
end;
$$;

revoke all on function public.phone_change_eligibility() from public;
revoke execute on function public.phone_change_eligibility() from anon;
grant execute on function public.phone_change_eligibility() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Server-authoritative replacement gate (same signature/shape/grants).
--    Per-account advisory xact lock serializes concurrent gate evaluations;
--    the lock dies with the transaction, so a crashed caller holds nothing.
-- ---------------------------------------------------------------------------
create or replace function public.request_phone_change(p_new_phone text)
returns table (
  eligible boolean,
  eligible_at text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     text := public.findback_uid();
  v_desired text := public.findback_normalize_bd_phone(coalesce(p_new_phone, ''));
  v_phone   text;
  v_verified integer;
  v_eligible_at text;
  v_gate timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_desired is null then
    raise exception 'invalid phone' using errcode = '22023';
  end if;

  -- Serialize concurrent gate evaluations for this account. The final commit
  -- stays trigger/row-serialized; this only stops two challengers from both
  -- observing "eligible" at once.
  perform pg_advisory_xact_lock(hashtext('fb-phone-change:' || v_uid));

  select u.phone, coalesce(u.phone_verified, 0), u.phone_change_eligible_at
    into v_phone, v_verified, v_eligible_at
    from public.users u
   where u.id = v_uid;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;

  -- Never verified: first phone, no prior wait.
  if v_verified <> 1 then
    return query select true, null::text;
    return;
  end if;

  -- Same normalized number reverification: allowed under OTP policy, no
  -- cooldown restart.
  if public.findback_normalize_bd_phone(coalesce(v_phone, '')) = v_desired then
    return query select true, null::text;
    return;
  end if;

  -- Different verified replacement before the recorded date: reject on the
  -- server clock with the stable marker and the eligible date. A corrupt
  -- stored value parses to NULL (eligible) instead of raising 500.
  v_gate := public.findback_safe_eligible_at(v_eligible_at);
  if v_gate is not null
     and (now() at time zone 'utc') < v_gate then
    raise exception 'PHONE_CHANGE_COOLDOWN eligible_at=%', v_eligible_at using errcode = 'P0001';
  end if;

  return query select true, null::text;
end;
$$;

revoke all on function public.request_phone_change(text) from public;
revoke execute on function public.request_phone_change(text) from anon;
grant execute on function public.request_phone_change(text) to authenticated;
