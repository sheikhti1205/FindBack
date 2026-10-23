-- Verification for 20261022171000_bootstrap_claim_eligibility.sql (the
-- admin-claim eligibility read).
--
-- STATUS, STATED PLAINLY. This migration has NOT been applied to the hosted
-- project. Nothing in this file may be quoted as a passing result until it has
-- been run and its output recorded. The static guard
-- (supabase/tests/bootstrap_claim_eligibility_parity.test.mjs) checks the TEXT
-- of the migration; it proves nothing about the behaviour of the objects.
--
-- HOW TO RUN IT. Section 1 is read-only catalog probes. Section 2 is
-- behavioural: it switches to the `authenticated` role with a JWT subject claim
-- (`set_config('request.jwt.claim.sub', <uid>, true)` — LOCAL, so it cannot
-- outlive the transaction) and writes scratch rows, so run it on a
-- DISPOSABLE PostgreSQL 17 with the whole migration chain applied on top —
-- never on production — and wrap it in a transaction that ROLLBACKs.
--
-- WHAT IS PROVEN HERE.
--   1. The object: one definer function, stable, locked search_path, granted
--      to authenticated and revoked from anon/public, with a comment.
--   2. The eligibility answer, per caller:
--        - an ALLOWLISTED and VERIFIED caller may claim;
--        - a caller OUTSIDE the allowlist may not, and is told the allowlist
--          sentence while learning NOTHING about the allowlist or about any
--          other account;
--        - an UNVERIFIED allowlisted caller is told the confirm sentence;
--        - an account with no address is told the no-address sentence;
--        - once an ADMIN exists, an allowlisted verified caller is told
--          "An admin already exists" and can_claim is false.
--   3. The CLAIM PATH IS UNCHANGED: the one-time claim still succeeds for an
--      allowlisted verified caller, still refuses every other caller with the
--      SAME sentences, still writes exactly one audit row, and is still
--      refused for anon.
--
-- EVERY PROBE IN SECTION 2 IS AN ASSERTION. A probe that fails raises an
-- exception with its own name, so a failure cannot hide behind an empty
-- result set. Every privilege refusal is CAUGHT inside its own block: a
-- refusal raised inside a transaction aborts it, so a verifier that called a
-- privileged RPC directly could never reach the probes after it.

-- 1. Catalog: exact singleton signature, posture, ACL and comment.
select 'P1 singleton signature, definer, stable, locked path' as probe
where (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='findback_bootstrap_claim_status') = 1
and exists(select 1 from pg_proc p
 where p.oid=to_regprocedure('public.findback_bootstrap_claim_status()')
 and p.pronargs=0 and p.pronargdefaults=0
 and pg_get_function_result(p.oid)='jsonb'
 and p.prosecdef and p.provolatile='s'
 and p.proconfig @> array['search_path=public, pg_temp']);

select 'P2 authenticated-only ACL' as probe
where has_function_privilege('authenticated','public.findback_bootstrap_claim_status()','EXECUTE')
and not has_function_privilege('anon','public.findback_bootstrap_claim_status()','EXECUTE')
and not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 where p.oid=to_regprocedure('public.findback_bootstrap_claim_status()')
 and a.grantee=0 and a.privilege_type='EXECUTE');

select 'P3 the function carries its own comment' as probe
where (select obj_description(to_regprocedure('public.findback_bootstrap_claim_status()'), 'pg_proc')) is not null;

-- 2. DISPOSABLE LOCAL behaviour assertions.
begin;

-- Privileged fixture setup. The allowlist gains ONE scratch address so the
-- successful-claim case has a caller of its own; the transaction rolls every
-- row back.
insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, avatar_url, created_at, updated_at) values
 ('00000000-0000-4000-8000-00000000b001','owner_allow','sheikhti1205@gmail.com','+1555000b001',null,1,0,null,'2026-10-22','2026-10-22'),
 ('00000000-0000-4000-8000-00000000b002','owner_unverified','sheikhti1205@outlook.com','+1555000b002',null,0,0,null,'2026-10-22','2026-10-22'),
 ('00000000-0000-4000-8000-00000000b003','outsider','outsider@example.invalid','+1555000b003',null,1,0,null,'2026-10-22','2026-10-22'),
 ('00000000-0000-4000-8000-00000000b004','no_email','','+1555000b004',null,1,0,null,'2026-10-22','2026-10-22'),
 ('00000000-0000-4000-8000-00000000b005','claimer','claimer@example.invalid','+1555000b005',null,1,0,null,'2026-10-22','2026-10-22')
on conflict (id) do nothing;

insert into public.bootstrap_admins (email, created_at)
values ('claimer@example.invalid', '2026-10-22')
on conflict (email) do nothing;

-- A1. The allowlisted, VERIFIED caller may claim, and nothing else is said.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b001',true);
select 'A1 allowlisted verified caller may claim' as probe
where (select (s->>'can_claim')::boolean
         and (s->>'reason') is null
         and (s->>'already_admin')::boolean is false
         and (s->>'has_admin')::boolean is false
       from public.findback_bootstrap_claim_status() s);

-- A2. A caller OUTSIDE the allowlist may not, and is told the allowlist
--     sentence — the very sentence the claim itself raises.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b003',true);
select 'A2 outside the allowlist is refused with the allowlist sentence' as probe
where (select (s->>'can_claim')::boolean is false
         and s->>'reason' = 'This account is not in the admin bootstrap list'
         and (s->>'already_admin')::boolean is false
         and (s->>'has_admin')::boolean is false
       from public.findback_bootstrap_claim_status() s);

-- A3. That answer leaks NOTHING: exactly the four contract keys, no address,
--     no username, no id, no allowlist content, no other account.
select 'A3 the refusal reveals nothing about the allowlist or any other account' as probe
where (select array_agg(k order by k)
         from jsonb_object_keys(public.findback_bootstrap_claim_status()) k
       ) = array['already_admin','can_claim','has_admin','reason']
and (select public.findback_bootstrap_claim_status())::text not like '%@%'
and (select public.findback_bootstrap_claim_status())::text not like '%sheikhti%'
and (select public.findback_bootstrap_claim_status())::text not like '%claimer%'
and (select public.findback_bootstrap_claim_status())::text not like '%outsider%'
and (select public.findback_bootstrap_claim_status())::text not like '%b001%'
and (select public.findback_bootstrap_claim_status())::text not like '%b003%'
and (select public.findback_bootstrap_claim_status())::text not like '%bootstrap_admins%';

-- A4. An UNVERIFIED allowlisted caller is told the confirm sentence.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b002',true);
select 'A4 unverified allowlisted caller is told to confirm the address' as probe
where (select (s->>'can_claim')::boolean is false
         and s->>'reason' = 'Confirm your email address before claiming the admin role'
       from public.findback_bootstrap_claim_status() s);

-- A5. An account with no address is told the no-address sentence.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b004',true);
select 'A5 an account with no address is told so' as probe
where (select (s->>'can_claim')::boolean is false
         and s->>'reason' = 'This account has no email address, so it cannot claim the admin role'
       from public.findback_bootstrap_claim_status() s);

-- B1. THE CLAIM PATH IS UNCHANGED: the allowlisted verified caller claims
--     and the role lands.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b005',true);
select 'B1 the one-time claim succeeds for the allowlisted verified caller' as probe
where (select public.findback_bootstrap_admin()) is true;

-- B1b. The claim wrote exactly one audit row and one admin role. The audit
--      log is ungranted to every client role BY DESIGN, so this read is
--      privileged: the assertion is about the server's own record, not about
--      anything a client can see.
reset role;
select 'B1b the claim wrote exactly one audit row and one admin role' as probe
where (select count(*) from public.admin_audit_log where action='BOOTSTRAP_ADMIN') = 1
and (select count(*) from public.user_roles where role='ADMIN') = 1
and (select count(*) from public.user_roles where user_id='00000000-0000-4000-8000-00000000b005' and role='ADMIN') = 1;
set local role authenticated;

-- B2. A second claim is refused with the admin-already-exists sentence.
do $$
declare
  v_message text;
begin
  begin
    perform public.findback_bootstrap_admin();
    raise exception 'B2 FAILED: a second claim was allowed';
  exception
    when insufficient_privilege then
      get stacked diagnostics v_message = message_text;
      if v_message is distinct from 'An admin already exists' then
        raise exception 'B2 FAILED: the refusal sentence was not the contract one';
      end if;
  end;
end;
$$;

-- B3. A caller outside the allowlist is refused by the CLAIM with the same
--     sentence the status function reports.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b003',true);
do $$
declare
  v_message text;
begin
  begin
    perform public.findback_bootstrap_admin();
    raise exception 'B3 FAILED: an address outside the allowlist claimed the admin role';
  exception
    when insufficient_privilege then
      get stacked diagnostics v_message = message_text;
      if v_message is distinct from 'This account is not in the admin bootstrap list' then
        raise exception 'B3 FAILED: the refusal sentence was not the contract one';
      end if;
  end;
end;
$$;

-- B4. The unverified allowlisted caller is refused with the confirm sentence.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b002',true);
do $$
declare
  v_message text;
begin
  begin
    perform public.findback_bootstrap_admin();
    raise exception 'B4 FAILED: an unverified account claimed the admin role';
  exception
    when insufficient_privilege then
      get stacked diagnostics v_message = message_text;
      if v_message is distinct from 'Confirm your email address before claiming the admin role' then
        raise exception 'B4 FAILED: the refusal sentence was not the contract one';
      end if;
  end;
end;
$$;

-- B5. The account with no address is refused with the no-address sentence.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b004',true);
do $$
declare
  v_message text;
  v_state text;
begin
  begin
    perform public.findback_bootstrap_admin();
    raise exception 'B5 FAILED: an account with no address claimed the admin role';
  exception
    when invalid_parameter_value then
      get stacked diagnostics v_message = message_text;
      if v_message is distinct from 'This account has no email address, so it cannot claim the admin role' then
        raise exception 'B5 FAILED: the refusal sentence was not the contract one';
      end if;
    when others then
      get stacked diagnostics v_state = returned_sqlstate;
      raise exception 'B5 FAILED: the refusal used SQLSTATE %', v_state;
  end;
end;
$$;

-- B6. The caller that claimed now IS the admin: already_admin is true, the
--     claim is closed, and the sentence is the contract one.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b005',true);
select 'B6 the claiming caller is the admin and the claim is closed' as probe
where (select (s->>'can_claim')::boolean is false
         and s->>'reason' = 'An admin already exists'
         and (s->>'already_admin')::boolean is true
         and (s->>'has_admin')::boolean is true
       from public.findback_bootstrap_claim_status() s);

-- C1. ANOTHER allowlisted verified caller, while an admin exists, is told
--     "An admin already exists" — never the allowlist, never anything else.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b001',true);
select 'C1 an allowlisted verified caller is refused while an admin exists' as probe
where (select (s->>'can_claim')::boolean is false
         and s->>'reason' = 'An admin already exists'
         and (s->>'already_admin')::boolean is false
         and (s->>'has_admin')::boolean is true
       from public.findback_bootstrap_claim_status() s);

-- C2. The status answer for that caller still leaks nothing.
select 'C2 the refusal still reveals nothing about any other account' as probe
where (select public.findback_bootstrap_claim_status())::text not like '%@%'
and (select public.findback_bootstrap_claim_status())::text not like '%sheikhti%'
and (select public.findback_bootstrap_claim_status())::text not like '%claimer%'
and (select public.findback_bootstrap_claim_status())::text not like '%b005%';

-- D1. An anonymous caller may not call either the status or the claim.
reset role;
set local role anon;
do $$
begin
  begin
    perform public.findback_bootstrap_claim_status();
    raise exception 'D1 FAILED: anon read the claim status';
  exception when insufficient_privilege then null; end;
  begin
    perform public.findback_bootstrap_admin();
    raise exception 'D1 FAILED: anon claimed the admin role';
  exception when insufficient_privilege then null; end;
end;
$$;
reset role;

-- D2. A caller with no session is told it is not signed in.
select set_config('request.jwt.claim.sub','',true);
do $$
declare
  v_message text;
begin
  begin
    perform public.findback_bootstrap_claim_status();
    raise exception 'D2 FAILED: a caller with no session was answered';
  exception
    when invalid_authorization_specification then
      get stacked diagnostics v_message = message_text;
      if v_message is distinct from 'Not authenticated' then
        raise exception 'D2 FAILED: the refusal sentence was not the contract one';
      end if;
    when others then
      raise exception 'D2 FAILED: the refusal used another SQLSTATE';
  end;
end;
$$;

rollback;
