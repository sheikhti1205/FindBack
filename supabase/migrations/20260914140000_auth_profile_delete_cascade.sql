-- FindBack — keep public.users in sync when an auth user is deleted.
--
-- public.users.id stores the Supabase Auth UUID as text but has no FK to
-- auth.users, so deleting an auth user would otherwise leave an orphan profile.
-- Deleting the profile cascades to the user's posts/comments/reactions/ratings
-- (all reference users(id) on delete cascade), which is the intended semantic
-- for account deletion.

create or replace function public.handle_auth_user_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.users where id = old.id::text;
  return old;
end;
$$;

revoke all on function public.handle_auth_user_deleted() from public, anon, authenticated;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public.handle_auth_user_deleted();
