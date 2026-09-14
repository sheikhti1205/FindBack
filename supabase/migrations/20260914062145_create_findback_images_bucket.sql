-- FindBack listing images.
--
-- A single PUBLIC bucket the Node backend writes to and everyone may read from
-- via plain public object URLs (no signed URLs). Mutations stay backend-only:
-- the Node API uses the secret key, and NO client Storage policies are added.
--
-- file_size_limit is a hard safety ceiling (8 MB). The backend image
-- normalization step keeps application-produced objects well under this
-- (target <= 1 MB). allowed_mime_types mirrors the API's accepted images.
--
-- Buckets are created through storage.buckets SQL (officially supported), so
-- the bucket is versioned here rather than clicked in the dashboard.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'findback-images',
  'findback-images',
  true,
  8388608, -- 8 MB
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = now();
