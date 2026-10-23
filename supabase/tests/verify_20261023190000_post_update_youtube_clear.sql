-- Disposable-local behavior probes. Run through scripts/sql-behavior.mjs.
-- Not hosted/PostgREST evidence. Fixture writes are always rolled back.
begin;
insert into public.users(id, username, email, phone, password_hash, email_verified, phone_verified, created_at, updated_at)
values ('00000000-0000-4000-8000-00000000ed01','edit_owner','edit_owner@example.invalid','+15550009101',null,1,0,'2026-10-23','2026-10-23'),
       ('00000000-0000-4000-8000-00000000ed02','edit_other','edit_other@example.invalid','+15550009102',null,1,0,'2026-10-23','2026-10-23');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,location_label,latitude,longitude,youtube_url,created_at,updated_at)
values ('edit-clear-owned','00000000-0000-4000-8000-00000000ed01','LOST','Original title','An original description long enough','Electronics','OPEN','2020-01-01','Old place',1.5,2.5,'https://www.youtube.com/watch?v=dQw4w9WgXcQ','2026-10-23','2026-10-23');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000ed01',true);
select public.findback_update_post_client('edit-clear-owned',p_title=>'Changed title') as ordinary_update;
select 'Y1 ordinary update keeps link and location' as probe where exists (
  select 1 from public.item_posts where id='edit-clear-owned' and title='Changed title'
  and youtube_url='https://www.youtube.com/watch?v=dQw4w9WgXcQ' and location_label='Old place' and latitude=1.5 and longitude=2.5);
select public.findback_update_post_client('edit-clear-owned',p_youtube_url=>'  ',p_clear_fields=>null) as no_explicit_clear;
select 'Y2 blank without explicit clear keeps old link' as probe where exists (
  select 1 from public.item_posts where id='edit-clear-owned' and youtube_url='https://www.youtube.com/watch?v=dQw4w9WgXcQ');

select public.findback_update_post_client('edit-clear-owned',p_clear_fields=>array[' YouTube_Url ','youtube_url']) as clear_youtube;
select 'Y3 explicit normalized duplicate clear empties only link' as probe where exists (
  select 1 from public.item_posts where id='edit-clear-owned' and youtube_url is null and title='Changed title'
  and description='An original description long enough' and category='Electronics' and status='OPEN'
  and event_date='2020-01-01' and location_label='Old place' and latitude=1.5 and longitude=2.5);
select public.findback_update_post_client('edit-clear-owned',p_clear_fields=>array['youtube_url']) as repeat_clear;
select 'Y4 repeated clear stays empty' as probe where exists (select 1 from public.item_posts where id='edit-clear-owned' and youtube_url is null);

select public.findback_update_post_client('edit-clear-owned',p_youtube_url=>' https://youtu.be/dQw4w9WgXcQ ',p_clear_fields=>array['youtube_url']) as replacement_wins;
select 'Y5 explicit replacement wins over clear' as probe where exists (
  select 1 from public.item_posts where id='edit-clear-owned' and youtube_url='https://youtu.be/dQw4w9WgXcQ');
do $$ begin
  begin
    perform public.findback_update_post_client('edit-clear-owned',p_title=>'Must not land',p_youtube_url=>'https://example.invalid/not-youtube',p_clear_fields=>array['youtube_url']);
    raise exception 'invalid replacement accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.findback_update_post_client('edit-clear-owned',p_title=>'Must not land',p_clear_fields=>array['youtube_url','title']);
    raise exception 'required field clear accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.findback_update_post_client('edit-clear-owned',p_title=>'Must not land',p_clear_fields=>array['youtube_url','unknown']);
    raise exception 'unknown field clear accepted';
  exception when sqlstate '22023' then null; end;
end $$;
select 'Y6 refused edits leave all relevant values intact' as probe where exists (
  select 1 from public.item_posts where id='edit-clear-owned' and title='Changed title'
  and youtube_url='https://youtu.be/dQw4w9WgXcQ' and location_label='Old place' and latitude=1.5 and longitude=2.5);

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000ed02',true);
do $$ begin
  begin
    perform public.findback_update_post_client('edit-clear-owned',p_clear_fields=>array['youtube_url']);
    raise exception 'nonowner clear accepted';
  exception when sqlstate '42501' then null; end;
end $$;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
  begin
    perform public.findback_update_post_client('edit-clear-owned',p_clear_fields=>array['youtube_url']);
    raise exception 'missing session accepted';
  exception when sqlstate '28000' then null; end;
end $$;
set local role anon;
do $$ begin
  begin
    perform public.findback_update_post_client('edit-clear-owned',p_clear_fields=>array['youtube_url']);
    raise exception 'anonymous execute accepted';
  exception when sqlstate '42501' then null; end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000ed01',true);
select 'Y7 unauthorized attempts did not alter owner link' as probe where exists (
  select 1 from public.item_posts where id='edit-clear-owned' and youtube_url='https://youtu.be/dQw4w9WgXcQ');
select public.findback_update_post_client('edit-clear-owned',p_clear_fields=>array['youtube_url','location_label','latitude','longitude']) as clear_all_optional;
select 'Y8 original location clear contract preserved' as probe where exists (
  select 1 from public.item_posts where id='edit-clear-owned' and youtube_url is null and location_label is null and latitude is null and longitude is null);
reset role;
select 'Y11 supported URL formats and spoof refusals match the client' as probe where not exists (
  select 1 from (values
    ('https://www.youtube.com/watch?v=dQw4w9WgXcQ',true),
    ('http://youtube.com/watch?v=dQw4w9WgXcQ&t=12',true),
    ('https://youtu.be/dQw4w9WgXcQ?si=share',true),
    ('https://youtube.com/embed/dQw4w9WgXcQ',true),
    ('https://www.youtube.com/shorts/dQw4w9WgXcQ',true),
    ('HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ',true),
    ('https://notyoutube.com/watch?v=dQw4w9WgXcQ',false),
    ('https://example.invalid/youtube.com/watch?v=dQw4w9WgXcQ',false),
    ('https://youtube.com.example.invalid/watch?v=dQw4w9WgXcQ',false),
    ('javascript:youtube.com/watch?v=dQw4w9WgXcQ',false),
    ('ftp://youtube.com/watch?v=dQw4w9WgXcQ',false),
    ('//youtube.com/watch?v=dQw4w9WgXcQ',false),
    ('https://www.youtube.com/watch?foo=bar&v=dQw4w9WgXcQ',false),
    ('https://youtube.com/watch?v=short',false)
  ) as cases(url,expected) where public.findback_is_valid_youtube_url(url) is distinct from expected
);
select 'Y9 signature and privilege posture preserved' as probe where exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='findback_update_post_client' and not p.prosecdef
  and p.pronargs=11 and p.proargnames[11]='p_clear_fields' and p.proconfig @> array['search_path=public, pg_temp']
  and has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
  and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
  and 1=(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='findback_update_post_client');
rollback;
select 'Y10 scratch writes rolled back' as probe where not exists (select 1 from public.item_posts where id='edit-clear-owned')
  and not exists(select 1 from public.users where id in ('00000000-0000-4000-8000-00000000ed01','00000000-0000-4000-8000-00000000ed02'));
