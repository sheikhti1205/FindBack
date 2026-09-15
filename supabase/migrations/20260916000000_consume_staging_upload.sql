-- FindBack - consume the staging upload inside the create-post transaction.
--
-- A successful publish previously left its `uploads` staging row behind. The
-- row is now deleted in the same transaction that inserts the attachment, so a
-- later create failure rolls the deletion back and the client never needs a
-- second round-trip. Ownership is still enforced by the caller's own RLS.

-- PostgreSQL requires UPDATE privilege and an UPDATE policy for FOR UPDATE.
-- Restrict the grant to the primary key and reject every actual updated row.
grant update (id) on public.uploads to authenticated;
drop policy if exists uploads_lock_own on public.uploads;
create policy uploads_lock_own
  on public.uploads for update to authenticated
  using (user_id = (select auth.uid())::text)
  with check (false);

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
    insert into public.attachments (
      id, post_id, file_url, mime_type, file_name, file_size, created_at
    ) values (
      gen_random_uuid()::text, v_id, v_upload.file_url, v_upload.mime_type,
      v_upload.file_name, v_upload.file_size, v_now
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

comment on function public.findback_create_post_client(
  text, text, text, text, text, double precision, double precision, text, text, text
) is 'FindBack create post (authenticated): owner is auth.uid(); returns the new post id. Optional staging upload must belong to the caller and is consumed in the same transaction.';
