-- Provisional email signups reserve their identity but are not public profiles.
-- This is an auth lifecycle correction, separate from the applied P11 migration.
begin;

create or replace function public.public_profile_by_username(p_username text)
returns table(id text,username text,avatar_url text,email_verified boolean,
  phone_verified boolean,display_name text,bio text,location_label text,created_at text)
language sql stable security definer set search_path=public,pg_temp as $$
  select u.id,u.username,u.avatar_url,coalesce(u.email_verified,0)<>0,
    coalesce(u.phone_verified,0)<>0,u.display_name,u.bio,u.location_label,u.created_at
  from public.users u join auth.users a on a.id::text=u.id
  where lower(u.username)=lower(btrim(p_username)) and a.email_confirmed_at is not null
  limit 1
$$;

create or replace function public.findback_search_profiles_client(p_prefix text)
returns table(id text,username text,display_name text,avatar_url text)
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_prefix text:=nullif(btrim(coalesce(p_prefix,'')),'');
begin
  if public.findback_uid() is null then raise exception 'not authenticated' using errcode='28000'; end if;
  return query select u.id,u.username,u.display_name,u.avatar_url
    from public.users u join auth.users a on a.id::text=u.id
    where v_prefix is not null and u.username is not null
      and a.email_confirmed_at is not null
      and lower(u.username) like lower(v_prefix)||'%'
    order by u.username limit 8;
end $$;

-- Preserve the bounded people-search contract; add the same authoritative
-- confirmation boundary to its candidates, not client-side filtering.
create or replace function public.findback_search_people(
  p_query text,p_cursor jsonb default null,p_limit integer default 20
) returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp as $$
declare
  v_me text:=auth.uid()::text;
  v_query text:=lower(btrim(coalesce(p_query,'')));
  v_limit integer:=greatest(1,least(30,coalesce(p_limit,20)));
  v_rank integer; v_username text; v_id text; v_result jsonb;
begin
  if v_me is null or not exists(select 1 from public.users where id=v_me)
    or exists(select 1 from public.account_deletion_fences where user_id=v_me) then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if left(v_query,1)='@' then v_query:=btrim(substr(v_query,2)); end if;
  if length(v_query)>80 then raise exception 'Search query too long' using errcode='22023'; end if;
  if v_query='' then return jsonb_build_object('items','[]'::jsonb,'nextCursor',null); end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor)<>'object'
      or jsonb_typeof(p_cursor->'rank') is distinct from 'number'
      or jsonb_typeof(p_cursor->'username') is distinct from 'string'
      or jsonb_typeof(p_cursor->'id') is distinct from 'string'
      or p_cursor->>'query' is distinct from v_query
      or (p_cursor->>'rank') not in ('0','1','2')
      or length(p_cursor->>'username') not between 1 and 100
      or length(p_cursor->>'id') not between 1 and 100 then
      raise exception 'Invalid search cursor' using errcode='22023';
    end if;
    v_rank:=(p_cursor->>'rank')::integer;
    v_username:=p_cursor->>'username'; v_id:=p_cursor->>'id';
  end if;
  with candidates as (
    select u.id,u.username,u.display_name,u.avatar_url,lower(u.username) collate "C" as sort_name,
      case when lower(u.username)=v_query then 0
           when left(lower(u.username),length(v_query))=v_query then 1 else 2 end as rank
    from public.users u join auth.users a on a.id::text=u.id
    where u.id<>v_me and a.email_confirmed_at is not null
      and not exists(select 1 from public.account_deletion_fences f where f.user_id::text=u.id)
      and not public.findback_is_blocked_pair(v_me,u.id)
      and (lower(u.username)=v_query or (length(v_query)>=2 and (
        left(lower(u.username),length(v_query))=v_query
        or position(v_query in lower(coalesce(u.display_name,'')))>0)))
  ), bounded as (
    select * from candidates c where p_cursor is null or
      (c.rank,c.sort_name,c.id collate "C")>(v_rank,v_username collate "C",v_id collate "C")
    order by c.rank,c.sort_name,c.id collate "C" limit v_limit+1
  ), page as (
    select * from bounded order by rank,sort_name,id collate "C" limit v_limit
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',id,'username',username,'display_name',display_name,'avatar_url',avatar_url)
    order by rank,sort_name,id collate "C") from page),'[]'::jsonb),
    'nextCursor',case when (select count(*) from bounded)>v_limit then
      (select jsonb_build_object('query',v_query,'rank',rank,'username',sort_name,'id',id)
       from page order by rank desc,sort_name desc,id collate "C" desc limit 1) else null end)
  into v_result;
  return v_result;
end $$;

-- This public flag is populated by the Auth confirmation trigger, not editable
-- through profile RPCs. Definer discovery above checks auth.users directly.
drop policy if exists users_select_public_authenticated on public.users;
create policy users_select_public_authenticated on public.users for select to authenticated
using (email_verified=1);

-- Only never-activated email signups, after a 30-day grace period. Locking the
-- Auth row serializes confirmation against cleanup: whichever wins is final.
-- Never deletes a session-bearing account, content, Storage bytes or role offer.
create function public.findback_purge_stale_unconfirmed_signups(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_count integer:=0;
begin
  for v_id in select a.id from auth.users a
    where a.email_confirmed_at is null and a.phone_confirmed_at is null
      and a.last_sign_in_at is null and a.created_at<now()-interval '30 days'
      and not exists(select 1 from public.item_posts p where p.user_id=a.id::text)
      and not exists(select 1 from public.comments c where c.user_id=a.id::text)
      and not exists(select 1 from public.chat_messages m where m.sender_id=a.id::text)
      and not exists(select 1 from public.user_roles r where r.user_id=a.id::text)
      and not exists(select 1 from storage.objects o where o.owner_id=a.id::text
        or split_part(o.name,'/',1)=a.id::text)
    order by a.created_at,a.id limit greatest(1,least(100,coalesce(p_limit,100)))
    for update of a skip locked
  loop
    delete from auth.users where id=v_id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;
revoke all on function public.findback_purge_stale_unconfirmed_signups(integer) from public,anon,authenticated;
grant execute on function public.findback_purge_stale_unconfirmed_signups(integer) to service_role;
comment on function public.findback_purge_stale_unconfirmed_signups(integer) is
  'Service-only bounded cleanup of never-activated, content/storage/role-free signups older than 30 days; confirmation serialized by Auth row lock.';
commit;
