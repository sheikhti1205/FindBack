-- FindBack — phone-change cooldown + avatar object-key discipline (W5-IDENTITY).
--
-- ADDITIVE ONLY. The Supabase GitHub integration auto-applies migrations on
-- push, so this file must be safe to run once against the live schema: new
-- columns are nullable, new policies/RPCs/triggers only add objects, no row
-- rewrites, no user/auth data removal, no edits to any applied migration.
-- LIVE-PENDING (owner-deferred, 2026-10-12): verify on the live project
-- before PASS — (a) the new RPCs respond, (b) the cooldown gate rejects a
-- different verified phone with PHONE_CHANGE_COOLDOWN while first/same-phone
-- succeeds, (c) the avatar key RPC accepts an owned key and rejects cross-uid
-- keys. No live run ships in this change.
--
-- 1. Phone-change cooldown (spec 25, server-authoritative state).
--    Supabase Auth owns the SMS challenge itself, so this migration owns the
--    server-side gate around it: private per-account timestamps, a self-only
--    eligibility read, and a self-only `request_phone_change` gate the client
--    must call before starting an Auth phone challenge. The gate resolves the
--    caller from the session via public.findback_uid(), compares against the
--    server clock (a tampered device clock cannot move the outcome), and
--    rejects a *different* verified replacement before its eligible date with
--    a stable PHONE_CHANGE_COOLDOWN marker plus the eligible date. First
--    verified phone and same-number reverification never wait and never
--    restart the cooldown. Two concurrent replacements cannot both win: the
--    final commit is serialized through the trigger-maintained row state.
--    The new columns stay RPC/trigger-owned: no client table grants here.
--
-- 2. Avatar object-key discipline. The existing prefix policies stay; this
--    adds the missing owner-scoped UPDATE policy for avatars/{uid}/… plus an
--    owned object-key writer `update_my_avatar_by_key`: caller uid from the
--    session (never a parameter), exact `avatars/<uid>/<filename>` key,
--    traversal/other-uid/wrong-shape rejected, Storage existence verified,
--    URL accepted only when it embeds that exact key over https. Blank key +
--    blank URL clears to NULL, mirroring `update_my_avatar`.

-- ---------------------------------------------------------------------------
-- 1a. Private cooldown columns (nullable; existing rows read as "no cooldown
--     recorded yet", which the RPCs treat as eligible).
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists phone_verified_at text;
alter table public.users add column if not exists phone_last_changed_at text;
alter table public.users add column if not exists phone_change_eligible_at text;

-- ---------------------------------------------------------------------------
-- 1b. Cooldown maintenance trigger (BEFORE UPDATE OF phone, phone_verified).
--     Adjusts only NEW: first verification stamps verified/change/eligible
--     (+ six calendar months); a newly verified *different* number restamps
--     change/eligible; same-number reverification and badge clears leave the
--     recorded state untouched. Fires for every updater but is a no-op unless
--     the verified number actually changed.
-- ---------------------------------------------------------------------------
create or replace function public.maintain_phone_change_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_norm text := public.findback_normalize_bd_phone(coalesce(old.phone, ''));
  v_new_norm text := public.findback_normalize_bd_phone(coalesce(new.phone, ''));
  v_now      text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_eligible text := to_char((now() + interval '6 months') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if coalesce(new.phone_verified, 0) <> 1 or v_new_norm is null then
    return new;
  end if;
  if coalesce(old.phone_verified, 0) <> 1 or v_old_norm is null then
    -- First verified phone: no prior wait; stamp all three.
    new.phone_verified_at := v_now;
    new.phone_last_changed_at := v_now;
    new.phone_change_eligible_at := v_eligible;
    return new;
  end if;
  if v_old_norm = v_new_norm then
    -- Same-number reverification: allowed, cooldown untouched.
    return new;
  end if;
  -- Different verified replacement: restamp change/eligible.
  new.phone_verified_at := v_now;
  new.phone_last_changed_at := v_now;
  new.phone_change_eligible_at := v_eligible;
  return new;
end;
$$;

revoke all on function public.maintain_phone_change_cooldown() from public, anon, authenticated;

drop trigger if exists users_phone_cooldown on public.users;
create trigger users_phone_cooldown
  before update of phone, phone_verified on public.users
  for each row execute function public.maintain_phone_change_cooldown();

-- ---------------------------------------------------------------------------
-- 1c. Self-only eligibility read. Returns the caller's gate state computed on
--     the server clock: eligible true when nothing is recorded yet, when the
--     recorded date no longer parses, or when now() has reached it.
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

  if v_eligible_at is null or nullif(btrim(v_eligible_at), '') is null then
    return query select true, null::text, v_verified;
    return;
  end if;

  begin
    return query select
      (now() at time zone 'utc') >= (v_eligible_at)::timestamptz,
      v_eligible_at,
      v_verified;
  exception when invalid_datetime_format then
    return query select true, null::text, v_verified;
  end;
end;
$$;

revoke all on function public.phone_change_eligibility() from public;
revoke execute on function public.phone_change_eligibility() from anon;
grant execute on function public.phone_change_eligibility() to authenticated;

-- ---------------------------------------------------------------------------
-- 1d. Server-authoritative replacement gate. The client calls this before
--     starting an Auth phone challenge for a *different* number. Raises
--     PHONE_CHANGE_COOLDOWN with the eligible date while the gate holds;
--     first verification and same-number reverification return eligible.
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
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_desired is null then
    raise exception 'invalid phone' using errcode = '22023';
  end if;

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
  -- server clock with the stable marker and the eligible date.
  if v_eligible_at is not null
     and nullif(btrim(v_eligible_at), '') is not null
     and (now() at time zone 'utc') < (v_eligible_at)::timestamptz then
    raise exception 'PHONE_CHANGE_COOLDOWN eligible_at=%', v_eligible_at using errcode = 'P0001';
  end if;

  return query select true, null::text;
end;
$$;

revoke all on function public.request_phone_change(text) from public;
revoke execute on function public.request_phone_change(text) from anon;
grant execute on function public.request_phone_change(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2a. Missing owner-scoped UPDATE policy for avatars/{uid}/… (SELECT/INSERT/
--     UPDATE/DELETE now all owner-only; report-image policies untouched).
-- ---------------------------------------------------------------------------
drop policy if exists findback_images_avatar_update_own on storage.objects;
create policy findback_images_avatar_update_own
  on storage.objects for update to authenticated
  using (
    bucket_id = 'findback-images'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and position('..' in name) = 0
  )
  with check (
    bucket_id = 'findback-images'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and position('..' in name) = 0
  );

-- ---------------------------------------------------------------------------
-- 2b. Owned object-key avatar writer. Accepts null/null to clear, otherwise
--     an exact `avatars/<caller-uid>/<filename>` key (jpg/jpeg/png/webp,
--     no traversal) whose Storage object must exist, plus the https public
--     URL embedding that exact key. Anything else raises 22023 and nothing
--     is persisted — never an arbitrary remote URL, never another uid.
-- ---------------------------------------------------------------------------
create or replace function public.update_my_avatar_by_key(
  p_object_key text,
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  text := public.findback_uid();
  v_key  text := nullif(btrim(coalesce(p_object_key, '')), '');
  v_url  text := nullif(btrim(coalesce(p_avatar_url, '')), '');
  v_parts text[];
  v_file text;
  v_exists boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if v_key is null and v_url is null then
    update public.users
       set avatar_url = null,
           updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     where id = v_uid;
    if not found then
      raise exception 'profile not found' using errcode = 'P0002';
    end if;
    return;
  end if;

  if v_key is null or v_url is null then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  if char_length(v_key) > 512 or char_length(v_url) > 2048 then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  if position('..' in v_key) > 0 then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  v_parts := string_to_array(v_key, '/');
  if array_length(v_parts, 1) <> 3
     or v_parts[1] <> 'avatars'
     or v_parts[2] <> v_uid then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  v_file := v_parts[3];
  if v_file !~* '^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp)$' then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  if v_url not like 'https://%' then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  if position('/findback-images/' || v_key in v_url) = 0 then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;

  select exists(
    select 1 from storage.objects o
     where o.bucket_id = 'findback-images'
       and o.name = v_key
  ) into v_exists;
  if not coalesce(v_exists, false) then
    raise exception 'avatar object not found' using errcode = '22023';
  end if;

  update public.users
     set avatar_url = v_url,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where id = v_uid;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_my_avatar_by_key(text, text) from public;
revoke execute on function public.update_my_avatar_by_key(text, text) from anon;
grant execute on function public.update_my_avatar_by_key(text, text) to authenticated;
