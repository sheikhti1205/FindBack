-- FindBack — direct Storage uploads (Block 10H).
--
-- Mobile normalizes an image on-device and uploads it straight to the public
-- `findback-images` bucket, then stages an `uploads` row the create-post RPC
-- binds. Writes/deletes are ownership-scoped: the first path segment must equal
-- auth.uid(). The bucket stays public for delivery; SELECT is scoped to the
-- caller's own folder (Storage's remove() reads before deleting, so a SELECT
-- policy is required — but it grants no access to other users' objects).

-- ---------------------------------------------------------------------------
-- Storage objects: authenticated owner-only reads + writes
-- ---------------------------------------------------------------------------
drop policy if exists findback_images_select_own on storage.objects;
create policy findback_images_select_own
  on storage.objects for select to authenticated
  using (
    bucket_id = 'findback-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists findback_images_insert_own on storage.objects;
create policy findback_images_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'findback-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists findback_images_delete_own on storage.objects;
create policy findback_images_delete_own
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'findback-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------
-- uploads staging rows: own INSERT/DELETE (SELECT own shipped in 10E)
-- ---------------------------------------------------------------------------
grant insert on public.uploads to authenticated;
grant delete on public.uploads to authenticated;

drop policy if exists uploads_insert_own on public.uploads;
create policy uploads_insert_own
  on public.uploads for insert to authenticated
  with check (user_id = (select auth.uid())::text);

drop policy if exists uploads_delete_own on public.uploads;
create policy uploads_delete_own
  on public.uploads for delete to authenticated
  using (user_id = (select auth.uid())::text);
