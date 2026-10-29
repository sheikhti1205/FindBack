-- Ordering does not grant consumer access to delegates or weaken staff/D25
-- authorization. Real RPC calls under the authenticated SQL role, rolled back.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9873-00000000000'||n,'m1_entry_'||n,
 'm1_entry_'||n||'@example.invalid','+880198730000'||n,1,now(),now() from generate_series(1,3) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,moderation_visibility,created_at,updated_at)
values('m1entry-post','00000000-0000-4000-9873-000000000001','LOST','Wallet',
 'A blue wallet near the station','Other','OPEN',current_date,'PUBLISHED',now(),now());
insert into public.user_roles(user_id,role,granted_by,granted_at)
values('00000000-0000-4000-9873-000000000002','MODERATOR','00000000-0000-4000-9873-000000000002',now());
insert into public.user_role_capabilities(user_id,capability,granted_by,granted_at)
values('00000000-0000-4000-9873-000000000002','content_hide','00000000-0000-4000-9873-000000000002',now());
do $$ declare role_name text; signature text; begin
 foreach role_name in array array['anon','authenticated','service_role'] loop
  foreach signature in array array[
   'public.findback_order_report_lifecycle_write()',
   'public.findback_mark_recovered_declared_helper(text,text,text)',
   'public.findback_apply_moderation_before_lifecycle_order(text,text,text,text,text,text,text)'] loop
   if has_function_privilege(role_name,signature,'EXECUTE') then
    raise exception 'Private ordering delegate exposed to %: %',role_name,signature;
   end if;
  end loop;
 end loop;
 if (select prosecdef from pg_proc where oid='public.findback_update_post_client(text,text,text,text,text,text,double precision,double precision,text,text,text[])'::regprocedure) then
  raise exception 'Invoker report edit was promoted to a definer';
 end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9873-000000000001',true);
do $$ begin
 begin
  perform public.findback_apply_moderation('POST','m1entry-post','HIDE','OTHER','Unauthorized owner');
  raise exception 'Owner without staff capability moderated a post' using errcode='ZB001';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
 if (select moderation_visibility from public.item_posts where id='m1entry-post')<>'PUBLISHED'
    or exists(select 1 from public.admin_audit_log where target_id='m1entry-post') then
  raise exception 'Refused moderation leaked a write';
 end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9873-000000000002',true);
select public.findback_apply_moderation('POST','m1entry-post','HIDE','OTHER','Authorized moderator');
reset role;
do $$ begin
 if (select moderation_visibility from public.item_posts where id='m1entry-post')<>'HIDDEN'
    or (select count(*) from public.admin_audit_log where target_id='m1entry-post' and action='HIDE')<>1 then
  raise exception 'Authorized staff writer lost its visibility/audit contract';
 end if;
end $$;
-- D25 remains an owner-declared recovery, even for an owner's hidden report.
-- But neither the caller nor a named FindBack helper may be deleting.
insert into public.account_deletion_fences(user_id) values('00000000-0000-4000-9873-000000000003');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9873-000000000001',true);
do $$ begin
 begin
  perform public.findback_mark_recovered('m1entry-post',' findback_user ',' 00000000-0000-4000-9873-000000000003 ');
  raise exception 'Deleting helper obtained a new recovery' using errcode='ZB001';
 exception when no_data_found then
  if sqlerrm<>'Recovery unavailable' then raise; end if;
 end;
end $$;
reset role;
do $$ begin
 if exists(select 1 from public.successful_returns where lost_post_id='m1entry-post') then
  raise exception 'Refused recovery leaked a return';
 end if;
end $$;
set local role authenticated;
select public.findback_mark_recovered('m1entry-post','SELF_OR_PRIVATE');
reset role;
do $$ begin
 if (select status from public.item_posts where id='m1entry-post')<>'RECOVERED'
    or (select count(*) from public.successful_returns where lost_post_id='m1entry-post')<>1 then
  raise exception 'Valid owner-declared recovery was lost';
 end if;
end $$;
select 'PASS private delegates/invoker edits, staff authorization/audit, fenced helper and valid D25 recovery' as result;
rollback;
