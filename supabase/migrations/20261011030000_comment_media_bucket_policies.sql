-- FindBack — dedicated comment media bucket (FBX-013).
--
-- WHY: comment attachments are capped client-side at 25 MB
-- (COMMENT_ATTACH_MAX_BYTES) and accept the full on-device photo MIME set
-- plus video/mp4|webm|quicktime, but they were uploading into the report
-- image bucket, whose bucket row pins 8 MB and allows only
-- png/jpeg/webp/gif. Storage enforces the bucket row server-side, so every
-- video comment upload — and any photo over 8 MB — could never succeed: the
-- client promised a completion the server was required to refuse.
--
-- ADDITIVE ONLY: this file creates ONE new bucket. The report image bucket
-- created by 20260914062145_create_findback_images_bucket.sql is NOT touched
-- here and must stay 8 MB / images-only for report photos.
--
-- Delivery: PUBLIC bucket, the same plain public-object-URL model as report
-- photos — comment bodies carry `https://` URLs that every viewer must be
-- able to load, so no signed URLs.
-- Ownership: the same `<uid>/…` first-segment convention used by the report
-- image policies, so a caller can only ever write or delete their own
-- comment media.
--
-- file_size_limit equals COMMENT_ATTACH_MAX_BYTES (25,000,000) exactly, so
-- the pre-upload client cap and the server ceiling agree instead of drifting
-- apart again.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'findback-comment-media',
  'findback-comment-media',
  true,
  25000000, -- == COMMENT_ATTACH_MAX_BYTES (client pre-upload cap)
  array[
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
    'image/heic', 'image/heif', 'image/avif', 'image/bmp',
    'video/mp4', 'video/webm', 'video/quicktime'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- Owner-path object policies: authenticated select/insert/delete only, first
-- path segment must equal auth.uid(). Mirrors the report-image owner policies
-- from 20260914220000_direct_storage_uploads.sql (SELECT is required because
-- Storage's remove() reads before it deletes). No UPDATE policy: comment media
-- objects are write-once, and the report bucket's narrower surface is left
-- exactly as it was.
-- ---------------------------------------------------------------------------
drop policy if exists findback_comment_media_select_own on storage.objects;
create policy findback_comment_media_select_own
  on storage.objects for select to authenticated
  using (
    bucket_id = 'findback-comment-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists findback_comment_media_insert_own on storage.objects;
create policy findback_comment_media_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'findback-comment-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists findback_comment_media_delete_own on storage.objects;
create policy findback_comment_media_delete_own
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'findback-comment-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
