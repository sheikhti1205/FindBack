-- FindBack — harden complete_social_profile grants (post-v1 W0).
--
-- Supabase's default privileges grant EXECUTE to anon on every new function;
-- the completion migration's `revoke … from public` does not remove that
-- explicit anon grant. The RPC already fails closed for unauthenticated callers
-- (public.findback_uid() is null -> 28000 'not authenticated'), but the
-- advisor `anon_security_definer_function_executable` flags the reachable
-- SECURITY DEFINER surface, so revoke it explicitly.
--
-- Additive, non-destructive: only revokes a privilege the function was never
-- meant to expose. `authenticated` keeps EXECUTE (the intended caller).
revoke execute on function public.complete_social_profile(text, text, text, text) from anon;
revoke execute on function public.complete_social_profile(text, text, text, text) from public;
grant execute on function public.complete_social_profile(text, text, text, text) to authenticated;
