-- FindBack — direct authenticated post mutations (Block 10E).
--
-- Mobile creates and changes the status of its own posts straight through the
-- Data API instead of the Node API. (The Node routes stay as reference until
-- 10K.) Uploads remain Node-backed until 10H, so create still accepts a staging
-- `uploads` id.
--
-- Design: narrow SECURITY INVOKER RPCs. The actor is always auth.uid()::text —
-- a caller-controlled owner is never accepted. Table writes are gated by
-- least-privilege grants plus owner-scoped RLS (UPDATE has USING + WITH CHECK),
-- so even a direct table attempt cannot touch another user's row.

-- ---------------------------------------------------------------------------
-- Grants + owner-scoped write policies
-- ---------------------------------------------------------------------------
grant insert on public.item_posts to authenticated;
grant update (
  type, title, description, category, status, event_date, latitude, longitude,
  location_label, youtube_url, updated_at
) on public.item_posts to authenticated;
grant delete on public.item_posts to authenticated;

grant insert on public.attachments to authenticated;

-- The create RPC validates a staging upload; the caller may read only its own.
grant select (id, user_id, file_name, mime_type, file_size, file_url, created_at)
  on public.uploads to authenticated;

drop policy if exists item_posts_insert_own on public.item_posts;
create policy item_posts_insert_own
  on public.item_posts for insert to authenticated
  with check (user_id = auth.uid()::text);

drop policy if exists item_posts_update_own on public.item_posts;
create policy item_posts_update_own
  on public.item_posts for update to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists item_posts_delete_own on public.item_posts;
create policy item_posts_delete_own
  on public.item_posts for delete to authenticated
  using (user_id = auth.uid()::text);

drop policy if exists attachments_insert_own on public.attachments;
create policy attachments_insert_own
  on public.attachments for insert to authenticated
  with check (
    exists (
      select 1 from public.item_posts p
      where p.id = attachments.post_id
        and p.user_id = auth.uid()::text
    )
  );

drop policy if exists uploads_select_own on public.uploads;
create policy uploads_select_own
  on public.uploads for select to authenticated
  using (user_id = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Shared validation + a mutation-safe timestamp.
-- PostgREST maps 22023 -> 400 and 42501 -> 403.
-- ---------------------------------------------------------------------------
create or replace function public.findback_validate_post_fields(
  p_type text,
  p_title text,
  p_description text,
  p_category text,
  p_event_date text,
  p_latitude double precision,
  p_longitude double precision,
  p_location_label text,
  p_youtube_url text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_type is null or p_type not in ('LOST', 'FOUND') then
    raise exception 'Invalid post type' using errcode = '22023';
  end if;
  if p_title is null or char_length(btrim(p_title)) < 3
     or char_length(btrim(p_title)) > 120 then
    raise exception 'Title must be 3-120 characters' using errcode = '22023';
  end if;
  if p_description is null or char_length(btrim(p_description)) < 10
     or char_length(btrim(p_description)) > 3000 then
    raise exception 'Description must be 10-3000 characters' using errcode = '22023';
  end if;
  if p_category is null or p_category not in (
    'Electronics', 'Bags & Wallets', 'Keys', 'Documents & IDs',
    'Books & Stationery', 'Clothing', 'Accessories & Jewelry', 'Other'
  ) then
    raise exception 'Invalid category' using errcode = '22023';
  end if;
  if p_event_date is null or btrim(p_event_date) = ''
     or char_length(p_event_date) > 40 then
    raise exception 'A valid date is required' using errcode = '22023';
  end if;
  if p_latitude is not null and (p_latitude < -90 or p_latitude > 90) then
    raise exception 'Invalid latitude' using errcode = '22023';
  end if;
  if p_longitude is not null and (p_longitude < -180 or p_longitude > 180) then
    raise exception 'Invalid longitude' using errcode = '22023';
  end if;
  if p_location_label is not null and char_length(p_location_label) > 200 then
    raise exception 'Location label is too long' using errcode = '22023';
  end if;
  if p_youtube_url is not null and btrim(p_youtube_url) <> ''
     and p_youtube_url !~* '^https?://' then
    raise exception 'YouTube URL must be a valid link' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.findback_validate_post_fields(
  text, text, text, text, text, double precision, double precision, text, text
) from public, anon;
grant execute on function public.findback_validate_post_fields(
  text, text, text, text, text, double precision, double precision, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Create
-- ---------------------------------------------------------------------------
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
security invoker
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
    select * into v_upload from public.uploads where id = p_attachment_key;
    if not found then
      raise exception 'Attachment key does not exist' using errcode = '22023';
    end if;
    if v_upload.user_id <> v_uid then
      raise exception 'Attachment was not uploaded by you' using errcode = '42501';
    end if;
    insert into public.attachments (
      id, post_id, file_url, mime_type, file_name, file_size, created_at
    ) values (
      gen_random_uuid()::text, v_id, v_upload.file_url, v_upload.mime_type,
      v_upload.file_name, v_upload.file_size, v_now
    );
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

-- ---------------------------------------------------------------------------
-- Update (owner only). Null arguments mean "leave unchanged"; the current UI
-- has no edit screen, so this exists for completeness and future use.
-- ---------------------------------------------------------------------------
create or replace function public.findback_update_post_client(
  p_post_id text,
  p_type text default null,
  p_title text default null,
  p_description text default null,
  p_category text default null,
  p_event_date text default null,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_location_label text default null,
  p_youtube_url text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_count integer;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_type is not null then
    perform public.findback_validate_post_fields(
      p_type,
      coalesce(p_title, 'placeholder title'),
      coalesce(p_description, 'placeholder description'),
      coalesce(p_category, 'Other'),
      coalesce(p_event_date, '1970-01-01'),
      p_latitude, p_longitude, p_location_label, p_youtube_url
    );
  end if;

  update public.item_posts set
    type = coalesce(p_type, type),
    title = coalesce(nullif(btrim(coalesce(p_title, '')), ''), title),
    description = coalesce(nullif(btrim(coalesce(p_description, '')), ''), description),
    category = coalesce(p_category, category),
    event_date = coalesce(nullif(btrim(coalesce(p_event_date, '')), ''), event_date),
    latitude = coalesce(p_latitude, latitude),
    longitude = coalesce(p_longitude, longitude),
    location_label = coalesce(nullif(btrim(coalesce(p_location_label, '')), ''), location_label),
    youtube_url = coalesce(nullif(btrim(coalesce(p_youtube_url, '')), ''), youtube_url),
    updated_at = v_now
  where id = p_post_id and user_id = v_uid;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Post not found or you do not own it' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke all on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text
) from public, anon;
grant execute on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Change status (owner only)
-- ---------------------------------------------------------------------------
create or replace function public.findback_change_post_status_client(
  p_post_id text,
  p_status text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_count integer;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_status is null or p_status not in ('OPEN', 'MATCHED', 'RECOVERED', 'CLOSED') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;

  update public.item_posts
     set status = p_status, updated_at = v_now
   where id = p_post_id and user_id = v_uid;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Post not found or you do not own it' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke all on function public.findback_change_post_status_client(text, text)
  from public, anon;
grant execute on function public.findback_change_post_status_client(text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Delete (owner only)
-- ---------------------------------------------------------------------------
create or replace function public.findback_delete_post_client(p_post_id text)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  delete from public.item_posts where id = p_post_id and user_id = v_uid;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Post not found or you do not own it' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke all on function public.findback_delete_post_client(text) from public, anon;
grant execute on function public.findback_delete_post_client(text) to authenticated;

comment on function public.findback_create_post_client(
  text, text, text, text, text, double precision, double precision, text, text, text
) is 'FindBack create post (authenticated): owner is auth.uid(); returns the new post id. Optional staging upload must belong to the caller.';
comment on function public.findback_change_post_status_client(text, text)
  is 'FindBack change post status (authenticated owner only).';
comment on function public.findback_delete_post_client(text)
  is 'FindBack delete post (authenticated owner only).';
comment on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text
) is 'FindBack update post (authenticated owner only); null arguments leave fields unchanged.';
