-- Disposable PG full-chain boundary: provisional discovery and cleanup authority.
begin;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at,last_sign_in_at,created_at,updated_at) values
('00000000-0000-4000-8000-00000000e201','p11-reader@example.invalid','{"username":"p11reader","phone":"+8801712345678"}',now(),now(),now(),now()),
('00000000-0000-4000-8000-00000000e202','p11-pending@example.invalid','{"username":"p11pending","phone":"+8801712345679"}',null,null,now(),now()),
('00000000-0000-4000-8000-00000000e203','p11-stale@example.invalid','{"username":"p11stale","phone":"+8801712345680"}',null,null,now()-interval '31 days',now()-interval '31 days'),
('00000000-0000-4000-8000-00000000e204','p11-confirmed@example.invalid','{"username":"p11confirmed","phone":"+8801712345681"}',now(),now(),now()-interval '31 days',now()),
('00000000-0000-4000-8000-00000000e205','p11-files@example.invalid','{"username":"p11files","phone":"+8801712345682"}',null,null,now()-interval '31 days',now()-interval '31 days');
insert into storage.objects(bucket_id,name,owner_id) values
('findback-report-media','00000000-0000-4000-8000-00000000e205/file.jpg','00000000-0000-4000-8000-00000000e205');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000e201',true);
set local role authenticated;
select 'C1 provisional profile absent from raw public reads' as probe where
 not exists(select 1 from public.users where username='p11pending');
select 'C2 public username lookup hides provisional, retains confirmed' as probe where
 not exists(select 1 from public.public_profile_by_username('p11pending'))
 and exists(select 1 from public.public_profile_by_username('p11confirmed'));
select 'C3 people and mention search hide provisional' as probe where
 jsonb_array_length(public.findback_search_people('p11pending')->'items')=0
 and jsonb_array_length(public.findback_search_people('p11confirmed')->'items')=1
 and not exists(select 1 from public.findback_search_profiles_client('p11pending'))
 and exists(select 1 from public.findback_search_profiles_client('p11confirmed'));
select 'C4 attachment metadata has no table or surviving column read grant' as probe where
 not has_table_privilege('authenticated','public.attachments','SELECT')
 and not has_any_column_privilege('authenticated','public.attachments','SELECT');
select 'C5 signup purge cannot be called by clients' as probe where
 not has_function_privilege('authenticated','public.findback_purge_stale_unconfirmed_signups(integer)','EXECUTE')
 and not has_function_privilege('anon','public.findback_purge_stale_unconfirmed_signups(integer)','EXECUTE');
reset role;
set local role service_role;
select 'C6 service-only cleanup removes exactly one abandoned signup' as probe where
 public.findback_purge_stale_unconfirmed_signups(100)=1;
reset role;
select 'C7 cleanup retains fresh, confirmed and stored-file accounts, cascades only stale profile' as probe where
 not exists(select 1 from auth.users where id='00000000-0000-4000-8000-00000000e203')
 and not exists(select 1 from public.users where id='00000000-0000-4000-8000-00000000e203')
 and (select count(*) from auth.users where id in (
 '00000000-0000-4000-8000-00000000e202','00000000-0000-4000-8000-00000000e204','00000000-0000-4000-8000-00000000e205'))=3;
update auth.users set email_confirmed_at=now() where id='00000000-0000-4000-8000-00000000e202';
set local role authenticated;
select 'C8 confirmation makes the existing profile discoverable, without recreating it' as probe where
 exists(select 1 from public.users where username='p11pending')
 and exists(select 1 from public.public_profile_by_username('p11pending'))
 and jsonb_array_length(public.findback_search_people('p11pending')->'items')=1;
reset role;
rollback;
