-- FindBack — profile avatar uploads (post-v1 W1): self-service avatar_url
-- writer plus the ownership-scoped Storage prefix avatars/{uid}/…
--
-- ADDITIVE ONLY. The Supabase GitHub integration auto-applies migrations on
-- push, so this file must be safe to run once against the live schema: no
-- column drops, no row rewrites, no user/auth data deletion. No new bucket:
-- avatars live in the existing public `findback-images` bucket (same delivery
-- host as report images), under a distinct `avatars/` prefix so the existing
-- `{uid}/…` report-image policies are untouched.
--
-- Privacy is unchanged: avatar_url is already a public identity column
-- (feed author projection, public profile lookup). Email and phone stay
-- unreadable by clients; clients still hold NO table UPDATE privilege.
--
-- Existing Google-seeded avatars are preserved untouched: this writer only
-- changes the caller's own row, and Google-hosted seed URLs keep entering
-- solely through `complete_social_profile`, never through this RPC.

-- ---------------------------------------------------------------------------
-- 1. Storage objects under avatars/{uid}/…: authenticated owner-only
--    insert/select/delete. First segment must be 'avatars', second must equal
--    auth.uid() — mirroring the {uid}/… report convention from
--    20260914220000_direct_storage_uploads.sql. SELECT is scoped to the
--    caller's own folder (Storage's remove() reads before deleting).
-- ---------------------------------------------------------------------------
drop policy if exists findback_images_avatar_select_own on storage.objects;
create policy findback_images_avatar_select_own
  on storage.objects for select to authenticated
  using (
    bucket_id = 'findback-images'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists findback_images_avatar_insert_own on storage.objects;
create policy findback_images_avatar_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'findback-images'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists findback_images_avatar_delete_own on storage.objects;
create policy findback_images_avatar_delete_own
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'findback-images'
    and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------
-- 2. Self-service avatar update RPC.
--    SECURITY DEFINER because clients hold NO table UPDATE privilege (profile
--    rows stay trigger/RPC-owned). Locked search_path; the caller is resolved
--    from the session via public.findback_uid(), never a parameter, so one
--    account can never write another's avatar. Blank input clears to NULL.
--    A non-null URL is accepted ONLY when it is an https URL into this
--    project's own `findback-images/avatars/{caller-uid}/` prefix — anything
--    else raises 22023 and nothing is persisted (never an arbitrary remote
--    URL, never another user's object).
-- ---------------------------------------------------------------------------
create or replace function public.update_my_avatar(
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    text := public.findback_uid();
  v_avatar text := nullif(btrim(coalesce(p_avatar_url, '')), '');
  v_marker text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if v_avatar is not null then
    if char_length(v_avatar) > 2048 then
      raise exception 'invalid avatar url' using errcode = '22023';
    end if;
    if v_avatar not like 'https://%' then
      raise exception 'invalid avatar url' using errcode = '22023';
    end if;
    v_marker := '/findback-images/avatars/' || v_uid || '/';
    if position(v_marker in v_avatar) = 0 then
      raise exception 'invalid avatar url' using errcode = '22023';
    end if;
  end if;

  update public.users
     set avatar_url = v_avatar,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where id = v_uid;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_my_avatar(text) from public;
revoke execute on function public.update_my_avatar(text) from anon;
grant execute on function public.update_my_avatar(text) to authenticated;
