-- FindBack — multi-image report support (packet D1, forward-only).
--
-- Design (see temp-Com/D1.log.md): extend the existing public.attachments /
-- public.uploads infrastructure instead of adding a parallel image table.
-- Legacy writers produce at most one attachment per post, so adding a
-- display_order column with a deterministic backfill keeps every old row
-- readable and every old installed client working. The old single-key
-- public.findback_create_post_client RPC is NOT modified or removed here;
-- this migration only adds a new versioned multi-key RPC beside it.
--
-- No live-data deletion, no storage.objects change, no RLS/policy/grant
-- change: the new RPC runs under the same invoker rights as the old one.

-- ---------------------------------------------------------------------------
-- 1. display_order on attachments (additive; re-push idempotent)
-- ---------------------------------------------------------------------------
alter table public.attachments
  add column if not exists display_order integer not null default 1;

-- Fail loudly on unexpected data shape instead of silently truncating.
do $$
declare
  v_overfull integer;
begin
  select count(*) into v_overfull
    from (
      select post_id
        from public.attachments
       group by post_id
      having count(*) > 5
    ) overfull;
  if v_overfull > 0 then
    raise exception 'multi-image migration blocked: % post(s) already have more than 5 attachments', v_overfull
      using errcode = '22023';
  end if;
end;
$$;

-- Deterministic backfill: oldest attachment per post becomes order 1.
-- created_at-first matches the order the existing feed aggregation already
-- returns, so old single-photo readers observe no behavior change; the id
-- tiebreak makes the assignment fully deterministic.
with ranked as (
  select id,
         row_number() over (
           partition by post_id
           order by created_at asc, id asc
         ) as rn
    from public.attachments
)
update public.attachments as a
   set display_order = ranked.rn
  from ranked
 where a.id = ranked.id;

-- One deterministic order per post, bounded to the 5-image contract.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'attachments_post_display_order_unique'
  ) then
    alter table public.attachments
      add constraint attachments_post_display_order_unique unique (post_id, display_order);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'attachments_display_order_range'
  ) then
    alter table public.attachments
      add constraint attachments_display_order_range check (display_order between 1 and 5);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. New versioned multi-key create RPC (old RPC untouched)
--
-- Accepts 0-5 caller-owned staging keys, locks them in deterministic key
-- order, inserts one attachment per key with explicit display_order, and
-- consumes exactly those staging rows in the same transaction. Any failure
-- aborts the whole function, so there is no ghost post and no orphaned
-- attachment. PostgREST maps 22023 -> 400, 42501 -> 403, 40001 -> 409.
-- ---------------------------------------------------------------------------
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
security invoker
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
    -- Take row locks in deterministic key order first, so concurrent
    -- publishers cannot deadlock each other. The existing uploads UPDATE
    -- lock grant and policy already permit this lock.
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
      v_pos := v_pos + 1;
      insert into public.attachments (
        id, post_id, file_url, mime_type, file_name, file_size, created_at, display_order
      ) values (
        gen_random_uuid()::text, v_id, v_upload.file_url, v_upload.mime_type,
        v_upload.file_name, v_upload.file_size, v_now, v_pos
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

comment on function public.findback_create_post_client_multi(
  text, text, text, text, text, text[], double precision, double precision, text, text
) is 'FindBack create post with 0-5 ordered attachments (authenticated): owner is auth.uid(); returns the new post id. Each staging upload must belong to the caller and is consumed in the same transaction.';
