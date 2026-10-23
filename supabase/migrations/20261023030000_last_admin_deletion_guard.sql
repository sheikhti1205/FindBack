-- FindBack — the only admin account cannot be deleted.
--
-- The role RPCs already refuse to demote or revoke the last ADMIN
-- (20261022143000_roles_capabilities_invitations.sql:353, :791, :1053), but
-- account deletion reaches the same rows by a different road:
-- `delete-account` removes the auth user, `on_auth_user_deleted` removes
-- `public.users` (20260914140000_auth_profile_delete_cascade.sql:16), and
-- `user_roles.user_id` references it ON DELETE CASCADE. Nothing on that path
-- consults a role guard, so the single account that can manage roles could
-- delete itself and leave the app with nobody able to grant one. The bootstrap
-- allowlist is not a universal recovery path.
--
-- So this is a database invariant rather than a client courtesy: a BEFORE
-- DELETE trigger on `public.users` refuses the deletion while the row holds the
-- only ADMIN role, and says what to do instead. Deleting a moderator, a reader
-- with no role, or an admin while another admin exists is unchanged.
--
-- LIVE-PENDING. This migration has NOT been applied to any hosted project.
-- Everything below is verified on a DISPOSABLE PostgreSQL 17 only.
-- Verification pointer: supabase/tests/verify_20261023030000_last_admin_deletion_guard.sql
-- Static guard: supabase/tests/last_admin_deletion_guard_parity.test.mjs
--
-- ONE RULE, TWO CALLERS. The predicate ("this account holds ADMIN, and no
-- other account holds ADMIN") lives in exactly ONE function:
-- `public.findback_is_last_admin(text)`. The trigger and atomic begin-deletion
-- below both call it. The Edge invokes begin-deletion, NOT a separate preflight.
-- Two copies of the rule could
-- drift apart; one cannot. The refusal SENTENCE is written once in SQL and
-- once in TypeScript, and the static guard asserts the two strings are
-- byte-identical.
--
-- WHY ATOMIC ADMISSION EXISTS. The trigger alone refuses TOO LATE: `delete-account`
-- commits the storage fence (findback_begin_account_deletion) and sweeps
-- every photo, avatar and comment attachment BEFORE it deletes the profile
-- row, so a trigger refusal at that point leaves the last admin with no media
-- and no way to upload any again (`account_deletion_fences` has no un-fence
-- path and no delete grant — 20261014010000_account_deletion_storage_fence.sql:62).
-- Begin-deletion now checks under D1, snapshots provenance, removes authority,
-- records canonical audit and fences in ONE transaction. Refusal writes nothing.
-- A committed admission is unprivileged and pending even if Storage fails;
-- retry under the same verified UID reuses the receipt and never restores roles.
-- A legacy fence has NULL admission_id and must pass admission from scratch.
-- Table guards reject every role/capability acquisition for any fenced account,
-- including invitation attachment, bootstrap and direct service-role writes.
-- The
-- trigger stays as the client-independent backstop for every other deletion
-- road (auth.admin.deleteUser from anywhere, `on_auth_user_deleted`).
--
-- CONCURRENCY CONTRACT. The rule is evaluated under
-- `pg_advisory_xact_lock(20261022143000)` — the SAME key every role mutation
-- takes (20261022143000_roles_capabilities_invitations.sql:318, :562, :698,
-- :877, :1029). Without it, two admins deleting in separate transactions each
-- see the other and both succeed (write skew), and a concurrent
-- `findback_role_revoke` can slip between the count and the delete. With it,
-- admission and privilege removal are one critical section against role grants,
-- revokes and demotions. Lock order is D1 then Storage/account; no lock spans
-- external requests. Behavioral matrix: supabase/tests/verify_last_admin_admission.sql
-- and supabase/functions/delete-account/admission-sql.test.ts (disposable only).
--
-- RESIDUAL RISKS (known, NOT fixed here; not a consumer media-loss waiver).
--   * A direct `DELETE` on `public.user_roles` never reaches this trigger.
--     The role RPCs guard themselves, but `user_roles` carries no
--     `revoke ... from service_role` (20261022143000:220 revokes public, anon
--     and authenticated only), so a service-role caller can still empty the
--     admin set through PostgREST. A BEFORE DELETE trigger on `user_roles`
--     would close that, and would also fire on the FK cascade.
--   * `truncate public.users` / `truncate public.user_roles` does not fire
--     row triggers.
--   * `session_replication_role = replica` disables user triggers
--     (superuser only), and `drop trigger` is always possible for an operator.
--   * A read-only helper is NOT permission to sweep. Only a valid committed
--     admission receipt authorizes Storage work. Missing/lost responses stop.
--   * Zero-admin recovery may be possible for a surviving confirmed allowlisted
--     account. Absence of an admin alone does not prove bootstrap eligibility.
--
-- FORWARD-ONLY. This file changes no earlier migration. It extends the existing
-- fence, replaces its void begin helper with a receipt and adds acquisition
-- guards. Refusal raises a typed SQL error (also safe for old void adapters);
-- successes require a strict receipt in the new Edge. No hosted rollout is
-- authorized by this file.

begin;

-- Durable pending marker/correlation on the existing non-cascading fence.
-- NULL means a legacy fence, NOT a confirmed admission. Never auto-unfence.
alter table public.account_deletion_fences
  add column admission_id uuid,
  add column admitted_at timestamptz;
-- Preserve legacy user_id insertion, but service clients cannot forge a
-- committed admission receipt by populating the new marker themselves.
revoke insert on public.account_deletion_fences from service_role;
grant insert(user_id) on public.account_deletion_fences to service_role;

-- ---------------------------------------------------------------------------
-- 1. The rule, in one place.
--
-- Answers the only question the guard has to ask: "is this account the last
-- admin?" The trigger and the atomic admission both call it, so
-- the two can never drift apart.
-- ---------------------------------------------------------------------------
create or replace function public.findback_is_last_admin(p_user_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_holds_admin boolean;
  v_other_admins integer;
begin
  if p_user_id is null or p_user_id = '' then
    return false;
  end if;

  -- The SAME advisory lock every role mutation takes
  -- (20261022143000_roles_capabilities_invitations.sql:318, :562, :698, :877,
  -- :1029). Under it the two reads below cannot straddle a concurrent role
  -- grant, revoke or demotion, and two concurrent deletions cannot each see
  -- the other admin and both succeed.
  perform pg_catalog.pg_advisory_xact_lock(20261022143000);

  -- An account that holds ADMIN *and* MODERATOR holds ADMIN: the role table
  -- keys on (user_id, role) and nothing forbids both.
  select exists (
    select 1
      from public.user_roles r
     where r.user_id = p_user_id
       and r.role = 'ADMIN'
  ) into v_holds_admin;

  if not v_holds_admin then
    return false;
  end if;

  -- The count EXCLUDES the account being asked about: a count that included
  -- it would read 1 and never see a last admin.
  select count(*)
    into v_other_admins
    from public.user_roles r
   where r.role = 'ADMIN'
     and r.user_id <> p_user_id;

  return v_other_admins = 0;
end;
$$;

revoke all on function public.findback_is_last_admin(text) from public, anon, authenticated;
grant execute on function public.findback_is_last_admin(text) to service_role;
grant execute on function public.findback_is_last_admin(text) to postgres;

comment on function public.findback_is_last_admin(text) is
  'True when the account holds the only ADMIN role. One implementation shared by the final deletion trigger and atomic deletion admission. Service-role only.';

-- ---------------------------------------------------------------------------
-- 2. The trigger: the client-independent last line of defence, on every road
--    that deletes a `public.users` row (the edge function's delete, the auth
--    cascade, any `auth.admin.deleteUser`).
-- ---------------------------------------------------------------------------
create or replace function public.findback_guard_last_admin_deletion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The lock comes FIRST, so the check and the delete are one critical
  -- section: a concurrent role mutation or a second concurrent deletion
  -- cannot interleave and leave the app without an admin.
  perform pg_catalog.pg_advisory_xact_lock(20261022143000);

  -- The rule itself is the shared function above; it is not restated here.
  if public.findback_is_last_admin(old.id) then
    raise exception 'This is the only admin account. Promote another admin before deleting this one.'
      using errcode = '42501';
  end if;

  return old;
end;
$$;

revoke all on function public.findback_guard_last_admin_deletion() from public, anon, authenticated;

comment on function public.findback_guard_last_admin_deletion() is
  'Refuses to delete the last ADMIN account. Account deletion cascades user_roles, so the role RPC guards alone never see this path.';

drop trigger if exists users_guard_last_admin_deletion on public.users;

create trigger users_guard_last_admin_deletion
  before delete on public.users
  for each row execute function public.findback_guard_last_admin_deletion();

-- One database transaction is the authority BEFORE any external media work.
-- Lock order: D1 family, then account Storage lock (714). Storage policies only
-- take the latter; they never acquire D1. No lock spans a network request.
-- Return type changes from legacy void to a strictly validated receipt.
drop function public.findback_begin_account_deletion(text);
create function public.findback_begin_account_deletion(p_user_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_roles jsonb;
  v_capabilities jsonb;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'account required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(20261022143000);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id, 714));
  select admission_id into v_id from public.account_deletion_fences where user_id = p_user_id;
  if v_id is not null then
    -- Acquisition triggers make this state durable, even after the profile is
    -- gone. Retry must not repeat the audit or restore authority.
    if exists(select 1 from public.user_roles where user_id=p_user_id)
       or exists(select 1 from public.user_role_capabilities where user_id=p_user_id) then
      raise exception 'admission state inconsistent' using errcode='55000';
    end if;
    return jsonb_build_object('status','admitted','user_id',p_user_id,'admission_id',v_id);
  end if;
  if not exists(select 1 from public.users where id=p_user_id) then
    raise exception 'account unavailable' using errcode = '22023';
  end if;
  if public.findback_is_last_admin(p_user_id) then
    raise exception 'This is the only admin account. Promote another admin before deleting this one.'
      using errcode='42501', detail='LAST_ADMIN_DELETION_BLOCKED';
  end if;
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_roles
    from public.user_roles r where r.user_id=p_user_id;
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_capabilities
    from public.user_role_capabilities c where c.user_id=p_user_id;
  v_id := gen_random_uuid();
  delete from public.user_role_capabilities where user_id=p_user_id;
  delete from public.user_roles where user_id=p_user_id;
  insert into public.account_deletion_fences(user_id,admission_id,admitted_at)
    values(p_user_id,v_id,now()) on conflict(user_id) do update
    set admission_id=excluded.admission_id, admitted_at=excluded.admitted_at;
  perform public.findback_write_audit('account_deletion_admitted','user',p_user_id,
    'Confirmed self-service account deletion; privileges removed before media cleanup',
    jsonb_build_object('roles',v_roles,'capabilities',v_capabilities),
    jsonb_build_object('admission_id',v_id,'verified_user_id',p_user_id,
      'state','deletion_pending','privileges_removed',true));
  return jsonb_build_object('status','admitted','user_id',p_user_id,'admission_id',v_id);
end;
$$;
revoke all on function public.findback_begin_account_deletion(text) from public, anon, authenticated;
grant execute on function public.findback_begin_account_deletion(text) to service_role, postgres;
comment on function public.findback_begin_account_deletion(text) is
  'Atomic deletion admission: D1 then Storage lock; refuse last admin before writes, otherwise remove privileges, audit and fence. Idempotent receipt; legacy fences revalidated. Never restore/unfence on partial failure.';

-- Shared table-boundary guards cover RPC grant/capability edits, invitation
-- attachment, bootstrap, direct service-role INSERT/UPDATE and future writers.
create function public.findback_guard_deletion_pending_acquisition()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(20261022143000);
  -- FK ON DELETE SET NULL changes another account's grant attribution, not
  -- its authority. Preserve subject + role/capability (and any future fields),
  -- excluding only grant metadata. A simultaneous authority change must still
  -- pass the fence check; INSERT/UPSERT attempts are never exempt.
  if tg_op = 'UPDATE' and
     (to_jsonb(new) - 'granted_by' - 'granted_at') is not distinct from
     (to_jsonb(old) - 'granted_by' - 'granted_at') then
    return new;
  end if;
  if exists(select 1 from public.account_deletion_fences where user_id=new.user_id) then
    raise exception 'Account deletion is pending. This account cannot receive privileges.' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.findback_guard_deletion_pending_acquisition() from public,anon,authenticated;
create trigger user_roles_deletion_pending before insert or update on public.user_roles
  for each row execute function public.findback_guard_deletion_pending_acquisition();
create trigger user_capabilities_deletion_pending before insert or update on public.user_role_capabilities
  for each row execute function public.findback_guard_deletion_pending_acquisition();

create function public.findback_guard_deletion_pending_invitation()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(20261022143000);
  -- Invite attribution cleanup cannot attach/reactivate an invitation. Keep
  -- email, role, capabilities, id, accepted/revoked state (and future fields)
  -- in the comparison, so attribution cannot disguise an acquisition.
  if tg_op = 'UPDATE' and
     (to_jsonb(new) - 'invited_by' - 'invited_at') is not distinct from
     (to_jsonb(old) - 'invited_by' - 'invited_at') then
    return new;
  end if;
  if new.accepted_at is null and new.revoked_at is null and exists(
    select 1 from public.users u join public.account_deletion_fences f on f.user_id=u.id
    where lower(btrim(u.email))=lower(btrim(new.email))
  ) then
    raise exception 'Account deletion is pending. This account cannot receive privileges.' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.findback_guard_deletion_pending_invitation() from public,anon,authenticated;
create trigger role_invitations_deletion_pending before insert or update on public.role_invitations
  for each row execute function public.findback_guard_deletion_pending_invitation();

commit;
