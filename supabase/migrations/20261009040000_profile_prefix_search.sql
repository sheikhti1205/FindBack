-- FindBack — profile prefix search for @mention autocomplete (post-v1 W3.2).
--
-- ADDITIVE ONLY. The Supabase GitHub integration auto-applies migrations on
-- push, so this file must be safe to run once against the live schema: no
-- table/column drops, no row rewrites, no user/auth data deletion. It adds one
-- read-only RPC and touches nothing else.
--
-- Privacy: the OUT row carries the same four safe columns as the W1 public
-- identity surface (id, username, display_name, avatar_url). No contact
-- columns are selected, so private contact data can never leak through this
-- path.
--
-- Scope choice: username-prefix only (case-insensitive), ordered by username,
-- LIMIT 8. A display_name secondary match was considered and deliberately left
-- out: it would need a second OR branch plus a trigram index to stay cheap,
-- while the client already ranks discussion participants and the report owner
-- (whose display names are known locally) above server results. The LIMIT 8
-- bound gives the client headroom above its ~6 visible rows for local
-- filtering/dedupe.
--
-- Security choice: SECURITY DEFINER with a locked search_path, mirroring the
-- W1 `public_profile_by_username(text)` style, so the function works for every
-- authenticated caller without widening table grants on public.users. The
-- caller must be authenticated (resolved via public.findback_uid(); 28000
-- otherwise) and anon is explicitly revoked the EXECUTE default.

create or replace function public.findback_search_profiles_client(p_prefix text)
returns table (
  id text,
  username text,
  display_name text,
  avatar_url text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text := nullif(btrim(coalesce(p_prefix, '')), '');
begin
  if public.findback_uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  -- A blank prefix matches nothing (the client short-circuits before calling).
  return query
    select u.id,
           u.username,
           u.display_name,
           u.avatar_url
      from public.users u
     where v_prefix is not null
       and u.username is not null
       and lower(u.username) like lower(v_prefix) || '%'
     order by u.username
     limit 8;
end;
$$;

revoke all on function public.findback_search_profiles_client(text) from public;
revoke execute on function public.findback_search_profiles_client(text) from anon;
grant execute on function public.findback_search_profiles_client(text) to authenticated;
