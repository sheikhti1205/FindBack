-- FindBack — roles, the per-moderator capability matrix, email invitations and
-- the one-time admin claim.
--
-- WHY THIS FILE EXISTS.
-- The owner asked for ONE admin account and ONE moderator account by default,
-- for the admin to assign moderators BY EMAIL (people are hired through
-- Discord and granted their role in the app), and for the admin to hold
-- ABSOLUTE control over what each moderator may do — everything a moderator
-- holds, plus the management of the roles themselves.
--
-- The accepted moderation decision (MC §7 C6) fixes the ROLE model:
--
--   D34  public.user_roles is the role source; USER is implicit. There is no
--        role column on users, because that column would be client-writable.
--   D35  findback_has_role(p_role) is a definer, stable boolean predicate
--        consulted by every privileged object. The role is NOT a JWT claim,
--        so a revoked moderator loses power immediately.
--   D36  The moderation objects are ungranted to anon/authenticated, have RLS
--        enabled, and every privileged read/write is a role-guarded definer
--        RPC. Hiding admin behind a client check is forbidden.
--   D37  admin_audit_log is the append-only action and audit record.
--
-- The owner amendment (CONTRACT-ROLES-ADMIN-2026-10-22.md §2) adds the
-- CAPABILITY layer on top of the flat role:
--
--   A2.1  user_role_capabilities is a sibling relation, not a JSON blob: the
--         admin decides, per moderator, exactly what that moderator may do.
--   A2.2  ADMIN implies every capability; findback_can() is the ONE predicate
--         so that no caller can forget a branch.
--   A2.3  Assignment is by EMAIL: role_invitations holds the pending grant,
--         an invitation is consumed when the person signs up, and a revoke
--         takes effect immediately.
--   A2.4  The default accounts: the two admin emails are seeded into a
--         bootstrap allowlist (the first claim is atomic and audited), and the
--         first moderator is seeded as a pending invitation with the owner's
--         default capability set. NO password, token or secret is ever stored:
--         a row carries an email address, a role and a capability set.
--   A2.6  Server authority: every privileged RPC re-checks role AND
--         capability at call time.
--
-- FORWARD-ONLY. This file only ADDS objects; it changes no existing shipped
-- object. In particular the signup trigger function is NOT re-created here:
-- it stays byte-compatible with what is deployed.
--
-- WHEN AN INVITATION IS CONSUMED (the fix of an unverified sign-up burning
-- it). An invitation is consumed at ONE of two VERIFIED moments:
--
--   1. the address is confirmed (auth.users.email_confirmed_at goes from
--      null to a value), or
--   2. a verified profile row appears for the account (public.users with
--      email_verified = 1) — the path a social sign-in takes.
--
-- It is NOT consumed on the auth.users INSERT, because that insert happens
-- before the address is confirmed: anybody able to type the invited address
-- would otherwise destroy the invitation before the invitee ever sees it.
--
-- NO `now_text()` HELPER EXISTS in this chain: the UTC text expression is
-- inlined everywhere.
--
-- Verification pointer: supabase/tests/verify_20261022143000_roles_capabilities.sql
-- Static guard: supabase/tests/roles_capabilities_parity.test.mjs

begin;

-- ---------------------------------------------------------------------------
-- 1. The capability vocabulary (one place, so every surface agrees).
-- ---------------------------------------------------------------------------

-- The moderator-assignable capabilities (A2.1).
create or replace function public.findback_capability_vocabulary()
returns text[]
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select array[
    'reports_review',
    'content_hide',
    'content_remove',
    'members_warn',
    'members_restrict',
    'members_suspend',
    'feedback_read',
    'appeals_review',
    'audit_read',
    'matches_confirm',
    'roles_manage',
    'settings_manage',
    'data_export',
    'data_delete'
  ];
$$;

revoke all on function public.findback_capability_vocabulary() from public, anon;
grant execute on function public.findback_capability_vocabulary() to authenticated;

comment on function public.findback_capability_vocabulary() is
  'FindBack capability vocabulary (read-only): the ten moderator-assignable capabilities plus the four admin-only ones (roles_manage, settings_manage, data_export, data_delete).';

-- The admin-only capabilities: never assignable to a moderator (A2.1).
create or replace function public.findback_admin_capabilities()
returns text[]
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select array['roles_manage', 'settings_manage', 'data_export', 'data_delete'];
$$;

revoke all on function public.findback_admin_capabilities() from public, anon;
grant execute on function public.findback_admin_capabilities() to authenticated;

comment on function public.findback_admin_capabilities() is
  'FindBack admin-only capabilities: roles_manage, settings_manage, data_export, data_delete. An ADMIN holds them implicitly; a moderator can never be granted one.';

-- ---------------------------------------------------------------------------
-- 2. The role source (D34) and the capability matrix (A2.1).
-- ---------------------------------------------------------------------------

create table if not exists public.user_roles (
  user_id    text not null references public.users(id) on delete cascade,
  role       text not null check (role in ('MODERATOR', 'ADMIN')),
  granted_by text null references public.users(id) on delete set null,
  granted_at text not null,
  primary key (user_id, role)
);

create table if not exists public.user_role_capabilities (
  user_id    text not null references public.users(id) on delete cascade,
  -- The vocabulary is spelled out HERE, not as a call to the vocabulary
  -- function: a `create or replace` of that function would otherwise widen
  -- the accepted set without re-validating the rows already stored.
  -- supabase/tests/roles_capabilities_parity.test.mjs proves the three
  -- copies of this list — this constraint, the vocabulary function and the
  -- client's ALL_CAPABILITIES — are the same set, element for element.
  capability text not null check (capability in (
    'reports_review',
    'content_hide',
    'content_remove',
    'members_warn',
    'members_restrict',
    'members_suspend',
    'feedback_read',
    'appeals_review',
    'audit_read',
    'matches_confirm',
    'roles_manage',
    'settings_manage',
    'data_export',
    'data_delete'
  )),
  granted_by text null references public.users(id) on delete set null,
  granted_at text not null,
  primary key (user_id, capability)
);

-- The email-first pending grant (A2.3).
create table if not exists public.role_invitations (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  role         text not null check (role in ('MODERATOR', 'ADMIN')),
  -- A pending invitation may never carry a capability outside the
  -- vocabulary: the column has no other guard.
  capabilities text[] not null default '{}' check (capabilities <@ array[
    'reports_review',
    'content_hide',
    'content_remove',
    'members_warn',
    'members_restrict',
    'members_suspend',
    'feedback_read',
    'appeals_review',
    'audit_read',
    'matches_confirm',
    'roles_manage',
    'settings_manage',
    'data_export',
    'data_delete'
  ]),
  invited_by   text null references public.users(id) on delete set null,
  invited_at   text not null,
  accepted_at  text null,
  revoked_at   text null
);

-- One live invitation per email address.
create unique index if not exists ux_role_invitations_live_email
  on public.role_invitations (lower(btrim(email)))
  where accepted_at is null and revoked_at is null;

-- The admin bootstrap allowlist (A2.4).
create table if not exists public.bootstrap_admins (
  email      text primary key,
  created_at text not null
);

-- The append-only audit record (D37).
create table if not exists public.admin_audit_log (
  id            text primary key default gen_random_uuid()::text,
  actor_user_id text null references public.users(id) on delete set null,
  action        text not null,
  target_type   text not null,
  target_id     text not null,
  reason        text,
  previous_state jsonb,
  new_state      jsonb,
  created_at    text not null
);

-- D36: the moderation objects are ungranted to the consumer roles and carry
-- RLS with no policy. The privileged RPCs below are the only way in.
alter table public.user_roles enable row level security;
alter table public.user_role_capabilities enable row level security;
alter table public.role_invitations enable row level security;
alter table public.bootstrap_admins enable row level security;
alter table public.admin_audit_log enable row level security;

revoke all on table public.user_roles from public, anon, authenticated;
revoke all on table public.user_role_capabilities from public, anon, authenticated;
revoke all on table public.role_invitations from public, anon, authenticated;
revoke all on table public.bootstrap_admins from public, anon, authenticated;
revoke all on table public.admin_audit_log from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The audit writer (D37). Append-only: no UPDATE, no DELETE.
-- ---------------------------------------------------------------------------

create or replace function public.findback_write_audit(
  p_action text,
  p_target_type text,
  p_target_id text,
  p_reason text default null,
  p_previous_state jsonb default null,
  p_new_state jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.admin_audit_log (
    id, actor_user_id, action, target_type, target_id, reason,
    previous_state, new_state, created_at
  ) values (
    gen_random_uuid()::text,
    auth.uid()::text,
    p_action,
    p_target_type,
    p_target_id,
    p_reason,
    p_previous_state,
    p_new_state,
    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

revoke all on function public.findback_write_audit(text, text, text, text, jsonb, jsonb) from public, anon, authenticated;

comment on function public.findback_write_audit(text, text, text, text, jsonb, jsonb) is
  'FindBack audit writer (definer, internal): appends exactly one admin_audit_log row. The log is append-only — there is no UPDATE or DELETE path for any client role.';

-- ---------------------------------------------------------------------------
-- 4. Consuming a pending invitation (A2.3).
-- ---------------------------------------------------------------------------

create or replace function public.findback_attach_pending_role(p_user_id text, p_email text default null)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  -- The invitation is read into SCALARS, never into the composite row type:
  -- a composite target is filled BY POSITION, so a four-column list would
  -- pour the text[] capability column into the row's text role column and
  -- raise "cannot cast type text[] to text" on every single call.
  v_inv_id uuid;
  v_inv_role text;
  v_inv_caps text[];
  v_inv_by text;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_capability text;
  v_admin_count integer;
begin
  if p_user_id is null then
    return;
  end if;

  -- The role row references the account, so the profile row must exist
  -- before anything can be attached. When it does not (a social sign-in
  -- that has not completed its profile yet) the invitation is left LIVE:
  -- it is consumed when the verified profile row appears.
  if not exists (select 1 from public.users u where u.id = p_user_id) then
    return;
  end if;

  -- The address is the invitation's key. When the caller does not carry it,
  -- it is read from the account's own profile row — which is why this
  -- helper is not a no-op when it is called with only the account id.
  if v_email = '' then
    select lower(btrim(u.email)) into v_email
      from public.users u
     where u.id = p_user_id;
  end if;

  if v_email = '' then
    return;
  end if;

  -- Match the grant/revoke lock order: advisory lock BEFORE invitation row
  -- lock. A direct grant may supersede this invitation atomically.
  perform pg_advisory_xact_lock(20261022143000);

  select r.id, r.role, r.capabilities, r.invited_by
    into v_inv_id, v_inv_role, v_inv_caps, v_inv_by
    from public.role_invitations r
   where r.accepted_at is null
     and r.revoked_at is null
     and lower(btrim(r.email)) = v_email
   order by r.invited_at asc, r.id asc
   limit 1
     for update;

  if not found then
    return;
  end if;

  -- The role set is REPLACED, exactly as the grant does it: an account
  -- never holds ADMIN and MODERATOR at the same time. The same advisory
  -- lock and the same last-admin guard apply.
  if exists (
    select 1
      from public.user_roles r
     where r.user_id = p_user_id
       and r.role <> v_inv_role
  ) then
    if exists (
      select 1
        from public.user_roles r
       where r.user_id = p_user_id
         and r.role = 'ADMIN'
    ) then
      select count(*) into v_admin_count
        from public.user_roles r
       where r.role = 'ADMIN';
      if v_admin_count <= 1 then
        raise exception 'The last admin cannot be demoted' using errcode = '42501';
      end if;
    end if;

    delete from public.user_roles r
     where r.user_id = p_user_id
       and r.role <> v_inv_role;
  end if;

  insert into public.user_roles (user_id, role, granted_by, granted_at)
  values (p_user_id, v_inv_role, v_inv_by, v_now)
  on conflict (user_id, role) do nothing;

  delete from public.user_role_capabilities c
   where c.user_id = p_user_id;

  foreach v_capability in array coalesce(v_inv_caps, '{}') loop
    -- A NULL element is not a capability: it is skipped, never stored.
    if v_capability is null then
      continue;
    end if;
    -- A moderator can never be handed an admin-only capability (A2.1).
    if v_capability = any (public.findback_capability_vocabulary())
       and (v_inv_role = 'ADMIN' or v_capability <> all (public.findback_admin_capabilities())) then
      insert into public.user_role_capabilities (user_id, capability, granted_by, granted_at)
      values (p_user_id, v_capability, v_inv_by, v_now)
      on conflict (user_id, capability) do nothing;
    end if;
  end loop;

  update public.role_invitations
     set accepted_at = v_now
   where id = v_inv_id;

  perform public.findback_write_audit(
    'INVITATION_ACCEPTED',
    'user_roles',
    p_user_id,
    'Invitation consumed on a verified account',
    jsonb_build_object('invitation_id', v_inv_id::text, 'email', v_email, 'accepted', false, 'invited_by', v_inv_by),
    jsonb_build_object('invitation_id', v_inv_id::text, 'email', v_email, 'accepted', true, 'role', v_inv_role)
  );
end;
$$;

revoke all on function public.findback_attach_pending_role(text, text) from public, anon, authenticated;

comment on function public.findback_attach_pending_role(text, text) is
  'FindBack invitation consumption (definer, internal): attaches a pending email invitation to the account and audits it. It is called from the CONFIRMED paths only — the e-mail confirmation and the verified profile row — so an unverified sign-up cannot burn an invitation. It is idempotent, and it leaves the invitation live while the profile row does not exist yet.';

-- ---------------------------------------------------------------------------
-- 5. The predicates (D35 + A2.2).
-- ---------------------------------------------------------------------------

create or replace function public.findback_has_role(p_role text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return false;
  end if;
  -- This predicate READS. It never writes: a STABLE function that wrote
  -- would not see its own write, and a role that appears mid-statement
  -- would be a lie. The invitation is consumed by the confirmed paths.
  return exists (
    select 1
      from public.user_roles r
     where r.user_id = auth.uid()::text
       and r.role = p_role
  );
end;
$$;

revoke all on function public.findback_has_role(text) from public, anon;
grant execute on function public.findback_has_role(text) to authenticated;

comment on function public.findback_has_role(text) is
  'FindBack role predicate (definer, stable): true when the caller holds the named role. The role is read from the table on every call, so a revoke takes effect immediately — it is never a JWT claim.';

create or replace function public.findback_can(p_capability text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return false;
  end if;
  -- A2.2: an ADMIN holds every capability without per-row grants.
  if exists (
    select 1
      from public.user_roles r
     where r.user_id = auth.uid()::text
       and r.role = 'ADMIN'
  ) then
    return true;
  end if;
  -- A capability only counts while the account still HOLDS the moderator
  -- role. Without the role row, a revoked account would keep every
  -- capability row it was given — and a revoked ADMIN would keep
  -- `roles_manage`, which is every admin RPC.
  return exists (
    select 1
      from public.user_role_capabilities c
      join public.user_roles r
        on r.user_id = c.user_id
       and r.role = 'MODERATOR'
     where c.user_id = auth.uid()::text
       and c.capability = p_capability
  );
end;
$$;

revoke all on function public.findback_can(text) from public, anon;
grant execute on function public.findback_can(text) to authenticated;

comment on function public.findback_can(text) is
  'FindBack capability predicate (definer, stable): true for an ADMIN (every capability) or when the caller holds the named capability row. Revocation is immediate.';

create or replace function public.findback_my_role()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_role text;
  v_caps text[];
begin
  if v_uid is null then
    return jsonb_build_object('role', null, 'is_admin', false, 'capabilities', '[]'::jsonb);
  end if;

  select r.role into v_role
    from public.user_roles r
   where r.user_id = v_uid and r.role = 'ADMIN'
   limit 1;

  if v_role is null then
    select r.role into v_role
      from public.user_roles r
     where r.user_id = v_uid and r.role = 'MODERATOR'
     limit 1;
  end if;

  -- Only the capabilities of a LIVE moderator role are reported. A revoked
  -- account must not keep offering the moderation console to its owner.
  select coalesce(array_agg(c.capability order by c.capability), '{}'::text[])
    into v_caps
    from public.user_role_capabilities c
    join public.user_roles r
      on r.user_id = c.user_id
     and r.role = 'MODERATOR'
   where c.user_id = v_uid;

  if v_role = 'ADMIN' then
    -- A2.2: an admin holds everything, so the console shows the whole matrix.
    v_caps := public.findback_capability_vocabulary();
  end if;

  return jsonb_build_object(
    'role', v_role,
    'is_admin', v_role = 'ADMIN',
    'capabilities', to_jsonb(v_caps)
  );
end;
$$;

revoke all on function public.findback_my_role() from public, anon;
grant execute on function public.findback_my_role() to authenticated;

comment on function public.findback_my_role() is
  'FindBack role discovery (definer, stable): the caller''s role and capabilities, read from the server. An ADMIN is reported with the full capability vocabulary.';

-- ---------------------------------------------------------------------------
-- 6. The one-time admin claim (A2.4).
-- ---------------------------------------------------------------------------

create or replace function public.findback_bootstrap_admin()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_email text;
  v_verified integer;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- The claim is atomic: two concurrent callers cannot both become the admin.
  -- The SAME lock key is used by every role mutation, so a claim and a
  -- revoke (or a demotion) cannot interleave and leave the app without an
  -- admin.
  perform pg_advisory_xact_lock(20261022143000);

  select lower(btrim(u.email)), u.email_verified
    into v_email, v_verified
    from public.users u
   where u.id = v_uid;

  if v_email is null or v_email = '' then
    raise exception 'This account has no email address, so it cannot claim the admin role' using errcode = '22023';
  end if;

  -- Only a CONFIRMED address may claim the admin role: an address that was
  -- never confirmed is not yet the identity of the person it names.
  if coalesce(v_verified, 0) <> 1 then
    raise exception 'Confirm your email address before claiming the admin role' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.bootstrap_admins b where lower(btrim(b.email)) = v_email
  ) then
    raise exception 'This account is not in the admin bootstrap list' using errcode = '42501';
  end if;

  if exists (select 1 from public.user_roles r where r.role = 'ADMIN') then
    raise exception 'An admin already exists' using errcode = '42501';
  end if;

  -- The claim REPLACES any role the account already held, exactly as a grant
  -- does: leaving a MODERATOR row beside the ADMIN row would make the account
  -- an admin now and a moderator again after any later demotion. The matrix is
  -- cleared too — an admin holds every capability implicitly.
  delete from public.user_roles r
   where r.user_id = v_uid
     and r.role <> 'ADMIN';
  delete from public.user_role_capabilities c
   where c.user_id = v_uid;

  insert into public.user_roles (user_id, role, granted_by, granted_at)
  values (v_uid, 'ADMIN', v_uid, v_now)
  on conflict (user_id, role) do nothing;

  perform public.findback_write_audit(
    'BOOTSTRAP_ADMIN',
    'user_roles',
    v_uid,
    'First admin claim from the bootstrap allowlist',
    jsonb_build_object('role', null),
    jsonb_build_object('role', 'ADMIN', 'email', v_email)
  );

  return true;
end;
$$;

revoke all on function public.findback_bootstrap_admin() from public, anon;
grant execute on function public.findback_bootstrap_admin() to authenticated;

comment on function public.findback_bootstrap_admin() is
  'FindBack one-time admin claim (definer): the caller''s email must be in bootstrap_admins and NO active admin may exist. The claim is atomic and writes one audit row.';

-- ---------------------------------------------------------------------------
-- 7. The admin-only management RPCs (A2.3, A2.6).
-- ---------------------------------------------------------------------------

-- Assign a role by email. When the person already has an account the role is
-- granted directly; otherwise a pending invitation is created for their next
-- signup (A2.3).
create or replace function public.findback_role_grant(
  p_email text,
  p_role text,
  p_capabilities text[] default '{}'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user_id text;
  v_admin_count integer;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_capability text;
  v_invitation_count integer;
  v_previous_role text;
  v_previous_capabilities text[];
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- roles_manage is admin-only (A2.1); an ADMIN passes by role (A2.2).
  if not public.findback_can('roles_manage') then
    raise exception 'Only an admin may assign roles' using errcode = '42501';
  end if;

  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;

  if p_role is null or p_role not in ('MODERATOR', 'ADMIN') then
    raise exception 'Unknown role' using errcode = '22023';
  end if;

  foreach v_capability in array coalesce(p_capabilities, '{}') loop
    -- A NULL element is not a capability: `null <> all (...)` is NULL, not
    -- true, so a NULL would slip past the vocabulary check and land as a
    -- raw not-null violation. It is refused by name instead.
    if v_capability is null then
      raise exception 'Unknown capability %', v_capability using errcode = '22023';
    end if;
    if v_capability <> all (public.findback_capability_vocabulary()) then
      raise exception 'Unknown capability %', v_capability using errcode = '22023';
    end if;
    if p_role = 'MODERATOR' and v_capability = any (public.findback_admin_capabilities()) then
      raise exception 'Capability % is admin-only and cannot be granted to a moderator', v_capability using errcode = '22023';
    end if;
  end loop;

  -- The same lock the bootstrap claim and the revoke take: a grant, a
  -- demotion and a revoke must not interleave.
  perform pg_advisory_xact_lock(20261022143000);

  -- Re-authorize UNDER the lock. The pre-lock check above is only a fast
  -- refusal: a caller whose admin role is revoked while it waits must not
  -- proceed on the permission it held before waiting. Every statement after
  -- the lock takes a fresh READ COMMITTED snapshot, so this sees the
  -- committed revocation.
  if not public.findback_can('roles_manage') then
    raise exception 'Only an admin may assign roles' using errcode = '42501';
  end if;

  select u.id into v_user_id
    from public.users u
   where lower(btrim(u.email)) = v_email
   limit 1;

  if v_user_id is null then
    -- No account yet: the grant waits as an invitation. A second live
    -- invitation for the same address is refused by name, not by a raw
    -- unique-violation error on a consumer surface.
    if exists (
      select 1
        from public.role_invitations r
       where lower(btrim(r.email)) = v_email
         and r.accepted_at is null
         and r.revoked_at is null
    ) then
      raise exception 'An invitation already exists for that address' using errcode = '22023';
    end if;

    insert into public.role_invitations (email, role, capabilities, invited_by, invited_at)
    values (v_email, p_role, coalesce(p_capabilities, '{}'), v_uid, v_now);

    perform public.findback_write_audit(
      'ROLE_INVITED',
      'role_invitations',
      v_email,
      'Invitation created for an email that has no account yet',
      jsonb_build_object('role', null, 'capabilities', '[]'::jsonb, 'accepted', false),
      jsonb_build_object('role', p_role, 'capabilities', to_jsonb(coalesce(p_capabilities, '{}')), 'accepted', false)
    );

    return jsonb_build_object('kind', 'invitation', 'email', v_email, 'role', p_role);
  end if;

  -- A newer direct assignment supersedes any older pending invitation.
  -- Confirmation must never restore its older role or broader capabilities.
  update public.role_invitations r set revoked_at = v_now
   where lower(btrim(r.email)) = v_email
     and r.accepted_at is null and r.revoked_at is null;
  get diagnostics v_invitation_count = row_count;
  if v_invitation_count > 0 then
    perform public.findback_write_audit(
      'INVITATION_REVOKED', 'role_invitations', v_email,
      'Pending invitation superseded by a direct role assignment',
      jsonb_build_object('email', v_email, 'pending', true),
      jsonb_build_object('email', v_email, 'pending', false, 'superseded_by_account', v_user_id)
    );
  end if;

  -- Snapshot the state this grant REPLACES, before anything is written. The
  -- audit row is the only record of what a moderator held, so it must carry
  -- the real previous role and capability set rather than a placeholder.
  select r.role into v_previous_role
    from public.user_roles r
   where r.user_id = v_user_id
   order by case when r.role = 'ADMIN' then 0 else 1 end asc
   limit 1;

  select coalesce(array_agg(c.capability order by c.capability), '{}'::text[])
    into v_previous_capabilities
    from public.user_role_capabilities c
   where c.user_id = v_user_id;

  -- The account exists. The role set is REPLACED, so granting MODERATOR to
  -- an admin really demotes them: the old ADMIN row would otherwise keep
  -- every admin capability alive while the console says "moderator".
  if exists (
    select 1
      from public.user_roles r
     where r.user_id = v_user_id
       and r.role <> p_role
  ) then
    if exists (
      select 1
        from public.user_roles r
       where r.user_id = v_user_id
         and r.role = 'ADMIN'
    ) then
      select count(*) into v_admin_count
        from public.user_roles r
       where r.role = 'ADMIN';
      if v_admin_count <= 1 then
        raise exception 'The last admin cannot be demoted' using errcode = '42501';
      end if;
    end if;

    delete from public.user_roles r
     where r.user_id = v_user_id
       and r.role <> p_role;
  end if;

  insert into public.user_roles (user_id, role, granted_by, granted_at)
  values (v_user_id, p_role, v_uid, v_now)
  on conflict (user_id, role) do nothing;

  delete from public.user_role_capabilities c
   where c.user_id = v_user_id;

  foreach v_capability in array coalesce(p_capabilities, '{}') loop
    insert into public.user_role_capabilities (user_id, capability, granted_by, granted_at)
    values (v_user_id, v_capability, v_uid, v_now)
    on conflict (user_id, capability) do nothing;
  end loop;

  perform public.findback_write_audit(
    'ROLE_GRANTED',
    'user_roles',
    v_user_id,
    'Role granted to an existing account',
    jsonb_build_object('role', v_previous_role, 'capabilities', to_jsonb(v_previous_capabilities), 'email', v_email),
    jsonb_build_object('role', p_role, 'capabilities', to_jsonb(coalesce(p_capabilities, '{}')), 'email', v_email)
  );

  return jsonb_build_object('kind', 'account', 'user_id', v_user_id, 'email', v_email, 'role', p_role);
end;
$$;

revoke all on function public.findback_role_grant(text, text, text[]) from public, anon;
grant execute on function public.findback_role_grant(text, text, text[]) to authenticated;

comment on function public.findback_role_grant(text, text, text[]) is
  'FindBack role grant (definer, admin-only): assigns a role and its capability set by EMAIL. An address with no account gets a pending invitation; an existing account is granted directly. Every grant writes one audit row.';

-- Replace a moderator's capability set (the admin's absolute control).
create or replace function public.findback_role_set_capabilities(
  p_email text,
  p_capabilities text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user_id text;
  v_account_role text;
  v_invitation_role text;
  v_invitation_capabilities text[];
  v_effective_role text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_capability text;
  v_before text[];
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if not public.findback_can('roles_manage') then
    raise exception 'Only an admin may change capabilities' using errcode = '42501';
  end if;

  if v_email = '' then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;

  -- One vocabulary check, before anything is written.
  foreach v_capability in array coalesce(p_capabilities, '{}') loop
    if v_capability is null then
      raise exception 'Unknown capability %', v_capability using errcode = '22023';
    end if;
    if v_capability <> all (public.findback_capability_vocabulary()) then
      raise exception 'Unknown capability %', v_capability using errcode = '22023';
    end if;
  end loop;

  perform pg_advisory_xact_lock(20261022143000);

  -- Re-authorize UNDER the lock: a queued capability edit must not proceed on
  -- a permission that was revoked while it waited.
  if not public.findback_can('roles_manage') then
    raise exception 'Only an admin may change capabilities' using errcode = '42501';
  end if;

  select u.id into v_user_id
    from public.users u
   where lower(btrim(u.email)) = v_email
   limit 1;

  -- An assigned role takes precedence. A roleless (e.g. unverified) account
  -- may still have a live invitation whose future capability set is editable.
  if v_user_id is not null then
    select r.role into v_account_role
      from public.user_roles r
     where r.user_id = v_user_id
     order by case when r.role = 'ADMIN' then 0 else 1 end asc
     limit 1;

    if v_account_role = 'ADMIN' then
      raise exception 'An admin holds every capability, so there is no capability set to change' using errcode = '22023';
    end if;

  end if;

  -- The pending invitation for the same address, when there is one. Its
  -- current capability set is read here so the audit can record what the
  -- edit replaced.
  select r.role, coalesce(r.capabilities, '{}')
    into v_invitation_role, v_invitation_capabilities
    from public.role_invitations r
   where lower(btrim(r.email)) = v_email
     and r.accepted_at is null
     and r.revoked_at is null
   order by r.invited_at asc, r.id asc
   limit 1;

  -- The role the capability set would land on: the account's own role when
  -- it has one, otherwise the role of the pending invitation.
  v_effective_role := coalesce(v_account_role, v_invitation_role);

  if v_effective_role is null then
    raise exception 'No moderator with that email address' using errcode = '42501';
  end if;

  -- The refusal comes BEFORE any write, and it covers the invitation too:
  -- an admin-only capability may never be stored on a moderator invitation.
  if v_effective_role = 'MODERATOR' then
    foreach v_capability in array coalesce(p_capabilities, '{}') loop
      if v_capability is null then
        raise exception 'Unknown capability %', v_capability using errcode = '22023';
      end if;
      if v_capability = any (public.findback_admin_capabilities()) then
        raise exception 'Capability % is admin-only and cannot be granted to a moderator', v_capability using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_account_role is not null then
    -- The account holds the MODERATOR role.
    select coalesce(array_agg(c.capability order by c.capability), '{}'::text[])
      into v_before
      from public.user_role_capabilities c
     where c.user_id = v_user_id;

    delete from public.user_role_capabilities c
     where c.user_id = v_user_id;

    foreach v_capability in array coalesce(p_capabilities, '{}') loop
      insert into public.user_role_capabilities (user_id, capability, granted_by, granted_at)
      values (v_user_id, v_capability, v_uid, v_now)
      on conflict (user_id, capability) do nothing;
    end loop;

    perform public.findback_write_audit(
      'CAPABILITIES_CHANGED',
      'user_role_capabilities',
      v_user_id,
      'Capability set changed',
      jsonb_build_object('capabilities', to_jsonb(v_before)),
      jsonb_build_object('capabilities', to_jsonb(coalesce(p_capabilities, '{}')))
    );

    return jsonb_build_object('kind', 'account', 'user_id', v_user_id, 'email', v_email);
  end if;

  -- No moderator account: the pending invitation carries the capability set.
  update public.role_invitations r
     set capabilities = coalesce(p_capabilities, '{}')
   where lower(btrim(r.email)) = v_email
     and r.accepted_at is null
     and r.revoked_at is null;

  if not found then
    raise exception 'No moderator with that email address' using errcode = '42501';
  end if;

  perform public.findback_write_audit(
    'INVITATION_CAPABILITIES_CHANGED',
    'role_invitations',
    v_email,
    'Capability set changed on a pending invitation',
    jsonb_build_object('capabilities', to_jsonb(coalesce(v_invitation_capabilities, '{}'))),
    jsonb_build_object('capabilities', to_jsonb(coalesce(p_capabilities, '{}')))
  );

  return jsonb_build_object('kind', 'invitation', 'email', v_email);
end;
$$;

revoke all on function public.findback_role_set_capabilities(text, text[]) from public, anon;
grant execute on function public.findback_role_set_capabilities(text, text[]) to authenticated;

comment on function public.findback_role_set_capabilities(text, text[]) is
  'FindBack capability set (definer, admin-only): replaces a moderator''s capabilities. A moderator can never hold an admin-only capability. Every change writes one audit row.';

-- Revoke a role or an invitation. The last active admin cannot be revoked.
create or replace function public.findback_role_revoke(p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user_id text;
  v_role text;
  v_admin_count integer;
  v_role_count integer;
  v_invitation_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if not public.findback_can('roles_manage') then
    raise exception 'Only an admin may revoke roles' using errcode = '42501';
  end if;

  if v_email = '' then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;

  -- The last-admin check and the delete are ONE critical section: two
  -- concurrent revokes must not both see "two admins" and leave the app
  -- with none. The SAME lock key the bootstrap claim and the grant take is
  -- used, so a claim cannot slip in between the count and the delete.
  perform pg_advisory_xact_lock(20261022143000);

  -- Re-authorize UNDER the lock: a revoke that waited must not use the
  -- permission it held before waiting. Without this, a queued revoke could
  -- strip another account's role after its own revocation had committed.
  if not public.findback_can('roles_manage') then
    raise exception 'Only an admin may revoke roles' using errcode = '42501';
  end if;

  select u.id into v_user_id
    from public.users u
   where lower(btrim(u.email)) = v_email
   limit 1;

  select r.role into v_role
    from public.user_roles r
   where r.user_id = v_user_id and r.role = 'ADMIN'
   limit 1;

  if v_role = 'ADMIN' then
    select count(*) into v_admin_count
      from public.user_roles r
     where r.role = 'ADMIN';
    if v_admin_count <= 1 then
      raise exception 'The last admin cannot be revoked' using errcode = '42501';
    end if;
  end if;

  if v_user_id is not null then
    delete from public.user_roles r
     where r.user_id = v_user_id
       and (v_role is null or r.role = v_role);
    get diagnostics v_role_count = row_count;

    -- The capability rows go with the role. Leaving them behind would keep
    -- a revoked moderator's capabilities alive, because the capability
    -- predicate reads the rows, not the role.
    delete from public.user_role_capabilities c
     where c.user_id = v_user_id;
  else
    v_role_count := 0;
  end if;

  update public.role_invitations r
     set revoked_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where lower(btrim(r.email)) = v_email
     and r.accepted_at is null
     and r.revoked_at is null;

  get diagnostics v_invitation_count = row_count;

  -- Nothing was there: an address with no role and no live invitation is
  -- refused by name, so the console cannot report a revoke that did not
  -- happen and the audit log cannot record a false event. The count is of
  -- the rows ACTUALLY removed — an account that exists but holds no role
  -- is a refusal too.
  if v_role_count = 0 and v_invitation_count = 0 then
    raise exception 'No role assignment or pending invitation for that address' using errcode = '22023';
  end if;

  if v_role_count > 0 then
    perform public.findback_write_audit(
    'ROLE_REVOKED',
    'user_roles',
    coalesce(v_user_id, v_email),
    'Role revoked',
    jsonb_build_object('role', coalesce(v_role, 'MODERATOR'), 'email', v_email),
    jsonb_build_object('role', null, 'email', v_email)
  );
  end if;
  if v_invitation_count > 0 then
    perform public.findback_write_audit(
      'INVITATION_REVOKED', 'role_invitations', v_email,
      'Pending invitation revoked',
      jsonb_build_object('email', v_email, 'pending', true),
      jsonb_build_object('email', v_email, 'pending', false)
    );
  end if;

  return jsonb_build_object('email', v_email, 'revoked', true);
end;
$$;

revoke all on function public.findback_role_revoke(text) from public, anon;
grant execute on function public.findback_role_revoke(text) to authenticated;

comment on function public.findback_role_revoke(text) is
  'FindBack role revoke (definer, admin-only): removes a role or cancels a pending invitation by email. The last active admin cannot be revoked. The change is immediate and audited.';

-- The team list (admin-only).
create or replace function public.findback_role_assignments()
returns table (
  user_id text,
  username text,
  email text,
  role text,
  capabilities text[],
  granted_at text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.findback_can('roles_manage') then
    raise exception 'Only an admin may read the role list' using errcode = '42501';
  end if;

  return query
  select r.user_id,
         u.username,
         lower(btrim(u.email)),
         r.role,
         -- An ADMIN holds EVERY capability (A2.2), so the team list says so
         -- instead of showing an empty set for the one account that can do
         -- the most.
         case
           when r.role = 'ADMIN' then public.findback_capability_vocabulary()
           else coalesce((
             select array_agg(c.capability order by c.capability)
               from public.user_role_capabilities c
              where c.user_id = r.user_id
           ), '{}'::text[])
         end,
         r.granted_at
    from public.user_roles r
    join public.users u on u.id = r.user_id
   order by r.role, lower(btrim(u.email));
end;
$$;

revoke all on function public.findback_role_assignments() from public, anon;
grant execute on function public.findback_role_assignments() to authenticated;

comment on function public.findback_role_assignments() is
  'FindBack team list (definer, admin-only): every role assignment with its capability set. An ordinary caller is refused with 42501.';

-- The invitation list (admin-only).
create or replace function public.findback_role_invitations()
returns table (
  id uuid,
  email text,
  role text,
  capabilities text[],
  invited_at text,
  accepted_at text,
  revoked_at text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.findback_can('roles_manage') then
    raise exception 'Only an admin may read the invitation list' using errcode = '42501';
  end if;

  return query
  select r.id, lower(btrim(r.email)), r.role, r.capabilities, r.invited_at, r.accepted_at, r.revoked_at
    from public.role_invitations r
   order by r.invited_at desc;
end;
$$;

revoke all on function public.findback_role_invitations() from public, anon;
grant execute on function public.findback_role_invitations() to authenticated;

comment on function public.findback_role_invitations() is
  'FindBack invitation list (definer, admin-only): pending, accepted and revoked email invitations.';

-- The audit log (readable with the audit_read capability).
create or replace function public.findback_audit_log(p_limit integer default 100)
returns table (
  id text,
  actor_user_id text,
  action text,
  target_type text,
  target_id text,
  reason text,
  previous_state jsonb,
  new_state jsonb,
  created_at text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.findback_can('audit_read') then
    raise exception 'You may not read the audit log' using errcode = '42501';
  end if;

  return query
  select l.id, l.actor_user_id, l.action, l.target_type, l.target_id, l.reason,
         l.previous_state, l.new_state, l.created_at
    from public.admin_audit_log l
   order by l.created_at desc, l.id desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke all on function public.findback_audit_log(integer) from public, anon;
grant execute on function public.findback_audit_log(integer) to authenticated;

comment on function public.findback_audit_log(integer) is
  'FindBack audit log (definer): readable with the audit_read capability, newest first. The log is append-only.';

-- ---------------------------------------------------------------------------
-- 8. The confirmed paths consume a pending invitation (A2.3).
-- ---------------------------------------------------------------------------
--
-- The shipped signup trigger function is NOT re-created here: it stays
-- byte-compatible with what is deployed. The invitation is consumed by the
-- two VERIFIED paths instead:
--
--   * the address is confirmed, or
--   * a verified profile row appears (a social sign-in).
--
-- An unconfirmed sign-up therefore cannot burn an invitation: it leaves it
-- live for the real invitee.

create or replace function public.handle_role_invitation_on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A social sign-in arrives already confirmed. The profile row does not
  -- exist yet, so the invitation stays live until it does.
  if new.email_confirmed_at is not null then
    perform public.findback_attach_pending_role(new.id::text, coalesce(new.email, ''));
  end if;
  return new;
end;
$$;

revoke all on function public.handle_role_invitation_on_auth_user_created() from public, anon, authenticated;

comment on function public.handle_role_invitation_on_auth_user_created() is
  'FindBack invitation trigger (definer, internal): consumes a pending invitation for an account that is created already confirmed (the social sign-in path). It does nothing for an unconfirmed sign-up.';

drop trigger if exists on_role_invitation_auth_user_created on auth.users;
create trigger on_role_invitation_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_role_invitation_on_auth_user_created();

create or replace function public.handle_role_invitation_on_auth_user_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The moment the address becomes confirmed. Nothing happens before it.
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    perform public.findback_attach_pending_role(new.id::text, coalesce(new.email, ''));
  end if;
  return new;
end;
$$;

revoke all on function public.handle_role_invitation_on_auth_user_confirmed() from public, anon, authenticated;

comment on function public.handle_role_invitation_on_auth_user_confirmed() is
  'FindBack invitation trigger (definer, internal): consumes a pending invitation the moment the e-mail address is confirmed. An unconfirmed sign-up never reaches it.';

drop trigger if exists on_role_invitation_auth_user_confirmed on auth.users;
create trigger on_role_invitation_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.handle_role_invitation_on_auth_user_confirmed();

create or replace function public.handle_role_invitation_on_profile_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A verified profile row: the account's identity is settled, so a
  -- pending invitation for its address is consumed now.
  if new.email_verified = 1 then
    perform public.findback_attach_pending_role(new.id::text, coalesce(new.email, ''));
  end if;
  return new;
end;
$$;

revoke all on function public.handle_role_invitation_on_profile_created() from public, anon, authenticated;

comment on function public.handle_role_invitation_on_profile_created() is
  'FindBack invitation trigger (definer, internal): consumes a pending invitation when a VERIFIED profile row appears for the account. An unverified profile row never reaches it.';

drop trigger if exists on_role_invitation_profile_created on public.users;
create trigger on_role_invitation_profile_created
  after insert on public.users
  for each row execute function public.handle_role_invitation_on_profile_created();

-- ---------------------------------------------------------------------------
-- 9. The seeds (A2.4). Emails only — never a password or a token.
-- ---------------------------------------------------------------------------

insert into public.bootstrap_admins (email, created_at)
values
  ('sheikhti1205@gmail.com', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  ('sheikhti1205@outlook.com', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
on conflict (email) do nothing;

insert into public.role_invitations (email, role, capabilities, invited_at)
values (
  'sheikhti109@gmail.com',
  'MODERATOR',
  array['reports_review', 'content_hide'],
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
on conflict do nothing;

-- The seeded moderator may ALREADY have an account on the live app, in
-- which case no further sign-up will ever consume the invitation. When that
-- account's address is CONFIRMED, the invitation is attached right now, so
-- the default team is complete without waiting for anything.
--
-- When it is not confirmed, nothing is attached: an unverified account is
-- not proof that the address belongs to the invitee. The invitation stays
-- live and the confirmation trigger consumes it for the real person.
do $$
declare
  v_user_id text;
  v_email_verified integer;
begin
  select u.id, u.email_verified
    into v_user_id, v_email_verified
    from public.users u
   where lower(btrim(u.email)) = 'sheikhti109@gmail.com'
   limit 1;

  if v_user_id is not null and v_email_verified = 1 then
    perform public.findback_attach_pending_role(v_user_id, 'sheikhti109@gmail.com');
  end if;
end;
$$;

comment on table public.user_roles is
  'FindBack roles (MC D34): the role source. USER is implicit; there is no role column on users.';
comment on table public.user_role_capabilities is
  'FindBack moderator capabilities (owner amendment A2.1): the per-moderator capability matrix. An ADMIN holds every capability implicitly.';
comment on table public.role_invitations is
  'FindBack email invitations (owner amendment A2.3): a pending grant by email, consumed when the person signs up.';
comment on table public.bootstrap_admins is
  'FindBack admin bootstrap allowlist (owner amendment A2.4): the addresses allowed to make the one-time admin claim.';
comment on table public.admin_audit_log is
  'FindBack moderation audit log (MC D37): append-only. One row per moderation or role action, with previous_state/new_state/reason.';

commit;
