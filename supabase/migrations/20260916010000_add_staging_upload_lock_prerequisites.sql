-- PostgreSQL requires UPDATE privilege and an UPDATE policy for FOR UPDATE.
-- Restrict the grant to the primary key and reject every actual updated row.
grant update (id) on public.uploads to authenticated;

drop policy if exists uploads_lock_own on public.uploads;
create policy uploads_lock_own
  on public.uploads for update to authenticated
  using (user_id = (select auth.uid())::text)
  with check (false);
