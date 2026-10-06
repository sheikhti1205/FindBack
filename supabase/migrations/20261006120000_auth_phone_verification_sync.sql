-- FBA-005: a display phone is editable metadata, never proof of ownership.
-- Preserve email signup and privacy grants. Only a confirmed auth.users.phone
-- matching the normalized desired number can grant the public phone badge.
-- Saving a different metadata phone immediately clears the badge, without SMS.

-- Unverified display metadata must not squat on another user's number. Legacy
-- local/+88 spellings can also normalize to the same value during backfill.
-- Confirmed ownership/uniqueness remains enforced by Supabase Auth, not by the
-- public display field (which clients still cannot write directly).
drop index if exists public.ux_users_phone_lower;

create or replace function public.findback_normalize_bd_phone(p_phone text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when cleaned ~ '^(\+?88)?01[3-9][0-9]{8}$'
    then regexp_replace(cleaned, '^(\+?88)?(01[3-9][0-9]{8})$', '+88\2')
    else null end
  from (select regexp_replace(p_phone, '[[:space:]-]', '', 'g') as cleaned) n
$$;

revoke all on function public.findback_normalize_bd_phone(text) from public, anon, authenticated;

create or replace function public.handle_auth_user_updated()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.findback_normalize_bd_phone(
    coalesce(new.raw_user_meta_data ->> 'phone', new.phone));
  v_email_verified integer := case when new.email_confirmed_at is not null then 1 else 0 end;
  v_phone_verified integer := case when new.phone_confirmed_at is not null
    and v_phone = public.findback_normalize_bd_phone(new.phone) then 1 else 0 end;
begin
  update public.users
     set email_verified = v_email_verified,
         phone = coalesce(v_phone, phone),
         phone_verified = v_phone_verified,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where id = new.id::text
     and (email_verified is distinct from v_email_verified
       or phone_verified is distinct from v_phone_verified
       or (v_phone is not null and phone is distinct from v_phone));
  return new;
end;
$$;

revoke all on function public.handle_auth_user_updated() from public, anon, authenticated;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated after update on auth.users
for each row execute function public.handle_auth_user_updated();

-- PostgreSQL runs same-event triggers in name order: after profile provisioning.
drop trigger if exists on_auth_user_phone_synced on auth.users;
create trigger on_auth_user_phone_synced after insert on auth.users
for each row execute function public.handle_auth_user_updated();

-- Converge existing display numbers and stale/legacy badges. Metadata booleans
-- are deliberately ignored. Invalid metadata keeps the display but clears proof.
update public.users u
   set phone = coalesce(public.findback_normalize_bd_phone(coalesce(a.raw_user_meta_data ->> 'phone', a.phone)), u.phone),
       phone_verified = case when a.phone_confirmed_at is not null
         and public.findback_normalize_bd_phone(coalesce(a.raw_user_meta_data ->> 'phone', a.phone))
           = public.findback_normalize_bd_phone(a.phone) then 1 else 0 end,
       email_verified = case when a.email_confirmed_at is not null then 1 else 0 end,
       updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  from auth.users a
 where u.id = a.id::text;
