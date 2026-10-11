-- FindBack — typed comment attachment relation (FBX-014).
--
-- WHY: comment attachments travelled only as Markdown lines in the body
-- (`![photo](url)` / `[video](url)`), with no typed record of who attached
-- what to which comment. `parseCommentBody` therefore had to trust any
-- https URL a body carried, and no server-side surface could ever enforce
-- provenance. This table is the owner-scoped provenance record Wave 4 wires
-- into rendering; readers other than the owner keep the existing body-URL
-- gallery path (the relation never widens what strangers can see).
--
-- ADDITIVE ONLY: one new table + RLS. No column drops, no data rewrites, no
-- grants touched on any existing object.
--
-- Shape (house style: text ids, cascade FKs, explicit ACL):
--   * `storage_path` XOR `klipy_slug` — exactly one source per row: a local
--     upload keeps its bucket-relative key (bucket is fixed at
--     `findback-comment-media`, see 20261011030000_comment_media_bucket_*
--     policies), a GIF/sticker pick keeps its provider identity.
--   * `display_order` 1..4 unique per comment — mirrors COMMENT_ATTACH_MAX
--     and the publish-order contract used by report photos.
--   * RLS owner-only for ALL FOUR commands: only the comment's author can
--     read or change their attachment rows; anon is fully revoked (Supabase
--     default ACLs would otherwise grant anon DML on new tables).
--
-- Note on ordering: this migration is numbered before the comment-media
-- bucket migration (020000 < 030000) so the fresh-apply order reads
-- relation -> bucket -> least-privilege; neither earlier file depends on
-- this one and nothing in this wave has been applied to a live backend yet.

create table if not exists public.comment_attachments (
  id text primary key,
  comment_id text not null references public.comments(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  kind text not null,
  display_order integer not null check (display_order between 1 and 4),
  -- Local-upload object key relative to the comment-media bucket (owner dir
  -- first: `<uid>/<uuid>.<ext>`); null for provider picks.
  storage_path text,
  -- Klipy provider identity for GIF/sticker picks; null for local uploads.
  klipy_slug text,
  klipy_kind text,
  -- The exact https URL that goes into the comment body, kept verbatim so
  -- the relation stays authoritative for rendering and cleanup.
  remote_url text not null,
  created_at text not null default now(),
  constraint comment_attachments_kind_check
    check (kind in ('photo', 'video', 'gif')),
  constraint comment_attachments_klipy_kind_check
    check (klipy_kind is null or klipy_kind in ('gifs', 'stickers')),
  constraint comment_attachments_source_xor
    check (((case when storage_path is not null then 1 else 0 end) +
            (case when klipy_slug is not null then 1 else 0 end)) = 1),
  unique (comment_id, display_order)
);

create index if not exists idx_comment_attachments_comment
  on public.comment_attachments (comment_id);

alter table public.comment_attachments enable row level security;

-- Strip the Supabase default ACL entirely (anon included, TRUNCATE /
-- TRIGGER / REFERENCES included), then re-grant only row DML — the
-- least-privilege posture FBX-034 applies retroactively elsewhere.
revoke all on public.comment_attachments from anon, authenticated;
grant select, insert, update, delete on public.comment_attachments to authenticated;

-- READ: owner only.
drop policy if exists comment_attachments_select_own on public.comment_attachments;
create policy comment_attachments_select_own
  on public.comment_attachments for select to authenticated
  using (user_id = (select auth.uid())::text);

-- WRITE: owner only, and only onto the caller's own comment — attaching to
-- someone else's comment is impossible even with a valid comment id.
drop policy if exists comment_attachments_insert_own on public.comment_attachments;
create policy comment_attachments_insert_own
  on public.comment_attachments for insert to authenticated
  with check (
    user_id = (select auth.uid())::text
    and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
  );

-- UPDATE: owner only (display_order edits while composing).
drop policy if exists comment_attachments_update_own on public.comment_attachments;
create policy comment_attachments_update_own
  on public.comment_attachments for update to authenticated
  using (user_id = (select auth.uid())::text)
  with check (user_id = (select auth.uid())::text);

-- DELETE: owner only (detach before the comment itself is removed).
drop policy if exists comment_attachments_delete_own on public.comment_attachments;
create policy comment_attachments_delete_own
  on public.comment_attachments for delete to authenticated
  using (user_id = (select auth.uid())::text);
