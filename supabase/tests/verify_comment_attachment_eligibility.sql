-- Alternate definer creation path: eligibility precedes topology diagnostics
-- and report-reference existence checks. Every rejected call rolls back fully.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9400-'||lpad(n::text,12,'0'),'attach_eligibility_'||n,
 'attach_eligibility_'||n||'@example.invalid','+880194000000'||n,1,'2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'
from generate_series(1,4) n;
insert into public.user_roles(user_id,role,granted_at)
values('00000000-0000-4000-9400-000000000004','ADMIN','2026-10-24T00:00:00.000Z');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
select 'ca-post-'||n,'00000000-0000-4000-9400-000000000001','LOST','Attachment post','Description','Electronics','OPEN',
 '2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z' from generate_series(1,3) n;
insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
values('ca-hidden-parent','ca-post-1','00000000-0000-4000-9400-000000000002','Hidden parent','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'),
 ('ca-foreign-parent','ca-post-2','00000000-0000-4000-9400-000000000002','Foreign parent','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000004',true);
select public.findback_apply_moderation('COMMENT','ca-hidden-parent','HIDE','HARASSMENT',null) as audit;
select public.findback_apply_moderation('POST','ca-post-3','HIDE','HARASSMENT',null) as audit;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000003',true);
do $$ declare v_parent text; begin
 foreach v_parent in array array['ca-hidden-parent','ca-missing-parent','ca-foreign-parent'] loop
  begin
   perform public.findback_add_comment_with_attachments('ca-post-1','Attempt',v_parent,'[]'::jsonb);
   raise exception 'CA1 attachment RPC accepted unauthorized parent' using errcode='0A000';
  exception when no_data_found then
   if sqlerrm<>'Comment target unavailable' then
    raise exception 'CA1 attachment RPC disclosed parent metadata: %',sqlerrm;
   end if;
  end;
 end loop;
end $$;
do $$ declare v_report text; begin
 foreach v_report in array array['ca-post-3','ca-missing-report'] loop
  begin
   perform public.findback_add_comment_with_attachments('ca-post-1','',null,
     jsonb_build_array(jsonb_build_object('kind','report','display_order',1,'report_post_id',v_report)));
   raise exception 'CA2 attachment RPC accepted unreadable report reference' using errcode='0A000';
  exception when no_data_found then
   if sqlerrm<>'Report target unavailable' then
    raise exception 'CA2 report reference disclosed target existence: %',sqlerrm;
   end if;
  end;
 end loop;
end $$;
reset role;
select 'CA3 rejected calls left no comment, attachment or outcome' as probe
where not exists(select 1 from public.comments where user_id='00000000-0000-4000-9400-000000000003')
 and not exists(select 1 from public.comment_attachments where user_id='00000000-0000-4000-9400-000000000003');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000003',true);
select 'CA4 authorized reference-only comment still succeeds' as probe
from public.findback_add_comment_with_attachments('ca-post-1','',null,
 '[{"kind":"report","display_order":1,"report_post_id":"ca-post-2"}]'::jsonb) c where c.body='';
reset role;
select 'CA4 the authorized reference is stored, no hidden reference is stored' as probe
where exists(select 1 from public.comment_attachments where user_id='00000000-0000-4000-9400-000000000003'
 and report_post_id='ca-post-2')
 and not exists(select 1 from public.comment_attachments where report_post_id='ca-post-3');

-- CA5. `report_post_id` is nullable on purpose (ON DELETE SET NULL). The
-- surviving row is a content-free tombstone the viewer must still see, so a
-- NULL pointer must be readable and must reach the list projection.
reset role;
insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
values('ca-tombstone-comment','ca-post-1','00000000-0000-4000-9400-000000000001','Tombstone comment',
 '2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.comment_attachments(id,comment_id,user_id,kind,display_order,report_post_id,created_at)
values('ca-tombstone-report','ca-tombstone-comment','00000000-0000-4000-9400-000000000001','report',1,null,
 '2026-10-24T00:00:00.000Z');
insert into public.comment_attachments(id,comment_id,user_id,kind,display_order,storage_path,remote_url,created_at)
values('ca-foreign-media','ca-tombstone-comment','00000000-0000-4000-9400-000000000001','photo',2,
 '00000000-0000-4000-9400-000000000001/photo.jpg','https://cdn.test/photo.jpg','2026-10-24T00:00:00.000Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000003',true);
select 'CA5 a NULL report pointer survives as a readable tombstone' as probe
where exists(select 1 from public.comment_attachments where id='ca-tombstone-report')
  and not exists(select 1 from public.comment_attachments where id='ca-foreign-media')
  and exists(select 1 from public.findback_list_comments_client('ca-post-1') c
    where c.id='ca-tombstone-comment'
      and c.attachments @> '[{"kind":"report","report_post_id":null}]'::jsonb);
reset role;
rollback;
