-- FindBack — RLS initplan fix for the 10E write policies.
--
-- The Supabase performance advisor flags `auth.uid()` called directly inside an
-- RLS policy (`auth_rls_initplan`): it is re-evaluated per row. Wrapping it in a
-- scalar subquery `(select auth.uid())` lets the planner hoist it to a single
-- initplan. Semantics are unchanged.

drop policy if exists item_posts_insert_own on public.item_posts;
create policy item_posts_insert_own
  on public.item_posts for insert to authenticated
  with check (user_id = (select auth.uid())::text);

drop policy if exists item_posts_update_own on public.item_posts;
create policy item_posts_update_own
  on public.item_posts for update to authenticated
  using (user_id = (select auth.uid())::text)
  with check (user_id = (select auth.uid())::text);

drop policy if exists item_posts_delete_own on public.item_posts;
create policy item_posts_delete_own
  on public.item_posts for delete to authenticated
  using (user_id = (select auth.uid())::text);

drop policy if exists attachments_insert_own on public.attachments;
create policy attachments_insert_own
  on public.attachments for insert to authenticated
  with check (
    exists (
      select 1 from public.item_posts p
      where p.id = attachments.post_id
        and p.user_id = (select auth.uid())::text
    )
  );

drop policy if exists uploads_select_own on public.uploads;
create policy uploads_select_own
  on public.uploads for select to authenticated
  using (user_id = (select auth.uid())::text);
