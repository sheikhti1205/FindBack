-- FindBack — anon username availability lookup (Block 10C).
--
-- The Register screen checks whether a username is free before signup, i.e.
-- BEFORE the user is authenticated. Block 10C moves that check off the Node
-- endpoint (/users/check-username) onto the hosted Supabase Data API.
--
-- Usernames are public identifiers, so an anonymous caller may test whether a
-- username already exists. To keep that power minimal:
--   * anon may SELECT only the `username` column (no email, phone,
--     password_hash, or verification state)
--   * the RLS policy is SELECT-only; anon still has no INSERT/UPDATE/DELETE
--     (the base table privileges were revoked in 20260914120000 and are not
--     re-granted here)
--   * no SECURITY DEFINER function is introduced, so the anon-executable
--     advisor warning removed in 20260914160000 does not come back
--
-- The database remains the final authority: `ux_users_username_lower` enforces
-- case-insensitive uniqueness, and the availability check only mirrors it.
--
-- authenticated keeps its self-only, column-limited SELECT from
-- 20260914120000; that policy targets the `authenticated` role, so it is
-- unaffected by this anon policy.

grant select (username) on public.users to anon;

drop policy if exists users_select_username_anon on public.users;
create policy users_select_username_anon
  on public.users
  for select
  to anon
  using (true);
