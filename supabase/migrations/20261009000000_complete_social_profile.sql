-- FindBack — social profile completion RPC (W0 staged).
--
-- STAGED ONLY. DO NOT APPLY to any database without explicit owner
-- authorization (per OWNER_DIRECTIVE_2026-10-09_SOCIAL_UI stop conditions:
-- "a live DB migration would be required" → stop and report).
--
-- Context: the auth.users trigger (20260914130000) skips public.users creation
-- when username AND phone metadata are both absent, which is exactly what a
-- Google sign-up produces. The client then holds a valid Supabase session with
-- no profile row. This migration closes that gap with an explicit completion
-- RPC — never a random username or dummy phone.
--
-- What this stages:
--   1. `display_name text` on public.users (additive, nullable). The users
--      table has no display-name column yet; the S2 contract passes
--      p_display_name, and W1 (profile/identity foundation) will surface it.
--      Authenticated clients may SELECT it (public identity field, same as
--      username/avatar). No other grant changes: still no client
--      INSERT/UPDATE/DELETE (rows stay trigger/RPC-owned).
--   2. `complete_social_profile(p_username, p_phone, p_display_name,
--      p_avatar_url)` — SECURITY DEFINER (callers hold no table writes) with
--      a locked search_path, mirroring 20260914120000/20260920000000 style:
--        * caller == self via public.findback_uid(); unauthenticated → 28000.
--        * username: same ^[A-Za-z0-9_]{3,20}$ rule as the auth trigger.
--        * phone: same ^(\+?88)?01[3-9][0-9]{8}$ Bangladesh rule.
--        * display name: required, 1–80 chars (client pre-validates the same).
--        * avatar: overlong/non-https values are nulled, never fatal.
--        * email: taken from server-controlled auth.users (never a parameter).
--        * email_verified: from auth email_confirmed_at (same as trigger).
--        * phone_verified: ALWAYS 0. A Google-supplied phone is prefill only —
--          it never counts as FindBack/Supabase SMS verification.
--        * single INSERT ... on conflict (id) do nothing: an existing
--          (identity-linked same-email) profile is preserved untouched, even
--          if this RPC is ever called for it. Case-insensitive username/email
--          uniqueness stays enforced by ux_users_username_lower /
--          ux_users_email_lower (duplicate → 23505 → client maps to 409).

-- ---------------------------------------------------------------------------
-- 1. Additive display-name column (+ narrow authenticated SELECT grant).
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists display_name text;

grant select (display_name) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Completion RPC: the only writer of social-provisioned profile rows.
-- ---------------------------------------------------------------------------
create or replace function public.complete_social_profile(
  p_username text,
  p_phone text,
  p_display_name text,
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      text := public.findback_uid();
  v_username text := nullif(btrim(coalesce(p_username, '')), '');
  v_phone    text := nullif(btrim(coalesce(p_phone, '')), '');
  v_display  text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_avatar   text := nullif(btrim(coalesce(p_avatar_url, '')), '');
  v_email    text;
  v_verified integer;
  v_now      text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_username is null or v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid username' using errcode = '22023';
  end if;
  if v_phone is null or v_phone !~ '^(\+?88)?01[3-9][0-9]{8}$' then
    raise exception 'invalid phone' using errcode = '22023';
  end if;
  if v_display is null or char_length(v_display) > 80 then
    raise exception 'invalid display name' using errcode = '22023';
  end if;
  if v_avatar is not null
     and (char_length(v_avatar) > 2048 or v_avatar !~ '^https://') then
    v_avatar := null;
  end if;

  select a.email,
         case when a.email_confirmed_at is not null then 1 else 0 end
    into v_email, v_verified
    from auth.users a
   where a.id::text = v_uid;
  if v_email is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  v_now := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.users (
    id, username, email, phone, password_hash, display_name,
    email_verified, phone_verified, avatar_url, created_at, updated_at
  ) values (
    v_uid, v_username, v_email, v_phone, null, v_display,
    v_verified, 0, v_avatar, v_now, v_now
  )
  on conflict (id) do nothing;
end;
$$;

revoke all on function public.complete_social_profile(text, text, text, text) from public;
grant execute on function public.complete_social_profile(text, text, text, text) to authenticated;
