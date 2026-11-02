-- Full-chain local contract. Storage service/HTTP delivery is separate acceptance.
begin;
grant usage on schema storage to authenticated;
grant select,insert,delete on storage.objects to authenticated;
grant usage on all sequences in schema storage to authenticated;
select 'M1 comment bytes are private' as probe where
 (select not public from storage.buckets where id='findback-comment-media');
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at,created_at,updated_at) values
('00000000-0000-4000-8000-00000000e401','comment-media@example.invalid','{"username":"commentmedia","phone":"+8801712345691"}',now(),now()-interval '40 days',now()),
('00000000-0000-4000-8000-00000000e402','comment-reader@example.invalid','{"username":"commentreader","phone":"+8801712345692"}',now(),now()-interval '40 days',now());
insert into public.user_roles(user_id,role,granted_at) values
('00000000-0000-4000-8000-00000000e401','ADMIN',now()::text);
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at) values
('media-post','00000000-0000-4000-8000-00000000e401','LOST','Media target','Synthetic fixture','Other','OPEN','2026-11-01',now()::text,now()::text),
('other-media-post','00000000-0000-4000-8000-00000000e401','LOST','Other target','Synthetic fixture','Other','OPEN','2026-11-01',now()::text,now()::text);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000e401',true);
set local role authenticated;
do $$ begin
 begin
  insert into storage.objects(bucket_id,name,owner_id,metadata) values
  ('findback-comment-media','00000000-0000-4000-8000-00000000e401/unreserved.jpg','00000000-0000-4000-8000-00000000e401','{"size":100,"mimetype":"image/jpeg"}');
  raise exception 'Unreserved upload accepted';
 exception when insufficient_privilege then null; end;
end $$;
-- One reserve + object + descriptor must commit atomically through existing RPC.
do $$ declare k text; c text; d jsonb; begin
 k:=public.findback_reserve_comment_media('media-post','jpg');
 insert into storage.objects(bucket_id,name,owner_id,metadata) values
 ('findback-comment-media',k,'00000000-0000-4000-8000-00000000e401','{"size":123,"mimetype":"image/jpeg"}');
 d:=jsonb_build_array(jsonb_build_object('kind','photo','display_order',1,'storage_key',k,
 'remote_url','https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/authenticated/findback-comment-media/'||k));
 begin
  perform public.findback_add_comment_with_attachments('other-media-post','Wrong target',null,d);
  raise exception 'Reservation retarget accepted';
 exception when invalid_parameter_value then null; end;
 select id into c from public.findback_add_comment_with_attachments('media-post','Photo',null,d);
 -- Discard after commit cannot schedule deletion of live bytes.
 perform public.findback_discard_comment_media(k);
 if not exists(select 1 from storage.objects where bucket_id='findback-comment-media' and name=k) then
  raise exception 'Committed media not readable';
 end if;
end $$;
reset role;
-- Advance the fixture past the independent public comment cooldown, rather
-- than weakening/disabling admission to reach the reservation boundary.
update public.comments set created_at=(now()-interval '5 minutes')::text where post_id='media-post';
set local role authenticated;
do $$ declare k text; d jsonb; begin
 select name into k from storage.objects where bucket_id='findback-comment-media';
 d:=jsonb_build_array(jsonb_build_object('kind','photo','display_order',1,'storage_key',k,
 'remote_url','https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/authenticated/findback-comment-media/'||k));
 begin
  perform public.findback_add_comment_with_attachments('media-post','Reuse',null,d);
  raise exception 'Reservation reused';
 exception when invalid_parameter_value then null; end;
end $$;
reset role;
select 'M2 canonical writer binds one attachment with observed size/MIME' as probe where
 (select count(*) from public.comment_attachments where provider='STORAGE' and file_size=123 and mime_type='image/jpeg')=1
 and not exists(select 1 from public.comment_media_cleanup_queue);
select 'M3 private reservation has no client table access' as probe where
 not has_table_privilege('authenticated','public.comment_media_reservations','SELECT')
 and not has_function_privilege('authenticated','public.purge_abandoned_comment_media(integer)','EXECUTE');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000e402',true);
set local role authenticated;
select 'M4 readable comment authorizes a different reader' as probe where
 (select count(*) from storage.objects where bucket_id='findback-comment-media')=1;
reset role;
update public.item_posts set moderation_visibility='HIDDEN' where id='media-post';
set local role authenticated;
select 'M5 hidden report blocks private comment reads' as probe where
 not exists(select 1 from storage.objects where bucket_id='findback-comment-media');
reset role;
-- Delete comment queues bytes; abandoned reservations independently expire.
delete from public.comments where post_id='media-post';
select 'M6 comment deletion queues media' as probe where
 (select count(*) from public.comment_media_cleanup_queue)=1;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000e401',true);
set local role authenticated;
do $$ declare k text; begin
 k:=public.findback_reserve_comment_media('other-media-post','jpg');
 insert into storage.objects(bucket_id,name,owner_id,metadata) values
 ('findback-comment-media',k,'00000000-0000-4000-8000-00000000e401','{"size":100,"mimetype":"image/jpeg"}');
end $$;
reset role;
update public.comment_media_reservations set expires_at=now()-interval '1 minute' where attachment_id is null;
set local role service_role;
select 'M7 abandoned reservation purged in bounded sweep' as probe where
 public.purge_abandoned_comment_media(1)=1;
reset role;
select 'M8 expired reservation independently queued' as probe where
 (select count(*) from public.comment_media_cleanup_queue)=2;
set local role authenticated;
select 'M9 pending status is service-only' as probe where
 not has_function_privilege('authenticated','public.findback_comment_media_cleanup_pending()','EXECUTE');
reset role;
update public.comment_media_cleanup_queue set leased_at=now();
set local role service_role;
select 'M10 fresh leases still count as pending maintenance' as probe where
 public.findback_comment_media_cleanup_pending();
reset role;
rollback;
