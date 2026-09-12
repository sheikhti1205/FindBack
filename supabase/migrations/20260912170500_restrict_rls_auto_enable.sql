-- Harden the Supabase-managed `public.rls_auto_enable()` function.
--
-- Context:
--   The platform installs `public.rls_auto_enable()` as a SECURITY DEFINER
--   event-trigger function that enables RLS on newly created tables. Event
--   triggers are invoked by the DDL system, not through role EXECUTE grants,
--   so no API role needs to call this function.
--
--   Supabase Security Advisor flagged it as executable by `anon` and
--   `authenticated` via /rest/v1/rpc/rls_auto_enable
--   (lints anon_security_definer_function_executable and
--    authenticated_security_definer_function_executable).
--
-- This migration removes the public/API execution privileges while preserving
-- the `ensure_rls` event trigger installed by Supabase.

revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.rls_auto_enable() from anon;
revoke execute on function public.rls_auto_enable() from authenticated;
