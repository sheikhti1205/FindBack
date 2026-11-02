-- Fail-closed worker completion: a fresh lease or unswept expired reservation
-- still represents pending work, even when a claim returns no eligible rows.
begin;
create function public.findback_comment_media_cleanup_pending()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.comment_media_cleanup_queue)
    or exists(select 1 from public.comment_media_reservations
      where attachment_id is null and expires_at<=now());
$$;
revoke all on function public.findback_comment_media_cleanup_pending() from public,anon,authenticated;
grant execute on function public.findback_comment_media_cleanup_pending() to service_role;
commit;
