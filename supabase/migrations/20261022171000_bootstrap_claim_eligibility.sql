-- FindBack — the admin-claim eligibility question, asked of the server.
--
-- WHY THIS FILE EXISTS.
-- The one-time admin claim already exists and is correct:
-- `public.findback_bootstrap_admin()`
-- (20261022143000_roles_capabilities_invitations.sql) is a definer function
-- that takes the advisory lock, requires a VERIFIED address, requires the
-- address to be in `bootstrap_admins`, refuses while any ADMIN row exists,
-- writes exactly one audit row and grants nothing to anon.
--
-- What was missing is the SURFACE. The owner read the hosted project back on
-- 2026-10-22 and found two allowlisted owner addresses, no account holding
-- ADMIN, and a live but unaccepted moderator invitation. The staff console is
-- ADMIN-only, so the owner had no way to become an admin from the app: the
-- server could grant the role, but no screen ever asked it to.
--
-- A client that guesses is not allowed to guess. If the app decided on its own
-- whether the reader may claim, it would either offer a button that the server
-- refuses (a dead end the owner cannot understand) or hide the button from the
-- one person who is allowed to use it. The eligibility question is therefore
-- answered HERE, by the server, about the caller, and the client only renders
-- the answer it is given.
--
-- WHAT THIS FUNCTION ANSWERS (and ONLY this).
--   can_claim     — may THIS caller make the one-time claim right now?
--   reason        — the sentence explaining why not, or null when it may.
--   already_admin — does THIS caller already hold ADMIN?
--   has_admin     — does ANY account hold ADMIN (the claim's own gate)?
--
-- WHAT IT DELIBERATELY DOES NOT ANSWER.
--   * It does not reveal the allowlist. The allowlist is consulted with an
--     existence test on the CALLER's own address, so a caller learns only
--     whether THEIR address is on it. No list, no count, no other address.
--   * It does not reveal another account. No user id, no email, no username
--     of anybody else is read or returned.
--   * It does not reveal another account's role or capabilities. The only
--     role facts here are two booleans: whether the CALLER is an admin, and
--     whether ANY admin exists — the second of which the claim itself reveals
--     in its refusal sentence.
--
-- ONE SOURCE OF TRUTH FOR THE REFUSAL SENTENCES.
-- The reason strings are BYTE-IDENTICAL to the sentences
-- `findback_bootstrap_admin()` raises, and they are evaluated in the SAME
-- ORDER, so the surface and the action can never disagree about why a claim
-- is refused. The existing claim migration is applied and must never be
-- edited, so the binding is enforced by a static parity test
-- (supabase/tests/bootstrap_claim_eligibility_parity.test.mjs), which fails
-- the moment a sentence drifts in either file.
--
-- A READ, NOT A CLAIM.
-- This function takes no lock and writes nothing: it is `stable` and only
-- reads. The claim re-checks every condition under
-- `pg_advisory_xact_lock(20261022143000)` before it grants anything, so a
-- status read that races a claim can only be stale — never permissive. The
-- caller of the claim is the authority, always.
--
-- STATUS. This migration has NOT been applied to the hosted project. The
-- behavioural verifier
-- (supabase/tests/verify_20261022171000_bootstrap_claim_eligibility.sql)
-- runs against a DISPOSABLE local PostgreSQL 17 with the whole migration chain
-- applied; its output is the only evidence, and it is not hosted acceptance.
--
-- Static guard: supabase/tests/bootstrap_claim_eligibility_parity.test.mjs

begin;

create or replace function public.findback_bootstrap_claim_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_email text;
  v_verified integer;
  v_caller_is_admin boolean := false;
  v_any_admin boolean := false;
  v_reason text := null;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- The CALLER's own profile row: the address and whether it is confirmed.
  select lower(btrim(u.email)), u.email_verified
    into v_email, v_verified
    from public.users u
   where u.id = v_uid;

  -- Two booleans, both about roles and neither about anybody's identity:
  -- whether the caller is an admin, and whether any admin exists at all.
  select exists (
           select 1 from public.user_roles r
            where r.user_id = v_uid and r.role = 'ADMIN'
         ),
         exists (
           select 1 from public.user_roles r
            where r.role = 'ADMIN'
         )
    into v_caller_is_admin, v_any_admin;

  -- THE SAME ORDER AND THE SAME SENTENCES AS THE CLAIM.
  -- findback_bootstrap_admin() checks, in this order: no address, address not
  -- confirmed, address not on the allowlist, an admin already exists. The
  -- status answers with the claim's own sentences for the same conditions, so
  -- the screen can never promise a claim the server will refuse for a
  -- different reason, nor hide a claim the server would allow.
  if v_email is null or v_email = '' then
    v_reason := 'This account has no email address, so it cannot claim the admin role';
  elsif coalesce(v_verified, 0) <> 1 then
    v_reason := 'Confirm your email address before claiming the admin role';
  elsif not exists (
    select 1 from public.bootstrap_admins b
     where lower(btrim(b.email)) = v_email
  ) then
    v_reason := 'This account is not in the admin bootstrap list';
  elsif v_any_admin then
    v_reason := 'An admin already exists';
  end if;

  return jsonb_build_object(
    'can_claim', v_reason is null,
    'reason', v_reason,
    'already_admin', v_caller_is_admin,
    'has_admin', v_any_admin
  );
end;
$$;

revoke all on function public.findback_bootstrap_claim_status() from public, anon;
grant execute on function public.findback_bootstrap_claim_status() to authenticated;

comment on function public.findback_bootstrap_claim_status() is
  'FindBack admin-claim eligibility (definer, stable, read-only): answers ONLY about the caller — can_claim, reason, already_admin, has_admin. The reason sentences are the ones findback_bootstrap_admin() raises, in the same order. The allowlist is consulted by existence on the address of the caller, so neither the list nor the identity of anybody else is revealed.';

commit;
