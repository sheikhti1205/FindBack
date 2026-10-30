-- Raw tied-time pages and bounded scheduled work, without UI filtering as oracle.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9700-000000000001','m3pagingadmin','m3pagingadmin@example.invalid','+8801970000001',1,'2026-10-29T00:00:00Z','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9700-000000000002','m3pagingperson','m3pagingperson@example.invalid','+8801970000002',1,'2026-10-29T00:00:00Z','2026-10-29T00:00:00Z');
insert into public.user_roles(user_id,role,granted_at) values
 ('00000000-0000-4000-9700-000000000001','ADMIN','2026-10-29T00:00:00Z');
insert into public.account_sanctions(id,user_id,kind,starts_at,reason_code,active,created_at)
select 'm3-page-sanction-'||lpad(n::text,3,'0'),'00000000-0000-4000-9700-000000000002','WARNING','2026-10-29T00:00:00Z','OTHER',false,'2026-10-29T00:00:00Z' from generate_series(1,105)n;
insert into public.appeals(id,appellant_user_id,subject_kind,subject_id,sanction_id,message,submitted_at,expires_at)
select 'm3-page-appeal-'||lpad(n::text,3,'0'),'00000000-0000-4000-9700-000000000002','SANCTION',
 'm3-page-sanction-'||lpad(n::text,3,'0'),'m3-page-sanction-'||lpad(n::text,3,'0'),'Synthetic bounded expiry fixture','2026-10-29T00:00:00Z',clock_timestamp()-interval '1 day' from generate_series(1,105)n;
insert into public.feedback(id,user_id,category,message,status,created_at,updated_at)
select 'm3-page-feedback-'||lpad(n::text,3,'0'),'00000000-0000-4000-9700-000000000002','OTHER','Synthetic page fixture','NEW','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z' from generate_series(1,105)n;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$ declare p jsonb;q jsonb;c jsonb; begin
 p:=public.findback_staff_appeals(null,500);c:=p->'next_cursor';
 q:=public.findback_staff_appeals(null,100,c->>'submitted_at',c->>'id');
 if jsonb_array_length(p->'items')<>100 or jsonb_array_length(q->'items')<>5 or q->'next_cursor'<>'null'::jsonb
  or p->'items'->99->>'id'<>'m3-page-appeal-006' or q->'items'->0->>'id'<>'m3-page-appeal-005' then
  raise exception 'M3 PAGING FAILED: appeal tied-time raw keyset'; end if;
 p:=public.findback_staff_feedback(null,500);c:=p->'next_cursor';
 q:=public.findback_staff_feedback(null,100,c->>'created_at',c->>'id');
 if jsonb_array_length(p->'items')<>100 or jsonb_array_length(q->'items')<>5 or q->'next_cursor'<>'null'::jsonb
  or p->'items'->99->>'id'<>'m3-page-feedback-006' or q->'items'->0->>'id'<>'m3-page-feedback-005' then
  raise exception 'M3 PAGING FAILED: feedback tied-time raw keyset'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
 if public.findback_expire_stale_appeals()<>100 then raise exception 'M3 PAGING FAILED: expiry must bound one run to100'; end if;
 if public.findback_expire_stale_appeals()<>5 then raise exception 'M3 PAGING FAILED: next expiry run drains remaining5'; end if;
 if public.findback_expire_stale_appeals()<>0 then raise exception 'M3 PAGING FAILED: expiry retry duplicates work'; end if;
 if (select count(*) from public.notifications where type='MODERATION' and user_id='00000000-0000-4000-9700-000000000002')<>105 then
  raise exception 'M3 PAGING FAILED: expiry notification events lost or duplicated'; end if;
end $$;
select 'M3 bounded staff pages and scheduled expiry batches verified' as probe;
rollback;
