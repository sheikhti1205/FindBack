-- FindBack — typed report reference on comments (CF-060 M2).
--
-- WHY: the social composer can attach a photo or a GIF to a comment, but not
-- the report the comment is about — the invariant packet 10 asks for. This
-- file gives a comment a real pointer to a report, resolved on render through
-- the canonical report read, so the card shows exactly what the feed shows.
--
-- SHAPE (decided in FindBack-internal/.../trust-backend/M2-CONTRACT-DECISION.md
-- §3; every constraint claim below was probed read-only against the live
-- engine, not inferred):
--   * The reference is a TAGGED ROW in the existing comment_attachments
--     relation: kind = 'report', report_post_id set, and no media, provider,
--     URL or provenance field. The 4-attachment cap and the unique
--     display_order are unchanged, so the composer tray stays one ordered
--     list and the list RPC stays one aggregate.
--   * `remote_url` loses NOT NULL because a report row has no URL. The
--     https-only check is `CHECK (remote_url like 'https://%' AND
--     (preview_url IS NULL OR preview_url like 'https://%'))`; a CHECK
--     rejects only FALSE, and `NULL like 'https://%'` is NULL, so it still
--     passes for a report row. Verified live, not reasoned.
--   * `comment_attachments_source_xor` becomes kind-aware: a report row must
--     have neither source, every other kind keeps exactly one.
--   * `report_post_id` is NULLABLE on purpose (`on delete set null`): deleting
--     a referenced report must never fail, and the surviving row is a
--     content-free tombstone the client renders as "Report unavailable". No
--     CHECK forces the column non-null — that would make SET NULL fail and
--     block report deletion.
--   * READ: a viewer of the comment can read the pointer row (`kind = 'report'`
--     branch in the select policy). The row carries no content and the
--     tombstone is deliberately readable too, which is what lets a viewer see
--     "Report unavailable" instead of nothing.
--   * WRITE: report rows are SERVER-AUTHORED ONLY. Both the insert and the
--     update policy refuse `kind = 'report'` outright, so a client can neither
--     manufacture a reference nor flip a media row into one nor retarget one;
--     the atomic create RPC is the only path that produces one, and it
--     validates the descriptor and the target report.
--   * BODY: a trimmed body of 0–1000 characters is legal exactly when at least
--     one validated descriptor accompanies it; every other caller keeps the
--     1–1000 rule. Enforced in the RPC, the only write path the app uses.
--   * NO NEW VISIBILITY PREDICATE and no moderation/block kernel here. The
--     card resolves its pointer through the existing canonical item_posts read
--     (fetchPost), which is the single place packet 10 moderation (§U) and
--     §V blocking will filter. M2 creates no second predicate that could
--     disagree with the feed and claims no filtering.
--
-- ADDITIVE ONLY: one column, one index, one foreign key, three policy
-- recreations and two RPC recreations (same names, same signatures, same
-- return types). No column drops, no row rewrites, no deletes, no grant
-- changes (the existing table-level grant covers the new column), no reader
-- converted to SECURITY DEFINER, no edit to any applied migration. Both
-- constraint re-adds are VALID rather than NOT VALID: every existing row
-- already satisfies the new expression (no row has kind = 'report' yet), so
-- the re-add cannot fail on live data, unlike the parity file's coherence
-- checks.
-- LIVE-PENDING — the *behavioural* check is what remains live-pending; the apply
-- is not. Pushing this file to `main` WAS the apply: a Supabase GitHub
-- integration connected to the repository auto-applies migrations on push
-- (owner-confirmed 2026-10-18; GOVERNANCE-B1-APPLY-PROVENANCE.md §5), which is why
-- this ledger row carries no `created_by`, no `idempotency_key` and no
-- accompanying Actions run. Hosted readback on 2026-10-17 found migration head
-- `20261017052000` with all 17 original catalogue conditions true and the
-- four-policy parity intact (M2-HOSTED-READBACK-2026-10-17.md). Re-verify with
-- supabase/tests/verify_20261017052000_comment_report_reference.sql plus the
-- read-only pg_constraint / pg_policies / pg_proc probe in the decision doc.

-- ---------------------------------------------------------------------------
-- 1. Vocabulary: a comment attachment may now be a report reference.
-- ---------------------------------------------------------------------------
alter table public.comment_attachments
  drop constraint if exists comment_attachments_kind_check;

alter table public.comment_attachments
  add constraint comment_attachments_kind_check
  check (kind in ('photo', 'video', 'gif', 'sticker', 'report'));

-- ---------------------------------------------------------------------------
-- 2. A report row has no URL, so remote_url stops being mandatory. The
--    https-only check still holds for every row that has one (a CHECK rejects
--    only FALSE; `NULL like 'https://%'` is NULL, which passes).
-- ---------------------------------------------------------------------------
alter table public.comment_attachments
  alter column remote_url drop not null;

-- ---------------------------------------------------------------------------
-- 3. Source exclusivity becomes kind-aware: media kinds keep exactly one
--    source, a report row keeps neither.
-- ---------------------------------------------------------------------------
alter table public.comment_attachments
  drop constraint if exists comment_attachments_source_xor;

alter table public.comment_attachments
  add constraint comment_attachments_source_xor
  check (
    case
      when kind = 'report' then storage_path is null and klipy_slug is null
      else ((case when storage_path is not null then 1 else 0 end) +
            (case when klipy_slug is not null then 1 else 0 end)) = 1
    end
  );

-- ---------------------------------------------------------------------------
-- 4. The pointer. Nullable on purpose (see the header): a deleted report
--    becomes a tombstone instead of blocking the deletion.
--
--    Where content-freeness actually comes from (review MINOR-1): NOT from the
--    constraints. `source_xor` pins only `storage_path` and `klipy_slug`, and the
--    provider/url/size/dims guards merely validate a value when one is present —
--    a stray `mime_type` or `remote_url` on a report row would still satisfy
--    every CHECK. It comes from (a) the RPC being the only writer of
--    `kind = 'report'` rows: its report branch inserts a fixed column list with no
--    media or provenance field and refuses a descriptor that carries one, and
--    (b) the insert/update policies refusing a client-authored report row.
--    This section guarantees only what it states: the pointer is nullable, and
--    the FK never blocks a report deletion.
-- ---------------------------------------------------------------------------
alter table public.comment_attachments
  add column if not exists report_post_id text;

alter table public.comment_attachments
  drop constraint if exists comment_attachments_report_post_id_fkey;

alter table public.comment_attachments
  add constraint comment_attachments_report_post_id_fkey
  foreign key (report_post_id) references public.item_posts (id) on delete set null;

create index if not exists idx_comment_attachments_report_post
  on public.comment_attachments (report_post_id);

-- ---------------------------------------------------------------------------
-- 5. READ: the owner keeps reading their own rows; any authenticated viewer of
--    the comment can read a report pointer row. The row is content-free and
--    the tombstone is readable by the same rule.
-- ---------------------------------------------------------------------------
drop policy if exists comment_attachments_select_own on public.comment_attachments;
create policy comment_attachments_select_own
  on public.comment_attachments for select to authenticated
  using (
    user_id = (select auth.uid())::text
    or kind = 'report'
  );

-- ---------------------------------------------------------------------------
-- 6. WRITE: report rows are server-authored only. A client cannot insert one,
--    cannot flip a media row into one, and cannot retarget one (the UPDATE
--    policy's USING clause hides them from UPDATE entirely). DELETE is left
--    owner-only and unchanged: an author removing their own pointer row is a
--    detach, which carries no data and leaks nothing, and it cannot create a
--    reference. (kind is NOT NULL, so `kind <> 'report'` is two-valued.)
-- ---------------------------------------------------------------------------
drop policy if exists comment_attachments_insert_own on public.comment_attachments;
create policy comment_attachments_insert_own
  on public.comment_attachments for insert to authenticated
  with check (
    kind <> 'report'
    and user_id = (select auth.uid())::text
    and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
  );

drop policy if exists comment_attachments_update_own on public.comment_attachments;
create policy comment_attachments_update_own
  on public.comment_attachments for update to authenticated
  using (
    kind <> 'report'
    and user_id = (select auth.uid())::text
    and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
  )
  with check (
    kind <> 'report'
    and user_id = (select auth.uid())::text
    and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
  );

-- ---------------------------------------------------------------------------
-- 7. Comment list: same name, same signature, same return type; one field
--    added to the attachment projection. SECURITY INVOKER preserved — row
--    visibility is decided by the policy above, not by this function.
-- ---------------------------------------------------------------------------
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
          'report_post_id', a.report_post_id,
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
  is 'FindBack comment list (authenticated): public comment tree + author projection + per-comment per-kind reaction_counts and caller my_reaction + display_order-ranked attachments (public-safe fields only; never user_id or storage_path; report_post_id is the content-free pointer of a report reference and is NULL for every other kind). Never returns reaction user ids.';

-- ---------------------------------------------------------------------------
-- 8. Atomic create: one more descriptor kind, plus the content rule that goes
--    with it. A report descriptor carries ONLY report_post_id — no storage
--    key, no provider slug, no URL, no preview, no MIME/size/dimensions — and
--    its target must exist as a row in item_posts; anything else raises 22023
--    (P0002 for an unknown report) and persists nothing. The 4-attachment cap
--    and the unique display_order are unchanged, so a reference competes for a
--    slot exactly like any other attachment.
--
--    Body rule (D7): a report reference is real content, so a trimmed body of
--    0-1000 characters is legal exactly when at least one descriptor
--    accompanies it; without a descriptor the 1-1000 rule stands. A NULL body
--    stays refused (the client always sends a string), and descriptors are
--    validated below inside this same transaction, so a blank body with an
--    invalid descriptor still persists nothing.
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
  v_report text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  -- D7 (CF-060 M2): a blank body is legal exactly when at least one
  -- descriptor accompanies it. Descriptors are validated below, inside this
  -- same transaction, so an invalid one still persists nothing.
  if p_body is null then
    raise exception 'Comment must be 1-1000 characters' using errcode = '22023';
  end if;
  if char_length(btrim(p_body)) > 1000 then
    raise exception 'Comment must be 0-1000 characters' using errcode = '22023';
  end if;
  if char_length(btrim(p_body)) < 1 and v_count = 0 then
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
    v_report := nullif(btrim(coalesce(d ->> 'report_post_id', '')), '');

    if v_kind not in ('photo', 'video', 'gif', 'sticker', 'report') then
      raise exception 'invalid attachment kind' using errcode = '22023';
    end if;
    if v_order is null or v_order < 1 or v_order > 4 or v_order = any (v_seen) then
      raise exception 'invalid attachment order' using errcode = '22023';
    end if;
    v_seen := v_seen || v_order;

    -- A report reference is a pointer and nothing else. It has no storage
    -- key, no provider slug, no URL, no preview and no provenance; its
    -- target must exist, and none of that is optional.
    if v_kind = 'report' then
      if v_report is null then
        raise exception 'report reference needs a report id' using errcode = '22023';
      end if;
      if v_storage_key is not null or v_slug is not null
         or v_remote is not null or v_preview is not null
         or v_mime is not null or v_fname is not null
         or v_fsize is not null or v_width is not null or v_height is not null then
        raise exception 'report reference carries no media fields' using errcode = '22023';
      end if;
      if not exists (select 1 from public.item_posts p where p.id = v_report) then
        raise exception 'Report not found' using errcode = 'P0002';
      end if;
      insert into public.comment_attachments
        (id, comment_id, user_id, kind, display_order, report_post_id, created_at)
      values
        (gen_random_uuid()::text, v_id, v_uid, 'report', v_order, v_report, v_now);
      continue;
    end if;

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
  is 'FindBack atomic comment create (authenticated): comment + up to 4 ordered descriptors in one transaction. STORAGE keys must be caller-owned; KLIPY picks are slug-identified; urls https-only; a report descriptor is a validated pointer to an existing item_posts row and carries no media field. A blank body is accepted only with at least one descriptor. Raises 22023 (P0002 for an unknown report or post) and persists nothing on any invalid descriptor.';
