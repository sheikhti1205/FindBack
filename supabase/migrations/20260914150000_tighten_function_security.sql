-- FindBack — tighten function security flagged by the Supabase advisors.
--
-- 1. findback_uid(): pin an empty search_path (it only calls auth.uid()).
-- 2. findback_login_email(): login is always an unauthenticated action, so only
--    anon needs EXECUTE. Revoking authenticated narrows the surface. This
--    function remains SECURITY DEFINER by design (RLS hides other rows); the
--    anon-executable advisory is accepted and documented.

create or replace function public.findback_uid()
returns text
language sql
stable
set search_path = ''
as $$
  select auth.uid()::text
$$;

revoke all on function public.findback_uid() from public, anon;
grant execute on function public.findback_uid() to authenticated;

revoke execute on function public.findback_login_email(text) from authenticated;
