-- FindBack — login is email-only; drop the anonymous username->email resolver.
--
-- Block 10B.1 removed username-based login. The SECURITY DEFINER function
-- public.findback_login_email(text) let an unauthenticated caller turn a
-- username into an email address (an account-enumeration/privacy surface),
-- which Supabase's security advisor flagged. Usernames remain the unique public
-- profile identity and are still required at registration; they are simply not
-- an authentication identifier.

drop function if exists public.findback_login_email(text);
