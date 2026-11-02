-- Real full-chain authority regression; historical rows remain readable.
begin;
-- Hosted Storage supplies these platform privileges; the local harness does not.
grant usage on schema storage to authenticated;
grant select,insert,delete on storage.objects to authenticated;
grant usage on all sequences in schema storage to authenticated;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at,created_at,updated_at) values
('00000000-0000-4000-8000-00000000e301','residual@example.invalid','{"username":"residual","phone":"+8801712345690"}',now(),now()-interval '40 days',now());
insert into public.user_roles(user_id,role,granted_at) values
('00000000-0000-4000-8000-00000000e301','ADMIN',now()::text);
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at) values
('residual-post','00000000-0000-4000-8000-00000000e301','LOST','Residual target','Synthetic report fixture','Other','OPEN','2026-11-01',now()::text,now()::text);
insert into public.comments(id,post_id,user_id,body,created_at,updated_at) values
('residual-comment','residual-post','00000000-0000-4000-8000-00000000e301','Synthetic comment',now()::text,now()::text);
insert into public.reactions(id,post_id,user_id,type,created_at) values
(md5('reaction|residual-post|00000000-0000-4000-8000-00000000e301'),'residual-post','00000000-0000-4000-8000-00000000e301','WOW',now()::text);
insert into storage.objects(bucket_id,name,owner_id) values
('findback-report-media','00000000-0000-4000-8000-00000000e302/report.jpg','00000000-0000-4000-8000-00000000e302');
insert into public.attachments(id,post_id,file_url,storage_path,mime_type,file_name,file_size,created_at) values
('residual-photo','residual-post','00000000-0000-4000-8000-00000000e302/report.jpg','00000000-0000-4000-8000-00000000e302/report.jpg','image/jpeg','report.jpg',100,now()::text);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000e301',true);
set local role authenticated;
do $$ declare k text; begin
 foreach k in array array['DISLIKE','LOVE','HELPFUL','SUPPORT','WOW'] loop
  begin
   perform public.findback_react_client('residual-post',k);
   raise exception 'Legacy post reaction % accepted',k;
  exception when invalid_parameter_value then null; end;
  begin
   perform public.findback_react_comment_client('residual-comment',k);
   raise exception 'Legacy comment reaction % accepted',k;
  exception when invalid_parameter_value then null; end;
 end loop;
end $$;
reset role;
select 'R0 rejected writes preserve historical row' as probe where
 (select type from public.reactions where post_id='residual-post')='WOW';
set local role authenticated;
select 'R1 post LIKE replaces historical positive' as probe where
 (select my_reaction from public.findback_react_client('residual-post','LIKE'))='LIKE';
select 'R2 comment LIKE writes and null clears' as probe where
 (select my_reaction from public.findback_react_comment_client('residual-comment','LIKE'))='LIKE';
select 'R3 clearing post/comment remains supported' as probe where
 (select my_reaction from public.findback_react_client('residual-post',null)) is null
 and (select my_reaction from public.findback_react_comment_client('residual-comment',null)) is null;
do $$ begin
 begin
  insert into storage.objects(bucket_id,name,owner_id) values
  ('findback-images','00000000-0000-4000-8000-00000000e301/unmanaged.jpg','00000000-0000-4000-8000-00000000e301');
  raise exception 'Legacy generic public upload accepted';
 exception when insufficient_privilege then null; end;
end $$;
insert into storage.objects(bucket_id,name,owner_id) values
('findback-images','avatars/00000000-0000-4000-8000-00000000e301/avatar.jpg','00000000-0000-4000-8000-00000000e301');
select 'R4 own avatar remains writable and readable' as probe where exists(
 select 1 from storage.objects where name='avatars/00000000-0000-4000-8000-00000000e301/avatar.jpg');
delete from storage.objects where bucket_id='findback-images' and name='avatars/00000000-0000-4000-8000-00000000e301/avatar.jpg';
select 'R4b avatar delete succeeds' as probe where not exists(
 select 1 from storage.objects where name='avatars/00000000-0000-4000-8000-00000000e301/avatar.jpg');
select 'R4c published report object readable without raw attachment grants' as probe where exists(
 select 1 from storage.objects where bucket_id='findback-report-media'
 and name='00000000-0000-4000-8000-00000000e302/report.jpg')
 and not has_any_column_privilege('authenticated','public.attachments','SELECT');
select 'R4d unbound object denied by caller-bound helper' as probe where
 not public.findback_can_read_report_object('not-attached.jpg');
reset role;
select 'R5 generic legacy Storage policies absent' as probe where not exists(
 select 1 from pg_policies where schemaname='storage' and tablename='objects'
 and policyname in ('findback_images_insert_own','findback_images_select_own','findback_images_delete_own'));
rollback;
