-- Disposable local engine only; safe discovery contract, no hosted identities.
begin;
insert into public.users(id,username,email,phone,display_name,created_at,updated_at)
select '00000000-0000-4000-9300-'||lpad(n::text,12,'0'),
       case n when 1 then 'people_viewer' when 2 then 'river' when 3 then 'riverbank'
         when 4 then 'different' when 5 then 'riverblocked' when 6 then 'riverblocker'
         when 7 then 'riverdeleting' when 8 then 'r' else 'river'||lpad(n::text,3,'0') end,
       'private_'||n||'@example.invalid','+100009300'||lpad(n::text,3,'0'),
       case when n=4 then 'Wide River Name' else 'Person '||n end,
       '2026-10-31T00:00:00Z','2026-10-31T00:00:00Z'
from generate_series(1,45) n;
insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at) values
 ('00000000-0000-4000-9300-000000000001','00000000-0000-4000-9300-000000000005','2026-10-31T00:00:00Z'),
 ('00000000-0000-4000-9300-000000000006','00000000-0000-4000-9300-000000000001','2026-10-31T00:00:00Z');
insert into public.account_deletion_fences(user_id) values ('00000000-0000-4000-9300-000000000007');

do $$ begin
  assert not has_function_privilege('anon','public.findback_search_people(text,jsonb,integer)','execute'), 'anon cannot enumerate people';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000001',true);
do $$ declare page jsonb; cursor jsonb; ids text[]='{}'; more jsonb; n integer=0; begin
  page:=public.findback_search_people(' @RiVeR ',null,2);
  assert page->'items'->0->>'username'='river', 'exact username first after normalization';
  assert jsonb_array_length(page->'items')=2, 'requested page bound';
  assert page->'nextCursor' is not null and page->'nextCursor'<>'null'::jsonb,'more page cursor';
  loop
    for more in select value from jsonb_array_elements(page->'items') loop
      assert not ((more->>'id')=any(ids)), 'no duplicate between pages';
      ids:=array_append(ids,more->>'id');
      assert (select array_agg(key order by key) from jsonb_object_keys(more) key)=array['avatar_url','display_name','id','username'], 'public fields only';
      assert more->>'username' not in ('riverblocked','riverblocker','riverdeleting'), 'block symmetry and deletion exclusion';
    end loop;
    cursor:=page->'nextCursor'; exit when cursor='null'::jsonb;
    n:=n+1; assert n<30,'bounded pagination terminates';
    page:=public.findback_search_people('river',cursor,2);
  end loop;
  assert cardinality(ids)=40,'all visible matches paginated without omission';
  assert page->'items'->(jsonb_array_length(page->'items')-1)->>'username'='different','display name follows username-prefix matches';
  assert jsonb_array_length(public.findback_search_people('r',null,30)->'items')=1,'one character permits exact only';
  assert jsonb_array_length(public.findback_search_people('',null,30)->'items')=0,'empty does not enumerate';
  assert jsonb_array_length(public.findback_search_people('%',null,30)->'items')=0,'wildcard is literal';
  assert jsonb_array_length(public.findback_search_people('people_viewer',null,30)->'items')=0,'own account is not a discovery result';
  assert jsonb_array_length(public.findback_search_people('private_',null,30)->'items')=0,'contact fields are not searchable';
  assert jsonb_array_length(public.findback_search_people('river',null,999)->'items')=30,'server caps page size';
  begin
    perform public.findback_search_people(repeat('r',81),null,2);
    raise exception 'oversized query accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.findback_search_people('different',public.findback_search_people('river',null,2)->'nextCursor',2);
    raise exception 'cursor from another query accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.findback_search_people('river','{"rank":0}'::jsonb,2);
    raise exception 'malformed cursor accepted';
  exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
  begin
    perform public.findback_search_people('river',null,2);
    raise exception 'missing session accepted';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000007',true);
do $$ begin
  begin
    perform public.findback_search_people('river',null,2);
    raise exception 'deleting caller accepted';
  exception when insufficient_privilege then null; end;
end $$;
select 'people search engine assertions passed' as result;
rollback;
