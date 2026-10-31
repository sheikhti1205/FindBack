-- M7-P bounded public people discovery. Existing prefix helper remains intact
-- for recovery/mention callers. No contact fields, sanctions or provider data.
-- LIVE-PENDING: supabase/tests/verify_m7p_people_search.sql. Do not push before
-- migration + dependent milestone acceptance; no hosted application in this pass.
begin;
create function public.findback_search_people(
  p_query text, p_cursor jsonb default null, p_limit integer default 20
) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_me text := auth.uid()::text;
  v_query text := lower(btrim(coalesce(p_query,'')));
  v_limit integer := greatest(1,least(30,coalesce(p_limit,20)));
  v_rank integer;
  v_username text;
  v_id text;
  v_result jsonb;
begin
  if v_me is null or not exists(select 1 from public.users where id=v_me)
     or exists(select 1 from public.account_deletion_fences where user_id=v_me) then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if left(v_query,1)='@' then v_query:=btrim(substr(v_query,2)); end if;
  if length(v_query)>80 then
    raise exception 'Search query too long' using errcode='22023';
  end if;
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
    select u.id,u.username,u.display_name,u.avatar_url,
           lower(u.username) collate "C" as sort_name,
           case when lower(u.username)=v_query then 0
                when left(lower(u.username),length(v_query))=v_query then 1
                else 2 end as rank
    from public.users u
    where u.id<>v_me
      and not exists(select 1 from public.account_deletion_fences f where f.user_id::text=u.id)
      and not public.findback_is_blocked_pair(v_me,u.id)
      and (lower(u.username)=v_query or (length(v_query)>=2 and (
           left(lower(u.username),length(v_query))=v_query
           or position(v_query in lower(coalesce(u.display_name,'')))>0)))
  ), bounded as (
    select * from candidates c
    where p_cursor is null or (c.rank,c.sort_name,c.id collate "C")>
      (v_rank,v_username collate "C",v_id collate "C")
    order by c.rank,c.sort_name,c.id collate "C" limit v_limit+1
  ), page as (
    select * from bounded order by rank,sort_name,id collate "C" limit v_limit
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'username',username,
      'display_name',display_name,'avatar_url',avatar_url) order by rank,sort_name,id collate "C") from page),'[]'::jsonb),
    'nextCursor',case when (select count(*) from bounded)>v_limit then
      (select jsonb_build_object('query',v_query,'rank',rank,'username',sort_name,'id',id)
       from page order by rank desc,sort_name desc,id collate "C" desc limit 1)
      else null end
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.findback_search_people(text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.findback_search_people(text,jsonb,integer) to authenticated;
comment on function public.findback_search_people(text,jsonb,integer) is
  'Authenticated public identity search; exact/prefix/display-name ranking, bounded keyset pages; excludes deleting accounts and symmetric blocks. No private identity or relationship state.';
commit;
