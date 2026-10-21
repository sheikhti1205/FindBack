-- FindBack — saved reports (bookmarks): the `post_saves` table and its three
-- client RPCs.
--
-- WHY THIS FILE EXISTS. The owner asked for a visible Save/bookmark action on
-- a report, and for it to work locally AND on the account. The device half of
-- that contract is client-side (the local list is written first and always
-- succeeds); this file is the ACCOUNT half: one table that says which reports
-- a signed-in reader saved, and three client RPCs to read and write it.
--
-- SCHEMA FIT — READ THIS BEFORE EDITING (verified against the hosted
-- project, schema `public`).
--   * The reports table is `public.item_posts`. There is NO `posts` table in
--     this schema, so a migration written against `posts` would not apply.
--   * `public.item_posts.id` is TEXT, not uuid. `public.users.id` is TEXT,
--     not uuid. Every neighbouring table (`ratings`, `reactions`,
--     `comment_reactions`, `device_tokens`, `user_blocks`) points at them
--     with a TEXT column and a `FOREIGN KEY (user_id) REFERENCES
--     public.users(id) ON DELETE CASCADE`. A uuid column cannot reference a
--     text primary key, so the ids here are TEXT exactly like every other
--     table in the chain, and the RPC parameter is `text` for the same
--     reason (`findback_react_client(text, text)` is the precedent).
--   * The caller is derived as `auth.uid()::text`, the way every client RPC
--     in this chain derives it.
--   * `created_at` is TEXT in the house format
--     `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"` (UTC), written by the server as
--     `to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
--     That is the convention on every user-facing table in this chain
--     (`users`, `item_posts`, `comments`, `reactions`, `ratings`,
--     `notifications`, `device_tokens`, `user_blocks`); the timestamptz
--     columns in this schema are internal lease/cleanup bookkeeping, not
--     reader-visible rows. The client reads this value as a string, so the
--     house format is also the client-friendly format.
--
-- SECURITY PROPERTIES (the reviewer reads these line by line):
--   1. The caller is derived from `auth.uid()` and ONLY from `auth.uid()`.
--      No RPC takes a user id: there is no parameter a caller could point at
--      another account, so there is no cross-account write and no
--      "whose saves are these" oracle.
--   2. Every RPC is SECURITY DEFINER with a locked `search_path`
--      (`public, pg_temp`), so the definer cannot be redirected to a
--      shadowed object through a writable schema. DEFINER (not INVOKER) is
--      required, not a preference: the table is granted to no client role
--      at all, so an INVOKER function could not touch it. The definer
--      therefore does the authorization itself, and it does exactly one
--      thing: it reads the caller from `auth.uid()`.
--   3. `anon` and `public` hold NOTHING on this table and these functions:
--      the table is revoked from every client role and each function is
--      revoked from `public` and `anon` before `authenticated` is granted
--      EXECUTE. A signed-out caller gets nothing.
--   4. RLS is enabled on the table and every policy is owner-scoped
--      (`user_id = auth.uid()`), so even a future grant cannot widen the
--      table past the caller's own rows. The policies are a SECOND lock: the
--      table has no client grant today, so the RPCs are the only surface.
--   5. A save verifies the target report EXISTS before it writes, by reading
--      `public.item_posts` — the same existence check the house uses in
--      `findback_add_comment_client(text, text)`. A save is an ID-LEVEL
--      fact (which report id this reader bookmarked); it carries no post
--      content, no title, no author, so it is not a second visibility rule
--      and it does not compete with the ONE visibility predicate of the
--      chain (`public.findback_visible_posts`, the D9 kernel). The report
--      CONTENT stays governed by that single predicate at read time, which
--      is where the feed, the nearby list, search and the reader itself
--      already decide what a reader may see.
--   6. Rows disappear with their owner: both foreign keys cascade, so a
--      deleted account leaves no save rows behind, and a deleted report
--      leaves none either.
--
-- ADDITIVE ONLY. One new table, one new index, three new functions, three
-- new policies. No table or column is dropped, no applied file is edited, and
-- no existing data is changed by applying this migration. At runtime, save
-- upserts only the caller's row and refreshes its clock; unsave deletes only
-- the caller's row at their request. Those RPC bodies are not migration-time
-- data mutations. Re-applying the schema definitions is idempotent.
--
-- APPLIED. This migration ran against the hosted project on 2026-10-21 as
-- hosted version 20261021162726. The file was authored as
-- 20261021090000_post_saves.sql and renamed so that the repository and the
-- database history agree.
--
-- WHAT WAS APPLIED. The bytes that ran on the hosted project are archived in
-- FindBack-internal/01_ACTIVE/consumer-final/sessions/main/D2-hosted-applied-2026-10-21/post_saves.sql
-- (sha256 ce969158312ad1b96fa6e607d228c861969c91003c02ebf7f1042b1823293ce3).
-- Everything this file DOES — the table, the policies, the grants and the
-- three functions — is identical to that artifact; the only difference
-- between that artifact and this file is comment text: this header and the
-- verification pointer below.
--
-- The hosted readback that proves the security properties above was taken on
-- 2026-10-21 by the coordinator's behaviour probe (a single batch that ends in
-- ROLLBACK) and catalog probe. Their raw output is archived in the same
-- folder, next to the applied artifacts.
--
-- Verification pointer: supabase/tests/verify_20261021162726_post_saves.sql
-- (the disposable-PostgreSQL-17 probe for the same properties; it was NOT
-- executed in the apply pass).

-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------
-- One row per (report, reader). The composite primary key is what makes a
-- second save of the same report refresh its save clock instead of creating
-- a duplicate. A fresh positive intent must supersede an older offline removal.
--
-- `post_id` cascades from the report (a deleted report leaves no save row)
-- and `user_id` cascades from the account (a deleted account leaves no save
-- row). `created_at` is the SERVER clock, in the house text format: the
-- client never sends a time, and the reader sees "Saved 2m ago".
create table if not exists public.post_saves (
  post_id text not null references public.item_posts(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  created_at text not null,
  primary key (post_id, user_id)
);

create index if not exists idx_post_saves_user on public.post_saves (user_id);

alter table public.post_saves enable row level security;

-- Strip the Supabase default ACL entirely (the default grants table rights to
-- anon and authenticated). The table is reached through the RPCs below, not
-- through a direct query, so no client role keeps a table grant.
revoke all on public.post_saves from public, anon, authenticated;

comment on table public.post_saves is
  'FindBack saved reports: one row per (report, reader). Read and written only through findback_save_post_client / findback_unsave_post_client / findback_list_saved_posts_client; the caller is always auth.uid(). No client role holds a table grant.';

-- ---------------------------------------------------------------------------
-- 2. RLS policies — the owner-scoped backstop.
-- ---------------------------------------------------------------------------
-- These are dormant today (no client role holds a table grant), and that is
-- deliberate: they are here so that a future grant can only ever expose the
-- caller's OWN rows. Every predicate is `user_id = auth.uid()`; there is no
-- policy that reads another reader's rows.
drop policy if exists post_saves_select_own on public.post_saves;
create policy post_saves_select_own
  on public.post_saves for select
  to authenticated
  using (user_id = (select auth.uid())::text);

drop policy if exists post_saves_insert_own on public.post_saves;
create policy post_saves_insert_own
  on public.post_saves for insert
  to authenticated
  with check (user_id = (select auth.uid())::text);

drop policy if exists post_saves_delete_own on public.post_saves;
create policy post_saves_delete_own
  on public.post_saves for delete
  to authenticated
  using (user_id = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- 3. findback_save_post_client — save one report.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the table is granted to nobody; the definer
-- therefore has to do the authorization itself, which it does by taking the
-- caller from `auth.uid()` and nothing else.
--
-- The existence check reads `public.item_posts` — the table every other
-- client RPC in this chain checks against (`findback_add_comment_client`).
-- A save of an id that is not a report stores nothing.
--
-- The three functions are dropped before they are created because
-- PostgreSQL cannot change a function's OUT columns with `create or replace`.
-- The drop is guarded with `if exists` and the function is re-created and
-- re-granted in the same transaction, exactly as the D9 kernel does for its
-- own re-created readers.
drop function if exists public.findback_save_post_client(text);

create function public.findback_save_post_client(p_post_id text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_post_id is null or length(trim(p_post_id)) = 0 then
    raise exception 'Invalid post id' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.item_posts p where p.id = trim(p_post_id)
  ) then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;

  insert into public.post_saves (post_id, user_id, created_at)
  values (trim(p_post_id), v_uid, v_now)
  on conflict (post_id, user_id) do update
    set created_at = excluded.created_at;
  return true;
end;
$$;

revoke all on function public.findback_save_post_client(text) from public, anon;
grant execute on function public.findback_save_post_client(text) to authenticated;

comment on function public.findback_save_post_client(text) is
  'FindBack save a report (authenticated): saves the report for the CALLER only (auth.uid(), never a parameter). The report must exist in public.item_posts; a re-save refreshes the server save clock without creating a duplicate. Returns true on success.';

-- ---------------------------------------------------------------------------
-- 4. findback_unsave_post_client — remove one report.
-- ---------------------------------------------------------------------------
-- Deletes the CALLER's own row and nothing else: the delete predicate names
-- `user_id = v_uid`, so no other reader's row is even reachable from here.
drop function if exists public.findback_unsave_post_client(text);

create function public.findback_unsave_post_client(p_post_id text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_post_id is null or length(trim(p_post_id)) = 0 then
    raise exception 'Invalid post id' using errcode = '22023';
  end if;

  delete from public.post_saves s
   where s.post_id = trim(p_post_id)
     and s.user_id = v_uid;
  return true;
end;
$$;

revoke all on function public.findback_unsave_post_client(text) from public, anon;
grant execute on function public.findback_unsave_post_client(text) to authenticated;

comment on function public.findback_unsave_post_client(text) is
  'FindBack remove a saved report (authenticated): deletes the CALLER''s own row for that report (auth.uid(), never a parameter) and touches no other reader''s row. Removing a report that is not saved is a no-op. Returns true.';

-- ---------------------------------------------------------------------------
-- 5. findback_list_saved_posts_client — the caller's saved reports.
-- ---------------------------------------------------------------------------
-- The caller's own rows, newest first. No title, no author, no report body:
-- the list says WHICH reports are saved and WHEN, and the client reads the
-- report itself through the feed reader it already uses.
--
-- `created_at` is the house text format, the same value the table stores, so
-- the client can show "Saved 2m ago" without knowing about the format.
-- Return ONE scalar JSON value: PostgREST row limits must not silently omit
-- older saves. The aggregate reads one database snapshot and includes every
-- caller-owned id; the device's 200-entry cache budget is not an account limit.
drop function if exists public.findback_list_saved_posts_client();

create function public.findback_list_saved_posts_client()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return (
    select jsonb_build_object('complete', true, 'items',
      coalesce(jsonb_agg(jsonb_build_object('post_id', s.post_id, 'saved_at', s.created_at)
        order by s.created_at desc, s.post_id asc), '[]'::jsonb))
    from public.post_saves s
    where s.user_id = v_uid
  );
end;
$$;

revoke all on function public.findback_list_saved_posts_client() from public, anon;
grant execute on function public.findback_list_saved_posts_client() to authenticated;

comment on function public.findback_list_saved_posts_client() is
  'FindBack complete saved-report snapshot (authenticated): JSON {complete:true,items:[{post_id,saved_at}]}, newest first. Only the CALLER''s rows. Device cache limits do not limit the account list.';
