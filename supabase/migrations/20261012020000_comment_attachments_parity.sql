-- FindBack — comment attachment parity (follow-up to 20261011020000/030000).
--
-- ADDITIVE ONLY. The Supabase GitHub integration auto-applies migrations on
-- push, so this file must be safe to run once against the live schema: new
-- nullable columns, widened kind check (drop + re-add, no data touched),
-- new NOT VALID coherence checks (enforced for new rows, no live table
-- scan), one comment-list RPC recreation (same name/signature + one added
-- output column), one new atomic create RPC, one new cleanup-queue table +
-- trigger + service-role-only claim RPC. No column drops, no row rewrites,
-- no user/auth data removal, no edits to any applied migration, no grant
-- touched on any existing object.
-- LIVE-PENDING (owner-deferred, 2026-10-12): verify on the live project
-- before PASS — see supabase/tests/verify_20261012020000_comment_attachments.sql
-- (no live run ships in this change), including VALIDATE CONSTRAINT for the
-- NOT VALID checks below once the table is known-clean.
--
-- WHY (gaps vs spec 26, found comparing 20261011020000 against the spec):
--   1. Vocabulary short of spec: kind allowed only photo/video/gif — the
--      spec's STICKER pick had no legal kind. Now photo/video/gif/sticker.
--   2. Missing provenance columns: the spec's provider (STORAGE/KLIPY),
--      mime_type, file_name, file_size, width/height, preview_url never
--      existed; only storage_path/klipy_slug/remote_url did. Added nullable
--      (old rows stay valid; the atomic RPC below always writes them).
--   3. Coherence lived only in RLS/application prose: STORAGE-must-carry-an-
--      owned-key and KLIPY-must-carry-a-slug were not DB-enforceable, and no
--      check bound a local key to its owner's directory. The new checks make
--      them row truth: provider<->source agreement, storage_path pinned
--      under user_id + '/' with no '..', klipy_slug shape-bound (provider
--      identity, never a URL), remote_url https-only, file_size within the
--      25 MB comment-media ceiling, dimensions sane.
--   4. No atomic create path: the spec's stage-then-consume transaction
--      (create comment + attachment rows atomically; foreign staged keys and
--      arbitrary URLs rejected) had no RPC. findback_add_comment_with_-
--      attachments is that path: caller from the session, owned-key and
--      slug validation, max 4 descriptors with unique display_order 1..4.
--   5. No ordered attachment read: the comment list RPC returned no
--      attachments at all. It now returns an attachments jsonb array ordered
--      by display_order (deterministic ties), carrying public-safe fields
--      only — never user_id, never storage_path. Row visibility is unchanged
--      (SECURITY INVOKER: a caller sees their own typed rows; other readers
--      keep the existing body-URL gallery path, exactly the decision the
--      base migration documents).
--   6. No orphan-byte path: DB cascade deletes attachment rows but never
--      Storage bytes. comment_media_cleanup_queue records every deleted
--      local key; claim_comment_media_cleanup hands bounded batches to a
--      future service-role cleaner (LIVE-PENDING consumer). Account deletion
--      already sweeps the whole comment-media namespace via delete-account.
--
-- ---------------------------------------------------------------------------
-- 1. Vocabulary + provenance columns.
-- ---------------------------------------------------------------------------
alter table public.comment_attachments
  drop constraint if exists comment_attachments_kind_check;

alter table public.comment_attachments
  add constraint comment_attachments_kind_check
  check (kind in ('photo', 'video', 'gif', 'sticker'));

alter table public.comment_attachments add column if not exists provider text;
alter table public.comment_attachments add column if not exists mime_type text;
alter table public.comment_attachments add column if not exists file_name text;
alter table public.comment_attachments add column if not exists file_size bigint;
alter table public.comment_attachments add column if not exists width integer;
alter table public.comment_attachments add column if not exists height integer;
alter table public.comment_attachments add column if not exists preview_url text;

-- ---------------------------------------------------------------------------
-- 2. Coherence checks (NOT VALID: enforced for every new row without
--    scanning/rejecting on pre-parity rows; VALIDATE CONSTRAINT is a
--    live-pending step once the table is known-clean).
-- ---------------------------------------------------------------------------
alter table public.comment_attachments
  add constraint comment_attachments_provider_check
  check (provider is null or provider in ('STORAGE', 'KLIPY'))
  not valid;

alter table public.comment_attachments
  add constraint comment_attachments_provider_source_check
  check (
    provider is null
    or (
      provider = 'STORAGE'
      and storage_path is not null
      and klipy_slug is null
    )
    or (
      provider = 'KLIPY'
      and klipy_slug is not null
      and storage_path is null
    )
  )
  not valid;

-- A local key is owned by definition: it must live under the row owner's
-- own directory with no traversal. (user_id is uuid text: no LIKE wildcards
-- to escape, but left() avoids pattern semantics entirely.)
alter table public.comment_attachments
  add constraint comment_attachments_owned_key_check
  check (
    storage_path is null
    or (
      left(storage_path, char_length(user_id) + 1) = user_id || '/'
      and position('..' in storage_path) = 0
    )
  )
  not valid;

-- Provider identity only: a slug, never a URL, never blank/oversized.
alter table public.comment_attachments
  add constraint comment_attachments_slug_shape_check
  check (
    klipy_slug is null
    or klipy_slug ~ '^[A-Za-z0-9_-]{1,128}$'
  )
  not valid;

alter table public.comment_attachments
  add constraint comment_attachments_url_https_check
  check (
    remote_url like 'https://%'
    and (preview_url is null or preview_url like 'https://%')
  )
  not valid;

-- Server ceiling agrees with the comment-media bucket (25,000,000).
alter table public.comment_attachments
  add constraint comment_attachments_size_check
  check (file_size is null or (file_size > 0 and file_size <= 25000000))
  not valid;

alter table public.comment_attachments
  add constraint comment_attachments_dims_check
  check (
    (width is null or (width >= 1 and width <= 8192))
    and (height is null or (height >= 1 and height <= 8192))
  )
  not valid;

-- ---------------------------------------------------------------------------
-- 3. Comment list: same RPC + ordered public-safe attachment JSON.
--    SECURITY INVOKER preserved (row visibility unchanged by this file).
-- ---------------------------------------------------------------------------
drop function if exists public.findback_list_comments_client(text);

create or replace function public.findback_list_comments_client(p_post_id text)
returns table (
  id text,
  post_id text,
  parent_id text,
  depth integer,
  body text,
  created_at text,
  updated_at text,
  author_id text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text,
  reaction_counts jsonb,
  my_reaction text,
  attachments jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    c.id, c.post_id, c.parent_id, c.depth, c.body, c.created_at, c.updated_at,
    c.user_id as author_id,
    u.username as author_username,
    u.email_verified as author_email_verified,
    u.phone_verified as author_phone_verified,
    u.avatar_url as author_avatar_url,
    u.created_at as author_created_at,
    coalesce((
      select jsonb_object_agg(t.kind, t.n)
      from (
        select case when cr.type = 'LIKE' then 'LOVE' else cr.type end as kind,
               count(*) as n
        from public.comment_reactions cr
        where cr.comment_id = c.id
        group by 1
      ) t
    ), '{}'::jsonb) as reaction_counts,
    (select cr2.type from public.comment_reactions cr2
      where cr2.id = md5('comment_reaction|' || c.id || '|' || (select auth.uid())::text))
      as my_reaction,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'kind', a.kind,
          'provider', a.provider,
          'display_order', a.display_order,
          'remote_url', a.remote_url,
          'preview_url', a.preview_url,
          'mime_type', a.mime_type,
          'file_name', a.file_name,
          'file_size', a.file_size,
          'width', a.width,
          'height', a.height,
          'created_at', a.created_at
        ) order by a.display_order asc, a.created_at asc, a.id asc
      )
      from public.comment_attachments a
      where a.comment_id = c.id
    ), '[]'::jsonb) as attachments
  from public.comments c
  join public.users u on u.id = c.user_id
  where c.post_id = p_post_id
  order by c.created_at asc
  limit 500;
$$;

revoke all on function public.findback_list_comments_client(text) from public, anon;
grant execute on function public.findback_list_comments_client(text) to authenticated;

comment on function public.findback_list_comments_client(text)
  is 'FindBack comment list (authenticated): public comment tree + author projection + per-comment per-kind reaction_counts and caller my_reaction + display_order-ranked attachments (public-safe fields only; never user_id or storage_path). Never returns reaction user ids.';

-- ---------------------------------------------------------------------------
-- 4. Atomic create: comment + staged attachment descriptors in one
--    transaction (spec 26 stage-then-consume). SECURITY DEFINER because
--    clients hold no direct comment-attachment trust beyond owner RLS; the
--    caller is resolved from the session, never a parameter.
--
--    Descriptor shape (jsonb object per attachment):
--      { kind, display_order, storage_key?, klipy_slug?, remote_url,
--        preview_url?, mime_type?, file_name?, file_size?, width?, height? }
--    STORAGE descriptors require an owned key `<uid>/…` (no '..', image/
--    video extension allowlist matching the comment-media bucket) and an
--    https remote_url; KLIPY descriptors require a slug-shaped identity and
--    an https remote_url. A foreign staged key, an arbitrary (non-https)
--    URL, a 5th descriptor, or a duplicate display_order raises 22023 and
--    persists nothing.
-- ---------------------------------------------------------------------------
create or replace function public.findback_add_comment_with_attachments(
  p_post_id text,
  p_body text,
  p_parent_id text default null,
  p_attachments jsonb default '[]'::jsonb
)
returns table (
  id text,
  post_id text,
  parent_id text,
  depth integer,
  body text,
  created_at text,
  updated_at text,
  author_id text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := public.findback_uid();
  v_id text := gen_random_uuid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_parent text := nullif(btrim(coalesce(p_parent_id, '')), '');
  v_parent_post text;
  v_parent_depth integer;
  v_depth integer := 0;
  v_count integer := jsonb_array_length(coalesce(p_attachments, '[]'::jsonb));
  v_seen integer[] := '{}';
  d jsonb;
  v_kind text;
  v_order integer;
  v_storage_key text;
  v_slug text;
  v_remote text;
  v_preview text;
  v_mime text;
  v_fname text;
  v_fsize bigint;
  v_width integer;
  v_height integer;
  v_provider text;
  v_file text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_body is null or char_length(btrim(p_body)) < 1
     or char_length(btrim(p_body)) > 1000 then
    raise exception 'Comment must be 1-1000 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from public.item_posts p where p.id = p_post_id) then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;

  if v_parent is not null then
    select c.post_id, c.depth into v_parent_post, v_parent_depth
    from public.comments c
    where c.id = v_parent;
    if not found then
      raise exception 'Parent comment not found' using errcode = 'P0002';
    end if;
    if v_parent_post <> p_post_id then
      raise exception 'Parent comment belongs to another report' using errcode = '22023';
    end if;
    if v_parent_depth >= 5 then
      raise exception 'Reply depth exceeded' using errcode = '22023';
    end if;
    v_depth := v_parent_depth + 1;
  end if;

  if v_count > 4 then
    raise exception 'At most 4 attachments' using errcode = '22023';
  end if;

  insert into public.comments (id, post_id, user_id, parent_id, depth, body, created_at, updated_at)
  values (v_id, p_post_id, v_uid, v_parent, v_depth, btrim(p_body), v_now, v_now);

  for d in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    if jsonb_typeof(d) <> 'object' then
      raise exception 'invalid attachment descriptor' using errcode = '22023';
    end if;
    v_kind := lower(nullif(btrim(coalesce(d ->> 'kind', '')), ''));
    v_order := (d ->> 'display_order')::integer;
    v_storage_key := nullif(btrim(coalesce(d ->> 'storage_key', '')), '');
    v_slug := nullif(btrim(coalesce(d ->> 'klipy_slug', '')), '');
    v_remote := nullif(btrim(coalesce(d ->> 'remote_url', '')), '');
    v_preview := nullif(btrim(coalesce(d ->> 'preview_url', '')), '');
    v_mime := nullif(btrim(coalesce(d ->> 'mime_type', '')), '');
    v_fname := nullif(btrim(coalesce(d ->> 'file_name', '')), '');
    v_fsize := nullif((d ->> 'file_size'), '')::bigint;
    v_width := nullif((d ->> 'width'), '')::integer;
    v_height := nullif((d ->> 'height'), '')::integer;

    if v_kind not in ('photo', 'video', 'gif', 'sticker') then
      raise exception 'invalid attachment kind' using errcode = '22023';
    end if;
    if v_order is null or v_order < 1 or v_order > 4 or v_order = any (v_seen) then
      raise exception 'invalid attachment order' using errcode = '22023';
    end if;
    v_seen := v_seen || v_order;

    if v_storage_key is not null and v_slug is not null then
      raise exception 'attachment must be STORAGE or KLIPY, not both' using errcode = '22023';
    end if;
    if v_storage_key is null and v_slug is null then
      raise exception 'attachment needs a storage key or provider slug' using errcode = '22023';
    end if;
    if v_remote is null or v_remote not like 'https://%' then
      raise exception 'attachment needs an https url' using errcode = '22023';
    end if;
    if char_length(v_remote) > 2048
       or (v_preview is not null and (char_length(v_preview) > 2048 or v_preview not like 'https://%')) then
      raise exception 'invalid attachment url' using errcode = '22023';
    end if;
    if v_fsize is not null and (v_fsize <= 0 or v_fsize > 25000000) then
      raise exception 'invalid attachment size' using errcode = '22023';
    end if;
    if (v_width is not null and (v_width < 1 or v_width > 8192))
       or (v_height is not null and (v_height < 1 or v_height > 8192)) then
      raise exception 'invalid attachment dimensions' using errcode = '22023';
    end if;

    if v_storage_key is not null then
      -- Owned staged key only: another account's staged upload (or any
      -- '../' escape) can never be consumed into this comment.
      v_provider := 'STORAGE';
      if position('..' in v_storage_key) > 0
         or left(v_storage_key, char_length(v_uid) + 1) <> v_uid || '/' then
        raise exception 'foreign storage key' using errcode = '22023';
      end if;
      v_file := (string_to_array(v_storage_key, '/'))[array_length(string_to_array(v_storage_key, '/'), 1)];
      if v_file is null
         or v_file !~* '^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp|gif|heic|heif|avif|bmp|mp4|webm|mov)$' then
        raise exception 'invalid storage key' using errcode = '22023';
      end if;
    else
      v_provider := 'KLIPY';
      if v_slug !~ '^[A-Za-z0-9_-]{1,128}$' then
        raise exception 'invalid provider slug' using errcode = '22023';
      end if;
    end if;

    insert into public.comment_attachments
      (id, comment_id, user_id, kind, display_order, storage_path,
       klipy_slug, klipy_kind, remote_url, preview_url,
       provider, mime_type, file_name, file_size, width, height, created_at)
    values
      (gen_random_uuid()::text, v_id, v_uid, v_kind, v_order, v_storage_key,
       v_slug, case when v_provider = 'KLIPY' then coalesce(nullif(btrim(d ->> 'klipy_kind'), ''), 'gifs') end,
       v_remote, v_preview,
       v_provider, v_mime, v_fname, v_fsize, v_width, v_height, v_now);
  end loop;

  return query
    select
      c.id, c.post_id, c.parent_id, c.depth, c.body, c.created_at, c.updated_at,
      c.user_id, u.username, u.email_verified, u.phone_verified,
      u.avatar_url, u.created_at
    from public.comments c
    join public.users u on u.id = c.user_id
    where c.id = v_id;
exception
  when invalid_text_representation then
    raise exception 'invalid attachment descriptor' using errcode = '22023';
end;
$$;

revoke all on function
  public.findback_add_comment_with_attachments(text, text, text, jsonb)
  from public, anon;
grant execute on function
  public.findback_add_comment_with_attachments(text, text, text, jsonb)
  to authenticated;

comment on function
  public.findback_add_comment_with_attachments(text, text, text, jsonb)
  is 'FindBack atomic comment create (authenticated): comment + up to 4 staged attachment descriptors in one transaction. STORAGE keys must be caller-owned; KLIPY picks are slug-identified; urls https-only. Raises 22023 and persists nothing on any invalid descriptor.';

-- ---------------------------------------------------------------------------
-- 5. Orphan-byte cleanup queue. DB cascade removes attachment rows, never
--    Storage bytes; the trigger below records every deleted local key so a
--    service-role cleaner can sweep bytes later (consumer LIVE-PENDING; the
--    account-deletion sweep already covers whole-namespace removal).
-- ---------------------------------------------------------------------------
create table if not exists public.comment_media_cleanup_queue (
  storage_key text primary key,
  enqueued_at text not null default to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

alter table public.comment_media_cleanup_queue enable row level security;

-- No client grants: service-role cleaner only (explicit EXECUTE grant on the
-- claim RPC below; table RLS stays deny-by-default for anon/authenticated).
revoke all on public.comment_media_cleanup_queue from anon, authenticated;

create or replace function public.enqueue_comment_media_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.storage_path is not null then
    insert into public.comment_media_cleanup_queue (storage_key)
    values (old.storage_path)
    on conflict (storage_key) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function public.enqueue_comment_media_cleanup() from public, anon, authenticated;

drop trigger if exists comment_attachments_cleanup_enqueue on public.comment_attachments;
create trigger comment_attachments_cleanup_enqueue
  after delete on public.comment_attachments
  for each row execute function public.enqueue_comment_media_cleanup();

-- Bounded batch claim for the future service-role cleaner: deletes (claims)
-- up to p_limit oldest keys and returns them. Service-role only.
create or replace function public.claim_comment_media_cleanup(p_limit integer default 100)
returns table (storage_key text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 1000));
begin
  return query
    delete from public.comment_media_cleanup_queue q
    where q.storage_key in (
      select q2.storage_key
      from public.comment_media_cleanup_queue q2
      order by q2.enqueued_at asc, q2.storage_key asc
      limit v_limit
    )
    returning q.storage_key;
end;
$$;

revoke all on function public.claim_comment_media_cleanup(integer) from public, anon, authenticated;
grant execute on function public.claim_comment_media_cleanup(integer) to service_role;
