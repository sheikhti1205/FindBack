-- FindBack — make auth.users profile provisioning tolerant of the legacy
-- Node registration path.
--
-- The Node API is retained as a non-runtime fallback during the mobile
-- migration. Its signUp calls Supabase without username/phone metadata and then
-- inserts the public.users row itself. The strict trigger from
-- 20260914120000 would reject that insert (missing metadata), so skip profile
-- creation when the metadata is absent; the mobile path still validates and
-- provisions the row.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_username text;
  v_phone    text;
  v_now      text;
begin
  v_username := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')), '');
  v_phone    := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '');

  if v_username is null and v_phone is null then
    return new;
  end if;

  if v_username is null or v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid username for auth user %', new.id using errcode = '22023';
  end if;
  if v_phone is null or v_phone !~ '^(\+?88)?01[3-9][0-9]{8}$' then
    raise exception 'invalid phone for auth user %', new.id using errcode = '22023';
  end if;

  v_now := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.users (
    id, username, email, phone, password_hash,
    email_verified, phone_verified, avatar_url, created_at, updated_at
  ) values (
    new.id::text,
    v_username,
    coalesce(new.email, ''),
    v_phone,
    null,
    case when new.email_confirmed_at is not null then 1 else 0 end,
    0,
    null,
    v_now,
    v_now
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
