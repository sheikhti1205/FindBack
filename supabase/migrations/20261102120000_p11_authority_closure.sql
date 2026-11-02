-- ===========================================================================
-- P11 — backend authority closure (Phase A/B/E of the P11 handoff).
--
-- One correction: the consumer authority model becomes
--   client -> narrow RPC -> validation/lifecycle -> tables
-- instead of a second, weaker path straight into PostgREST.
--
-- What this migration does, in order:
--   1. a private report-media bucket + authoritative staging/publish checks;
--   2. governed staging (client cannot invent a URL or rewrite staging rows);
--   3. definer-owned create/update/read RPCs where the grant is removed;
--   4. raw consumer write grants revoked on item_posts/attachments/uploads/
--      comments/comment_attachments/reaction+rating reads;
--   5. report-photo cleanup queue (delete -> object bytes removed, acked);
--   6. abandoned staging TTL purge;
--   7. comment media new-write governance (photos only) and legacy video kept
--      readable;
--   8. focused FK indexes and the remaining hot RLS initplan call.
--
-- Applied migrations are immutable; every object here is new or replaced.
-- ===========================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Private report-media bucket
-- ---------------------------------------------------------------------------
-- Report photos stop being permanent public objects. The bucket is private;
-- reads go through a short-lived signed URL that Storage only issues when the
-- caller can currently read the owning report (policy below). Avatars stay in
-- the existing public `findback-images` bucket: they are profile-public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'findback-report-media', 'findback-report-media', false, 8388608,
  array['image/jpeg','image/png','image/webp','image/gif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Attachment authority columns
-- ---------------------------------------------------------------------------
alter table public.attachments add column if not exists storage_path text;
comment on column public.attachments.storage_path
  is 'Authoritative storage object key in findback-report-media. Null only on legacy public-URL rows; new publishes always set it.';
comment on column public.attachments.file_url
  is 'Legacy absolute public URL (older rows) OR the storage key for private report-media rows. New rows always carry storage_path as the authority.';

alter table public.uploads add column if not exists object_key text;
comment on column public.uploads.object_key
  is 'Object key the caller uploaded and the server verified in findback-report-media. file_url mirrors it for legacy readers.';

create index if not exists attachments_storage_path_idx
  on public.attachments (storage_path);

do $$
begin
  if to_regclass('storage.objects') is null then
    raise exception 'storage.objects is required for report-media policies';
  end if;
end $$;

drop policy if exists findback_report_media_insert_own on storage.objects;
create policy findback_report_media_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'findback-report-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists findback_report_media_delete_own on storage.objects;
create policy findback_report_media_delete_own
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'findback-report-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- The uploader may read their own staged object (editor preview / retry).
drop policy if exists findback_report_media_select_own on storage.objects;
create policy findback_report_media_select_own
  on storage.objects for select to authenticated
  using (
    bucket_id = 'findback-report-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Published media is readable only while its report is readable by this caller
-- (owner visibility, moderation state, block/sanction rules all live in
-- findback_can_read_post_for). A hidden, deleted or non-visible report cannot
-- mint a URL, so the bytes stop being served.
--
-- The policy calls the caller-derived single-argument form on purpose: a policy
-- expression runs with the caller's privileges and the two-argument form is not
-- executable by `authenticated`, and letting a client pass an arbitrary viewer
-- id would also leak another account's visibility. `findback_can_read_post` is
-- already granted and binds the viewer to auth.uid() itself.
drop policy if exists findback_report_media_select_authorized on storage.objects;
create policy findback_report_media_select_authorized
  on storage.objects for select to authenticated
  using (
    bucket_id = 'findback-report-media'
    and exists (
      select 1
        from public.attachments a
       where a.storage_path = storage.objects.name
         and public.findback_can_read_post(a.post_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Governed staging: the client proves bytes, never metadata
-- ---------------------------------------------------------------------------
create or replace function public.findback_stage_upload(
  p_id text,
  p_object_key text,
  p_file_name text,
  p_mime_type text,
  p_file_size bigint,
  p_width integer default null,
  p_height integer default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp, storage
as $$
declare
  v_uid text := auth.uid()::text;
  v_ext text;
  v_key text;
  v_object_size bigint;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_id is null
     or p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid upload id' using errcode = '22023';
  end if;
  v_ext := case p_mime_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/gif' then 'gif'
  end;
  if v_ext is null then
    raise exception 'Unsupported photo type' using errcode = '22023';
  end if;
  if p_file_name is null or char_length(btrim(p_file_name)) not between 1 and 120 then
    raise exception 'Invalid file name' using errcode = '22023';
  end if;
  if p_file_size is null or p_file_size < 1 or p_file_size > 8388608 then
    raise exception 'Photo is too large' using errcode = '22023';
  end if;
  if (p_width is null) <> (p_height is null)
     or (p_width is not null and (p_width < 1 or p_width > 8192))
     or (p_height is not null and (p_height < 1 or p_height > 8192)) then
    raise exception 'Invalid photo dimensions' using errcode = '22023';
  end if;

  -- The key is derived, not trusted: caller folder + the staging id + the
  -- extension implied by the declared type. A client cannot point a staging
  -- row at another object, another account's folder, or a different file.
  v_key := v_uid || '/' || p_id || '.' || v_ext;
  if p_object_key is distinct from v_key then
    raise exception 'Staged object does not match this upload' using errcode = '22023';
  end if;

  select (o.metadata ->> 'size')::bigint
    into v_object_size
    from storage.objects o
   where o.bucket_id = 'findback-report-media'
     and o.name = v_key;
  if not found then
    raise exception 'Uploaded photo was not found in storage' using errcode = '22023';
  end if;
  if v_object_size is not null and v_object_size <> p_file_size then
    raise exception 'Uploaded photo size does not match' using errcode = '22023';
  end if;

  insert into public.uploads (
    id, user_id, file_name, mime_type, file_size, file_url, object_key,
    created_at, width, height
  ) values (
    p_id, v_uid, btrim(p_file_name), p_mime_type, p_file_size::integer, v_key, v_key,
    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    p_width, p_height
  );
  return p_id;
end;
$$;

revoke all on function public.findback_stage_upload(text,text,text,text,bigint,integer,integer)
  from public, anon;
grant execute on function public.findback_stage_upload(text,text,text,text,bigint,integer,integer)
  to authenticated;

create or replace function public.findback_discard_staged_upload(p_id text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_key text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select u.object_key into v_key
    from public.uploads u
   where u.id = p_id and u.user_id = v_uid
   for update;
  if not found then
    raise exception 'Staged upload not found' using errcode = '42501';
  end if;
  if v_key is not null then
    insert into public.report_media_cleanup_queue (bucket_id, object_key)
    values ('findback-report-media', v_key)
    on conflict (bucket_id, object_key) do nothing;
  end if;
  delete from public.uploads where id = p_id and user_id = v_uid;
  return true;
end;
$$;

revoke all on function public.findback_discard_staged_upload(text) from public, anon;
grant execute on function public.findback_discard_staged_upload(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Publish becomes the only writer of attachments and owns staging consume
-- ---------------------------------------------------------------------------
-- The functions are now SECURITY DEFINER: the table grants disappear below, and
-- each body keeps its own auth.uid() ownership checks (a definer call must never
-- trust the caller's session for ownership).
create or replace function public.findback_create_post_client(
  p_type text,
  p_title text,
  p_description text,
  p_category text,
  p_event_date text,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_location_label text default null,
  p_youtube_url text default null,
  p_attachment_key text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_id  text;
  v_now text;
  v_upload record;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  perform public.findback_validate_post_fields(
    p_type, p_title, p_description, p_category, p_event_date,
    p_latitude, p_longitude, p_location_label, p_youtube_url
  );

  v_id := gen_random_uuid()::text;
  v_now := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.item_posts (
    id, user_id, type, title, description, category, status, event_date,
    latitude, longitude, location_label, youtube_url, created_at, updated_at
  ) values (
    v_id, v_uid, p_type, btrim(p_title), btrim(p_description), p_category, 'OPEN',
    p_event_date, p_latitude, p_longitude,
    nullif(btrim(coalesce(p_location_label, '')), ''),
    nullif(btrim(coalesce(p_youtube_url, '')), ''),
    v_now, v_now
  );

  if p_attachment_key is not null and btrim(p_attachment_key) <> '' then
    select * into v_upload
      from public.uploads
     where id = p_attachment_key
       for update;
    if not found then
      raise exception 'Attachment key does not exist' using errcode = '22023';
    end if;
    if v_upload.user_id <> v_uid then
      raise exception 'Attachment was not uploaded by you' using errcode = '42501';
    end if;
    -- The staged bytes must still exist at publish. A staging row alone is not
    -- proof; otherwise a caller could publish a key whose object never landed.
    if v_upload.object_key is not null then
      if left(v_upload.object_key, char_length(v_uid) + 1) <> v_uid || '/'
         or position('..' in v_upload.object_key) > 0 then
        raise exception 'Attachment key is not yours' using errcode = '42501';
      end if;
      if not exists (
        select 1 from storage.objects o
         where o.bucket_id = 'findback-report-media'
           and o.name = v_upload.object_key
      ) then
        raise exception 'Staged photo is no longer available; upload it again'
          using errcode = '22023';
      end if;
    end if;
    insert into public.attachments (
      id, post_id, file_url, mime_type, file_name, file_size, created_at,
      width, height, storage_path
    ) values (
      gen_random_uuid()::text, v_id, coalesce(v_upload.object_key, v_upload.file_url),
      v_upload.mime_type, v_upload.file_name, v_upload.file_size, v_now,
      v_upload.width, v_upload.height, v_upload.object_key
    );
    delete from public.uploads
     where id = p_attachment_key and user_id = v_uid;
  end if;

  return v_id;
end;
$$;

revoke all on function public.findback_create_post_client(
  text, text, text, text, text, double precision, double precision, text, text, text
) from public, anon;
grant execute on function public.findback_create_post_client(
  text, text, text, text, text, double precision, double precision, text, text, text
) to authenticated;

create or replace function public.findback_create_post_client_multi(
  p_type text,
  p_title text,
  p_description text,
  p_category text,
  p_event_date text,
  p_attachment_keys text[] default '{}',
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_location_label text default null,
  p_youtube_url text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_id  text;
  v_now text;
  v_keys text[] := coalesce(p_attachment_keys, '{}');
  v_key text;
  v_pos integer := 0;
  v_upload record;
  v_deleted integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if array_length(v_keys, 1) > 5 then
    raise exception 'At most 5 attachments are allowed' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(v_keys) as k
     group by k having count(*) > 1
  ) then
    raise exception 'Duplicate attachment keys are not allowed' using errcode = '22023';
  end if;

  foreach v_key in array v_keys loop
    if v_key is null or btrim(v_key) = '' then
      raise exception 'Attachment key must not be empty' using errcode = '22023';
    end if;
  end loop;

  perform public.findback_validate_post_fields(
    p_type, p_title, p_description, p_category, p_event_date,
    p_latitude, p_longitude, p_location_label, p_youtube_url
  );

  v_id := gen_random_uuid()::text;
  v_now := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.item_posts (
    id, user_id, type, title, description, category, status, event_date,
    latitude, longitude, location_label, youtube_url, created_at, updated_at
  ) values (
    v_id, v_uid, p_type, btrim(p_title), btrim(p_description), p_category, 'OPEN',
    p_event_date, p_latitude, p_longitude,
    nullif(btrim(coalesce(p_location_label, '')), ''),
    nullif(btrim(coalesce(p_youtube_url, '')), ''),
    v_now, v_now
  );

  if cardinality(v_keys) > 0 then
    perform 1
      from public.uploads
     where id = any (v_keys)
     order by id
     for update;

    foreach v_key in array v_keys loop
      select * into v_upload
        from public.uploads
       where id = v_key;
      if not found then
        raise exception 'Attachment key does not exist' using errcode = '22023';
      end if;
      if v_upload.user_id <> v_uid then
        raise exception 'Attachment was not uploaded by you' using errcode = '42501';
      end if;
      if v_upload.object_key is not null then
        if left(v_upload.object_key, char_length(v_uid) + 1) <> v_uid || '/'
           or position('..' in v_upload.object_key) > 0 then
          raise exception 'Attachment key is not yours' using errcode = '42501';
        end if;
        if not exists (
          select 1 from storage.objects o
           where o.bucket_id = 'findback-report-media'
             and o.name = v_upload.object_key
        ) then
          raise exception 'Staged photo is no longer available; upload it again'
            using errcode = '22023';
        end if;
      end if;
      v_pos := v_pos + 1;
      insert into public.attachments (
        id, post_id, file_url, mime_type, file_name, file_size, created_at, display_order,
        width, height, storage_path
      ) values (
        gen_random_uuid()::text, v_id, coalesce(v_upload.object_key, v_upload.file_url),
        v_upload.mime_type, v_upload.file_name, v_upload.file_size, v_now, v_pos,
        v_upload.width, v_upload.height, v_upload.object_key
      );
    end loop;

    delete from public.uploads
     where id = any (v_keys) and user_id = v_uid;
    get diagnostics v_deleted = row_count;
    if v_deleted <> cardinality(v_keys) then
      raise exception 'Staging uploads changed during publish' using errcode = '40001';
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.findback_create_post_client_multi(
  text, text, text, text, text, text[], double precision, double precision, text, text
) from public, anon;
grant execute on function public.findback_create_post_client_multi(
  text, text, text, text, text, text[], double precision, double precision, text, text
) to authenticated;

-- Update keeps its body (explicit owner filter, field validation) and only
-- changes owner: the table write grant disappears below.
alter function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text, text[]
) security definer;

-- ---------------------------------------------------------------------------
-- 5. Report-photo lifecycle: queue, lease/ack, abandoned staging TTL
-- ---------------------------------------------------------------------------
-- Deleting a report (or its account) cascades attachment rows, never Storage
-- bytes. This queue records every exact owned key so a service-role worker can
-- remove the object and acknowledge it; a failure leaves retryable work.
create table if not exists public.report_media_cleanup_queue (
  id text primary key default gen_random_uuid()::text,
  bucket_id text not null default 'findback-report-media',
  object_key text not null,
  enqueued_at timestamptz not null default clock_timestamp(),
  leased_at timestamptz null,
  attempts integer not null default 0,
  unique (bucket_id, object_key)
);

alter table public.report_media_cleanup_queue enable row level security;
revoke all on public.report_media_cleanup_queue from public, anon, authenticated;

comment on table public.report_media_cleanup_queue
  is 'P11: orphaned report-media bytes. Producer = attachment delete / discard / stale-staging purge. Consumer = cleanup-report-media worker; rows are deleted only after Storage removal succeeds.';

create or replace function public.enqueue_report_media_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.storage_path is not null then
    insert into public.report_media_cleanup_queue (bucket_id, object_key)
    values ('findback-report-media', old.storage_path)
    on conflict (bucket_id, object_key) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function public.enqueue_report_media_cleanup() from public, anon, authenticated;

drop trigger if exists attachments_report_media_cleanup on public.attachments;
create trigger attachments_report_media_cleanup
  after delete on public.attachments
  for each row execute function public.enqueue_report_media_cleanup();

create or replace function public.claim_report_media_cleanup(p_limit integer default 100)
returns table (bucket_id text, object_key text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 1000));
  v_stale_cutoff timestamptz := now() - interval '15 minutes';
begin
  return query
    with batch as (
      select q.id
        from public.report_media_cleanup_queue q
       where q.leased_at is null or q.leased_at < v_stale_cutoff
       order by q.enqueued_at asc, q.id asc
       limit v_limit
       for update skip locked
    )
    update public.report_media_cleanup_queue q
       set leased_at = now(),
           attempts = q.attempts + 1
      from batch b
     where q.id = b.id
    returning q.bucket_id, q.object_key;
end;
$$;

revoke all on function public.claim_report_media_cleanup(integer) from public, anon, authenticated;
grant execute on function public.claim_report_media_cleanup(integer) to service_role;

create or replace function public.ack_report_media_cleanup(p_bucket_id text, p_keys text[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keys text[] := coalesce(p_keys, '{}');
  v_deleted integer;
begin
  if cardinality(v_keys) = 0 then
    return 0;
  end if;
  if cardinality(v_keys) > 1000 then
    raise exception 'ack batch too large (max 1000 keys)' using errcode = '22023';
  end if;
  delete from public.report_media_cleanup_queue q
   where q.bucket_id = p_bucket_id
     and q.object_key = any (v_keys);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.ack_report_media_cleanup(text,text[]) from public, anon, authenticated;
grant execute on function public.ack_report_media_cleanup(text,text[]) to service_role;

-- Abandoned staging: the client rollback path is best-effort, so an independent
-- sweeper with an explicit grace period is required. Only unconsumed staging
-- rows whose object was never published are touched; published attachments live
-- in a different table and are never visible here.
create or replace function public.purge_abandoned_staging_uploads(
  p_limit integer default 200,
  p_grace interval default interval '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 1000));
  v_grace interval := greatest(coalesce(p_grace, interval '24 hours'), interval '1 hour');
  v_deleted integer := 0;
begin
  with stale as (
    select u.id, u.object_key
      from public.uploads u
     where (u.created_at)::timestamptz < now() - v_grace
     order by u.created_at asc, u.id asc
     limit v_limit
     for update skip locked
  ), queued as (
    insert into public.report_media_cleanup_queue (bucket_id, object_key)
    select 'findback-report-media', s.object_key
      from stale s
     where s.object_key is not null
    on conflict (bucket_id, object_key) do nothing
    returning 1
  ), removed as (
    delete from public.uploads u
     using stale s
     where u.id = s.id
    returning u.id
  )
  select count(*) into v_deleted from removed;
  return coalesce(v_deleted, 0);
end;
$$;

revoke all on function public.purge_abandoned_staging_uploads(integer,interval)
  from public, anon, authenticated;
grant execute on function public.purge_abandoned_staging_uploads(integer,interval)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Comment media: legacy bytes keep rendering, new video intake is closed
-- ---------------------------------------------------------------------------
-- The bucket's MIME list is the server-side gate a custom client cannot skip.
-- Existing video objects are untouched: the list only constrains new uploads.
update storage.buckets
   set allowed_mime_types = array[
         'image/jpeg','image/jpg','image/png','image/webp','image/gif',
         'image/heic','image/heif','image/avif','image/bmp'
       ]
 where id = 'findback-comment-media';

drop policy if exists findback_comment_media_insert_own on storage.objects;
create policy findback_comment_media_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'findback-comment-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~* '\.(jpg|jpeg|png|webp|gif|heic|heif|avif|bmp)$'
  );

create or replace function public.findback_reject_new_comment_video()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind = 'video' then
    raise exception 'Video can no longer be attached to a comment'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.findback_reject_new_comment_video()
  from public, anon, authenticated;

drop trigger if exists comment_attachments_no_new_video on public.comment_attachments;
create trigger comment_attachments_no_new_video
  before insert on public.comment_attachments
  for each row execute function public.findback_reject_new_comment_video();

-- Comment photos stay in their governed bucket (see P11 report); direct row
-- writes are revoked below, so only findback_add_comment_with_attachments (and
-- its internal definer) can create an attachment row.

-- Every path the app actually uses is an RPC above. These revokes close the
-- alternate PostgREST/GraphQL path that skipped validation and lifecycle.
revoke insert, update, delete on public.item_posts from authenticated;
revoke insert, update, delete on public.attachments from authenticated;
revoke insert, update, delete on public.uploads from authenticated;
revoke insert, delete on public.comments from authenticated;
revoke insert, update, delete on public.comment_attachments from authenticated;

-- Reacting/rating account ids are not part of the consumer model (like count +
-- liked-by-me are). Readers are definer RPCs; the base tables stop being
-- directly readable.
revoke select on public.reactions from authenticated;
revoke select on public.ratings from authenticated;
revoke select on public.comment_reactions from authenticated;

-- Column-level grants survive a table-level REVOKE, so every surviving column
-- privilege is revoked explicitly. One statement per table, listing exactly the
-- grants that exist: a future column grant added without a matching revoke here
-- shows up as a write the client still holds.
revoke insert (category, created_at, description, event_date, id, latitude,
               location_label, longitude, moderation_visibility, status, title,
               type, updated_at, user_id, youtube_url)
  on public.item_posts from authenticated;
revoke update (category, created_at, description, event_date, id, latitude,
               location_label, longitude, moderation_visibility, status, title,
               type, updated_at, user_id, youtube_url)
  on public.item_posts from authenticated;
revoke insert (body, created_at, depth, id, parent_id, post_id, updated_at, user_id)
  on public.comments from authenticated;
revoke all (id, post_id, type, user_id) on public.reactions from authenticated;
revoke all (id, post_id, score) on public.ratings from authenticated;
revoke all (comment_id, id, type) on public.comment_reactions from authenticated;
revoke update (id) on public.uploads from authenticated;

-- The two new lifecycle columns duplicate what the client already reads
-- (`uploads.file_url`, `attachments.file_url`), so keeping them readable adds no
-- information; naming them here keeps every column of the media tables covered
-- instead of leaving two silent gaps in the read contract.
grant select (object_key) on public.uploads to authenticated;
grant select (storage_path) on public.attachments to authenticated;

-- The pre-P1 alternate match reader reads `reactions`/`ratings` directly,
-- which the client can no longer read, so it must stop running as the caller.
-- It cannot simply be deleted: the 20261022160000 contract is still asserted
-- by the full-chain behaviour probe and by the projection-parity test.
--
-- `findback_visible_posts` is security_invoker WITH NO WHERE of its own (the
-- predicate lives in the item_posts SELECT policy), so a definer body would
-- bypass RLS and propose hidden reports. The atom is therefore evaluated
-- explicitly here, exactly as the other P11 readers do.

create or replace function public.findback_match_candidates_client(
  p_target_id text,
  p_limit integer default 20
)
returns table (
  id text,
  user_id text,
  type text,
  title text,
  description text,
  category text,
  status text,
  event_date text,
  latitude double precision,
  longitude double precision,
  location_label text,
  youtube_url text,
  created_at text,
  updated_at text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text,
  like_count bigint,
  dislike_count bigint,
  rating_avg numeric,
  rating_count bigint,
  comment_count bigint,
  attachments jsonb,
  total_count bigint,
  reaction_counts jsonb,
  reaction_total bigint,
  my_reaction text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with target as (
    -- The target is read from the VISIBLE view, so a caller cannot point the
    -- reader at a report they are not allowed to see. An invisible target
    -- leaves the cross join empty and the reader returns nothing.
    select t.id, t.type
    from public.findback_visible_posts t
    where t.id = p_target_id
      -- P11: this body is DEFINER and the view is security_invoker
      -- with no WHERE of its own, so the policy atom is evaluated HERE.
      and public.findback_can_read_post(t.id)
  ),
  filtered as (
    select
      c.*,
      u.username as author_username,
      u.email_verified as author_email_verified,
      u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url,
      u.created_at as author_created_at,
      (select count(r.id) from reactions r where r.post_id = c.id and r.type = 'LIKE') as like_count,
      (select count(r.id) from reactions r where r.post_id = c.id and r.type = 'DISLIKE') as dislike_count,
      (select avg(ra.score) from ratings ra where ra.post_id = c.id) as rating_avg,
      (select count(ra.id) from ratings ra where ra.post_id = c.id) as rating_count,
      (select count(cm.id) from comments cm where cm.post_id = c.id) as comment_count,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'post_id', a.post_id,
            'file_url', a.file_url,
            'mime_type', a.mime_type,
            'file_name', a.file_name,
            'file_size', a.file_size,
            'created_at', a.created_at,
            'display_order', a.display_order,
            'width', a.width,
            'height', a.height
          ) order by a.display_order asc, a.created_at asc, a.id asc
        )
        from attachments a
        where a.post_id = c.id
      ), '[]'::jsonb) as attachments,
      count(*) over() as total_count,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                 count(*) as n
          from public.reactions r
          where r.post_id = c.id
          group by 1
        ) t
      ), '{}'::jsonb) as reaction_counts,
      (select count(r.id) from reactions r where r.post_id = c.id) as reaction_total,
      (select r.type from reactions r
        where r.post_id = c.id and r.user_id = auth.uid()::text
        limit 1) as my_reaction
    from public.findback_visible_posts c
    join users u on u.id = c.user_id
    cross join target t
    where
      c.type <> t.type                                   -- a LOST report matches a FOUND one and the other way round
      and c.status = 'OPEN'                              -- only an open report can still be the answer
      and c.id <> t.id                                   -- never the target itself
      and c.user_id <> (select auth.uid())::text         -- never the reader's own report
      and not c.blocked_author                           -- THE DECISION: a blocked counterpart is not proposed
      and public.findback_can_read_post(c.id)
  )
  select
    id,
    user_id,
    type,
    title,
    description,
    category,
    status,
    event_date,
    latitude,
    longitude,
    location_label,
    youtube_url,
    created_at,
    updated_at,
    author_username,
    author_email_verified,
    author_phone_verified,
    author_avatar_url,
    author_created_at,
    like_count,
    dislike_count,
    rating_avg,
    rating_count,
    comment_count,
    attachments,
    total_count,
    reaction_counts,
    reaction_total,
    my_reaction
  from filtered
  order by created_at desc, id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 20);
$$;

revoke all on function public.findback_match_candidates_client(text, integer)
  from public, anon;
grant execute on function public.findback_match_candidates_client(text, integer)
  to authenticated;

comment on function public.findback_match_candidates_client(text, integer) is
  'Match-candidate reader (pinned 20261022160000 contract). P11: SECURITY DEFINER because the client lost raw reactions/ratings reads; candidates are filtered by findback_can_read_post because the security_invoker view carries no WHERE. The shipping caller uses findback_match_candidates_v2.';

-- Policies whose only writer grant is gone. Keeping them would advertise an
-- authority that no longer exists.
drop policy if exists item_posts_insert_own on public.item_posts;
drop policy if exists item_posts_update_own on public.item_posts;
drop policy if exists item_posts_delete_own on public.item_posts;
drop policy if exists attachments_insert_own on public.attachments;
drop policy if exists uploads_insert_own on public.uploads;
drop policy if exists uploads_delete_own on public.uploads;
drop policy if exists uploads_lock_own on public.uploads;
drop policy if exists comments_insert_own on public.comments;
drop policy if exists comments_delete_own on public.comments;
drop policy if exists comment_attachments_insert_own on public.comment_attachments;
drop policy if exists comment_attachments_update_own on public.comment_attachments;
drop policy if exists comment_attachments_delete_own on public.comment_attachments;
drop policy if exists reactions_insert_own on public.reactions;
drop policy if exists reactions_delete_own on public.reactions;
drop policy if exists comment_reactions_insert_own on public.comment_reactions;
drop policy if exists comment_reactions_delete_own on public.comment_reactions;
drop policy if exists ratings_select_authenticated on public.ratings;
drop policy if exists reactions_select_authenticated on public.reactions;
drop policy if exists comment_reactions_select_authenticated on public.comment_reactions;

-- Remaining hot read policy: evaluate auth.uid() once per statement, not per row.
alter policy comment_attachments_select_own on public.comment_attachments
  using (
    ((kind <> 'report'::text) and (user_id = (select auth.uid())::text))
    or (
      (kind = 'report'::text)
      and findback_can_read_comment(comment_id)
      and (report_post_id is null or findback_can_read_post(report_post_id))
    )
  );

-- ---------------------------------------------------------------------------
-- 8. Read RPCs that now stand in for the revoked table reads
-- ---------------------------------------------------------------------------
-- These keep their exact signatures and projections. They become SECURITY
-- DEFINER because the caller no longer holds SELECT on reactions/ratings, and
-- each one gains the visibility predicate RLS used to supply implicitly.

CREATE OR REPLACE FUNCTION public.findback_query_posts_client(p_user_id text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_q text DEFAULT NULL::text, p_date_from text DEFAULT NULL::text, p_date_to text DEFAULT NULL::text, p_cursor_created_at text DEFAULT NULL::text, p_cursor_id text DEFAULT NULL::text, p_order text DEFAULT 'desc'::text, p_limit integer DEFAULT 10, p_post_id text DEFAULT NULL::text)
 RETURNS TABLE(id text, user_id text, type text, title text, description text, category text, status text, event_date text, latitude double precision, longitude double precision, location_label text, youtube_url text, created_at text, updated_at text, author_username text, author_email_verified integer, author_phone_verified integer, author_avatar_url text, author_created_at text, like_count bigint, dislike_count bigint, rating_avg numeric, rating_count bigint, comment_count bigint, attachments jsonb, total_count bigint, reaction_counts jsonb, reaction_total bigint, my_reaction text, blocked_author boolean)
 LANGUAGE sql
 SECURITY DEFINER
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with filtered as (
    select
      p.*,
      u.username as author_username,
      u.email_verified as author_email_verified,
      u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url,
      u.created_at as author_created_at,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'LIKE') as like_count,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'DISLIKE') as dislike_count,
      (select avg(ra.score) from ratings ra where ra.post_id = p.id) as rating_avg,
      (select count(ra.id) from ratings ra where ra.post_id = p.id) as rating_count,
      (select count(c.id) from comments c where c.post_id = p.id and findback_can_read_comment(c.id)) as comment_count,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'post_id', a.post_id,
            'file_url', a.file_url,
            'mime_type', a.mime_type,
            'file_name', a.file_name,
            'file_size', a.file_size,
            'created_at', a.created_at,
            'display_order', a.display_order,
            'width', a.width,
            'height', a.height
          ) order by a.display_order asc, a.created_at asc, a.id asc
        )
        from attachments a
        where a.post_id = p.id
      ), '[]'::jsonb) as attachments,
      count(*) over() as total_count,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                 count(*) as n
          from public.reactions r
          where r.post_id = p.id
          group by 1
        ) t
      ), '{}'::jsonb) as reaction_counts,
      (select count(r.id) from reactions r where r.post_id = p.id) as reaction_total,
      (select r.type from reactions r
        where r.post_id = p.id and r.user_id = auth.uid()::text
        limit 1) as my_reaction
    from public.findback_visible_posts p
    join users u on u.id = p.user_id
    where
      findback_can_read_post(p.id)
      and       (p_post_id is null or p.id = p_post_id)
      and (p_user_id is null or p.user_id = p_user_id)
      and (p_type is null or p.type = p_type)
      and (p_category is null or p.category = p_category)
      and (p_status is null or p.status = p_status)
      and (
        p_q is null
        or lower(p.title) like '%' || lower(p_q) || '%'
        or lower(p.description) like '%' || lower(p_q) || '%'
      )
      and (p_date_from is null or p.event_date >= p_date_from)
      and (p_date_to is null or p.event_date <= p_date_to)
  )
  select
    id,
    user_id,
    type,
    title,
    description,
    category,
    status,
    event_date,
    latitude,
    longitude,
    location_label,
    youtube_url,
    created_at,
    updated_at,
    author_username,
    author_email_verified,
    author_phone_verified,
    author_avatar_url,
    author_created_at,
    like_count,
    dislike_count,
    rating_avg,
    rating_count,
    comment_count,
    attachments,
    total_count,
    reaction_counts,
    reaction_total,
    my_reaction,
    blocked_author
  from filtered
  where
    p_cursor_created_at is null
    or (
      p_order = 'asc'
      and (
        created_at > p_cursor_created_at
        or (created_at = p_cursor_created_at and id > coalesce(p_cursor_id, ''))
      )
    )
    or (
      p_order <> 'asc'
      and (
        created_at < p_cursor_created_at
        or (created_at = p_cursor_created_at and id < coalesce(p_cursor_id, ''))
      )
    )
  order by
    (case when p_order = 'asc' then created_at end) asc,
    (case when p_order = 'asc' then id end) asc,
    (case when p_order <> 'asc' then created_at end) desc,
    (case when p_order <> 'asc' then id end) desc
  limit least(greatest(p_limit, 0), 20);
$function$
;


CREATE OR REPLACE FUNCTION public.findback_query_posts_nearby_client(p_user_id text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_q text DEFAULT NULL::text, p_date_from text DEFAULT NULL::text, p_date_to text DEFAULT NULL::text, p_cursor_created_at text DEFAULT NULL::text, p_cursor_id text DEFAULT NULL::text, p_order text DEFAULT 'desc'::text, p_limit integer DEFAULT 10, p_near_lat double precision DEFAULT NULL::double precision, p_near_lng double precision DEFAULT NULL::double precision, p_radius_m double precision DEFAULT NULL::double precision)
 RETURNS TABLE(id text, user_id text, type text, title text, description text, category text, status text, event_date text, latitude double precision, longitude double precision, location_label text, youtube_url text, created_at text, updated_at text, author_username text, author_email_verified integer, author_phone_verified integer, author_avatar_url text, author_created_at text, like_count bigint, dislike_count bigint, rating_avg numeric, rating_count bigint, comment_count bigint, attachments jsonb, total_count bigint, reaction_counts jsonb, reaction_total bigint, my_reaction text, blocked_author boolean)
 LANGUAGE sql
 SECURITY DEFINER
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with filtered as (
    select
      p.*,
      u.username as author_username,
      u.email_verified as author_email_verified,
      u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url,
      u.created_at as author_created_at,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'LIKE') as like_count,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'DISLIKE') as dislike_count,
      (select avg(ra.score) from ratings ra where ra.post_id = p.id) as rating_avg,
      (select count(ra.id) from ratings ra where ra.post_id = p.id) as rating_count,
      (select count(c.id) from comments c where c.post_id = p.id and findback_can_read_comment(c.id)) as comment_count,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'post_id', a.post_id,
            'file_url', a.file_url,
            'mime_type', a.mime_type,
            'file_name', a.file_name,
            'file_size', a.file_size,
            'created_at', a.created_at,
            'display_order', a.display_order,
            'width', a.width,
            'height', a.height
          ) order by a.display_order asc, a.created_at asc, a.id asc
        )
        from attachments a
        where a.post_id = p.id
      ), '[]'::jsonb) as attachments,
      count(*) over() as total_count,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                 count(*) as n
          from public.reactions r
          where r.post_id = p.id
          group by 1
        ) t
      ), '{}'::jsonb) as reaction_counts,
      (select count(r.id) from reactions r where r.post_id = p.id) as reaction_total,
      (select r.type from reactions r
        where r.post_id = p.id and r.user_id = auth.uid()::text
        limit 1) as my_reaction
    from public.findback_visible_posts p
    join users u on u.id = p.user_id
    where
      findback_can_read_post(p.id)
      and       (p_user_id is null or p.user_id = p_user_id)
      and (p_type is null or p.type = p_type)
      and (p_category is null or p.category = p_category)
      and (p_status is null or p.status = p_status)
      and (
        p_q is null
        or lower(p.title) like '%' || lower(p_q) || '%'
        or lower(p.description) like '%' || lower(p_q) || '%'
      )
      and (p_date_from is null or p.event_date >= p_date_from)
      and (p_date_to is null or p.event_date <= p_date_to)
      -- Only rows with numeric coordinates can be proven nearby; typed-only
      -- posts are excluded from this scope by design.
      and p.latitude is not null
      and p.longitude is not null
      and (
        p_near_lat is null
        or p_near_lng is null
        or p_radius_m is null
        or (
          6371000 * 2 * asin(sqrt(least(1, greatest(0,
            power(sin(radians(p.latitude - p_near_lat) / 2), 2)
            + cos(radians(p_near_lat)) * cos(radians(p.latitude))
              * power(sin(radians(p.longitude - p_near_lng) / 2), 2)
          )))) <= p_radius_m
        )
      )
  )
  select
    id,
    user_id,
    type,
    title,
    description,
    category,
    status,
    event_date,
    latitude,
    longitude,
    location_label,
    youtube_url,
    created_at,
    updated_at,
    author_username,
    author_email_verified,
    author_phone_verified,
    author_avatar_url,
    author_created_at,
    like_count,
    dislike_count,
    rating_avg,
    rating_count,
    comment_count,
    attachments,
    total_count,
    reaction_counts,
    reaction_total,
    my_reaction,
    blocked_author
  from filtered
  where
    p_cursor_created_at is null
    or (
      p_order = 'asc'
      and (
        created_at > p_cursor_created_at
        or (created_at = p_cursor_created_at and id > coalesce(p_cursor_id, ''))
      )
    )
    or (
      p_order <> 'asc'
      and (
        created_at < p_cursor_created_at
        or (created_at = p_cursor_created_at and id < coalesce(p_cursor_id, ''))
      )
    )
  order by
    (case when p_order = 'asc' then created_at end) asc,
    (case when p_order = 'asc' then id end) asc,
    (case when p_order <> 'asc' then created_at end) desc,
    (case when p_order <> 'asc' then id end) desc
  limit least(greatest(p_limit, 0), 20);
$function$
;


CREATE OR REPLACE FUNCTION public.findback_match_candidates_v2(p_target_id text, p_limit integer DEFAULT 80)
 RETURNS TABLE(id text, user_id text, type text, title text, description text, category text, status text, event_date text, latitude double precision, longitude double precision, location_label text, youtube_url text, created_at text, updated_at text, author_username text, author_email_verified integer, author_phone_verified integer, author_avatar_url text, author_created_at text, like_count bigint, dislike_count bigint, rating_avg numeric, rating_count bigint, comment_count bigint, attachments jsonb, total_count bigint, reaction_counts jsonb, reaction_total bigint, my_reaction text)
 LANGUAGE sql
 SECURITY DEFINER
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with target as materialized (
    select t.*,
      tsvector_to_array(to_tsvector('pg_catalog.simple',
        left(coalesce(t.title,''),512)||' '||left(coalesce(t.description,''),4096)||' '||
        left(coalesce(t.location_label,''),512))) as words,
      case when t.event_date ~ '^\d{4}-\d{2}-\d{2}$'
        and pg_input_is_valid(t.event_date,'date') then t.event_date::date end as event_day
    from public.findback_visible_posts t
    where t.id=p_target_id and t.status='OPEN' and not t.blocked_author and findback_can_read_post(t.id)
      and (select auth.uid()) is not null
  ), eligible as (
    select c.*, u.username as author_username,
      u.email_verified as author_email_verified, u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url, u.created_at as author_created_at,
      t.category as target_category, t.words as target_words, t.event_day as target_day,
      t.latitude as target_latitude, t.longitude as target_longitude,
      tsvector_to_array(to_tsvector('pg_catalog.simple',
        left(coalesce(c.title,''),512)||' '||left(coalesce(c.description,''),4096)||' '||
        left(coalesce(c.location_label,''),512))) as words,
      case when c.event_date ~ '^\d{4}-\d{2}-\d{2}$'
        and pg_input_is_valid(c.event_date,'date') then c.event_date::date end as event_day,
      case when left(c.created_at,10) ~ '^\d{4}-\d{2}-\d{2}$'
        and pg_input_is_valid(left(c.created_at,10),'date') then left(c.created_at,10)::date end as created_day
    from public.findback_visible_posts c
    join public.users u on u.id=c.user_id
    cross join target t
    where c.type<>t.type and c.status='OPEN' and c.id<>t.id and findback_can_read_post(c.id)
      and c.user_id<>(select auth.uid())::text and c.user_id<>t.user_id
      and not c.blocked_author
  ), scored as (
    select e.*,
      0.35 * case when e.category=e.target_category then 1 else 0 end
      + 0.35 * (select count(*)::double precision from unnest(e.words) w
          where w=any(e.target_words)) / greatest(cardinality(e.words),cardinality(e.target_words),1)
      + case when e.event_day is not null and e.target_day is not null
          then 0.15/(1+abs(e.event_day-e.target_day)/30.0) else 0 end
      + case when e.latitude between -90 and 90 and e.longitude between -180 and 180
          and e.target_latitude between -90 and 90 and e.target_longitude between -180 and 180
          then 0.10/(1+6371*acos(least(1.0,greatest(-1.0,
            sin(radians(e.latitude))*sin(radians(e.target_latitude))
            +cos(radians(e.latitude))*cos(radians(e.target_latitude))
             *cos(radians(e.longitude-e.target_longitude)))))/25) else 0 end
      + case when e.created_day is not null
          then 0.05/(1+greatest(current_date-e.created_day,0)/30.0) else 0 end as relevance
    from eligible e
  ), pool as materialized (
    select s.*, count(*) over() as total_count
    from scored s
    order by relevance desc, created_at desc, id desc
    limit least(greatest(coalesce(p_limit,80),1),80)
  )
  -- Expensive social/media projection happens only after relevance selection.
  select c.id, c.user_id, c.type, c.title, c.description, c.category, c.status,
    c.event_date, c.latitude, c.longitude, c.location_label, c.youtube_url,
    c.created_at, c.updated_at, c.author_username, c.author_email_verified,
    c.author_phone_verified, c.author_avatar_url, c.author_created_at,
    (select count(r.id) from public.reactions r where r.post_id=c.id and r.type='LIKE'),
    (select count(r.id) from public.reactions r where r.post_id=c.id and r.type='DISLIKE'),
    (select avg(r.score) from public.ratings r where r.post_id=c.id),
    (select count(r.id) from public.ratings r where r.post_id=c.id),
    (select count(cm.id) from public.comments cm where cm.post_id=c.id and findback_can_read_comment(cm.id)),
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'post_id',a.post_id,'file_url',a.file_url,'mime_type',a.mime_type,
      'file_name',a.file_name,'file_size',a.file_size,'created_at',a.created_at,
      'display_order',a.display_order,'width',a.width,'height',a.height)
      order by a.display_order asc,a.created_at asc,a.id asc)
      from public.attachments a where a.post_id=c.id),'[]'::jsonb),
    c.total_count,
    coalesce((select jsonb_object_agg(r.kind,r.n) from (
      select case when rx.type='LIKE' then 'LOVE' else rx.type end as kind,count(*) as n
      from public.reactions rx where rx.post_id=c.id group by 1
    ) r),'{}'::jsonb),
    (select count(r.id) from public.reactions r where r.post_id=c.id),
    (select r.type from public.reactions r where r.post_id=c.id and r.user_id=auth.uid()::text limit 1)
  from pool c
  order by c.relevance desc,c.created_at desc,c.id desc;
$function$
;


CREATE OR REPLACE FUNCTION public.findback_feed_reaction_state_client(p_post_ids text[])
 RETURNS TABLE(post_id text, my_reaction text, my_rating integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid text := auth.uid()::text;
  v_n integer := coalesce(array_length(p_post_ids, 1), 0);
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if v_n > 20 then
    raise exception 'At most 20 post ids per call' using errcode = '22023';
  end if;

  return query
    select
      u.pid,
      (select r.type from public.reactions r
        where r.id = md5('reaction|' || u.pid || '|' || v_uid)),
      (select ra.score from public.ratings ra
        where ra.id = md5('rating|' || u.pid || '|' || v_uid))
    from unnest(p_post_ids) as u(pid);
end;
$function$
;


CREATE OR REPLACE FUNCTION public.findback_post_social_state_client(p_post_id text)
 RETURNS TABLE(my_reaction text, my_rating integer)
 LANGUAGE sql
 SECURITY DEFINER
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    (select r.type from public.reactions r
      where r.id = md5('reaction|' || p_post_id || '|' || auth.uid()::text)),
    (select ra.score from public.ratings ra
      where ra.id = md5('rating|' || p_post_id || '|' || auth.uid()::text));
$function$
;



-- ---------------------------------------------------------------------------
-- 8b. Message-scoped chat wake claim
-- ---------------------------------------------------------------------------
-- The scheduler (`push-dispatch`, every 10 minutes) is the backstop. This
-- claim exists so the sender's own client can wake exactly the devices that
-- belong to ONE message right after it lands, instead of the recipient
-- learning about a live conversation up to ten minutes later.
--
-- Service-role only. The actor is re-checked against the message sender here,
-- so even a misused service key cannot wake a third party's devices for a
-- message that account did not send.
create or replace function public.findback_claim_chat_external_wakes_for_message(
  p_message_id text,
  p_actor text,
  p_limit integer default 100
)
returns table(wake_id text, device_id text, claim_token text)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if p_message_id is null or p_actor is null then
    return;
  end if;
  if not exists (
    select 1 from public.chat_messages m
     where m.id = p_message_id and m.sender_id = p_actor
  ) then
    return;
  end if;
  delete from public.chat_external_wakes where expires_at < clock_timestamp();
  return query
    with due as (
      select d.wake_id, d.device_id
        from public.chat_external_wake_devices d
        join public.chat_external_wakes w on w.id = d.wake_id
       where w.message_id = p_message_id
         and w.expires_at > clock_timestamp()
         and d.attempts < 5
         and (
           (d.state = 'PENDING' and d.next_attempt_at <= clock_timestamp())
           or (d.state = 'CLAIMED' and d.lease_until < clock_timestamp())
         )
       order by d.device_id
       limit least(greatest(coalesce(p_limit, 100), 1), 100)
       for update of d skip locked
    ), claimed as (
      update public.chat_external_wake_devices d
         set state = 'CLAIMED',
             claim_token = gen_random_uuid()::text,
             lease_until = clock_timestamp() + interval '2 minutes',
             attempts = d.attempts + 1
        from due
       where d.wake_id = due.wake_id and d.device_id = due.device_id
      returning d.wake_id, d.device_id, d.claim_token
    )
    select claimed.wake_id, claimed.device_id, claimed.claim_token from claimed;
end;
$$;

revoke all on function public.findback_claim_chat_external_wakes_for_message(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.findback_claim_chat_external_wakes_for_message(text, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 9. Focused FK indexes (hot read + deletion/cascade paths only)
-- ---------------------------------------------------------------------------
create index if not exists appeals_moderation_action_idx on public.appeals (moderation_action_id);
create index if not exists appeals_resolved_by_idx on public.appeals (resolved_by);
create index if not exists appeals_sanction_idx on public.appeals (sanction_id);
create index if not exists chat_conversations_initiated_by_idx on public.chat_conversations (initiated_by);
create index if not exists chat_external_wakes_conversation_idx on public.chat_external_wakes (conversation_id);
create index if not exists chat_mailbox_conversation_idx on public.chat_mailbox (conversation_id);
create index if not exists chat_media_attachments_author_idx on public.chat_media_attachments (author_id);
create index if not exists chat_media_attachments_conversation_idx on public.chat_media_attachments (conversation_id);
create index if not exists chat_messages_unsent_by_idx on public.chat_messages (unsent_by);
create index if not exists comment_attachments_user_idx on public.comment_attachments (user_id);
create index if not exists notifications_actor_idx on public.notifications (actor_id);
create index if not exists notifications_comment_idx on public.notifications (comment_id);
create index if not exists notifications_post_idx on public.notifications (post_id);
create index if not exists successful_returns_confirmed_by_idx on public.successful_returns (confirmed_by);
create index if not exists successful_returns_found_post_idx on public.successful_returns (found_post_id);

commit;
