-- Synthetic disposable full-chain fixture ONLY. Count/projection/ACL probes.
begin;
select 'P0 preview RPC exists' as probe where to_regprocedure('public.findback_shared_report_preview(text)') is not null;
insert into public.users(id,username,email,phone,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000f601','preview_owner','owner@preview.invalid','+1555000f601','2020-01-01','2020-01-01'),
 ('00000000-0000-4000-8000-00000000f602','preview_other','other@preview.invalid','+1555000f602','2020-01-01','2020-01-01');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,latitude,longitude,location_label,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000f611','00000000-0000-4000-8000-00000000f601','FOUND','Black backpack call +15551234567 meet 22 Secret Lane','email private@secret.invalid; exact meetup at my home','Bags & Wallets','OPEN','2026-11-01',23.811233,90.412255,'22 Secret Lane','2020-01-01','2020-01-01');
set local role anon;
select 'P1 anonymous bounded safe public item/color/category/month, not free text' as probe where
 (select count(*)=1 and min(title)='Black backpack' and min(category)='Bags & Wallets' and min(event_month)='2026-11'
 from public.findback_shared_report_preview('00000000-0000-4000-8000-00000000f611'));
select 'P2 only six public fields; no original title/description/location/contact/user/media' as probe where
 (select array_agg(k order by k)=array['category','event_month','excerpt','id','title','type']::text[]
 from public.findback_shared_report_preview('00000000-0000-4000-8000-00000000f611') p cross join lateral jsonb_object_keys(to_jsonb(p)) k)
 and not exists(select 1 from public.findback_shared_report_preview('00000000-0000-4000-8000-00000000f611') p
 where to_jsonb(p)::text ~ '(15551234567|Secret|secret.invalid|23.811233|90.412255|f601)');
select 'P3 absent/invalid same empty result' as probe where
 not exists(select 1 from public.findback_shared_report_preview('missing'))
 and not exists(select 1 from public.findback_shared_report_preview(null));
reset role;
select 'P4 no anonymous table/view grants; public execute removed; owner RPC not anon' as probe where
 not has_column_privilege('anon','public.item_posts','title','SELECT')
 and not has_function_privilege('anon','public.findback_report_sharing(text,boolean)','EXECUTE')
 and has_function_privilege('anon','public.findback_shared_report_preview(text)','EXECUTE');
select 'P4a authenticated cannot bypass owner RPC via the new private column' as probe where
 not has_column_privilege('authenticated','public.item_posts','public_share_enabled','SELECT')
 and not has_column_privilege('authenticated','public.item_posts','public_share_enabled','UPDATE')
 and not has_column_privilege('authenticated','public.item_posts','public_share_enabled','INSERT')
 and has_column_privilege('authenticated','public.item_posts','title','INSERT')
 and has_column_privilege('authenticated','public.item_posts','event_date','INSERT');
update public.item_posts set moderation_visibility='HIDDEN' where id='00000000-0000-4000-8000-00000000f611';
set local role anon;
select 'P5 hidden report is unavailable even to anonymous preview' as probe where
 not exists(select 1 from public.findback_shared_report_preview('00000000-0000-4000-8000-00000000f611'));
reset role;
update public.item_posts set moderation_visibility='PUBLISHED' where id='00000000-0000-4000-8000-00000000f611';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f601',true);
select 'P6 owner revokes sharing and can read revoked preference' as probe where
 public.findback_report_sharing('00000000-0000-4000-8000-00000000f611',false)=false
 and public.findback_report_sharing('00000000-0000-4000-8000-00000000f611',null)=false;
reset role;
set local role anon;
select 'P7 revoked report is unavailable on fresh requests' as probe where
 not exists(select 1 from public.findback_shared_report_preview('00000000-0000-4000-8000-00000000f611'));
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f602',true);
do $$begin
 perform public.findback_report_sharing('00000000-0000-4000-8000-00000000f611',null);
 raise exception 'non-owner read sharing';
 exception when insufficient_privilege then null; end$$;
do $$begin
 perform public.findback_report_sharing('00000000-0000-4000-8000-00000000f611',true);
 raise exception 'non-owner changed sharing';
 exception when insufficient_privilege then null; end$$;
select 'P8 ordinary non-owner cannot read or change owner preference' as probe where true;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f601',true);
select 'P9 owner re-enable' as probe where public.findback_report_sharing('00000000-0000-4000-8000-00000000f611',true);
reset role;
-- Canonical block policy keeps PUBLISHED content visible, never reveals block rows.
insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at) values
 ('00000000-0000-4000-8000-00000000f602','00000000-0000-4000-8000-00000000f601','2026-11-01');
set local role anon;
select 'P10 anonymous block-independent public projection remains minimal' as probe where
 (select count(*)=1 from public.findback_shared_report_preview('00000000-0000-4000-8000-00000000f611'));
reset role;
-- Free-form and non-Latin contacts, exact address/metadata never copied.
update public.item_posts set title='পাসপোর্ট ০১৭১২৩৪৫৬৭৮ private@secret.invalid',category='Documents & IDs',event_date='bad date'
 where id='00000000-0000-4000-8000-00000000f611';
set local role anon;
select 'P11 unknown wording uses safe category, malformed date omitted' as probe where
 (select title='Documents & IDs' and event_month is null
 from public.findback_shared_report_preview('00000000-0000-4000-8000-00000000f611'));
reset role;
delete from public.item_posts where id='00000000-0000-4000-8000-00000000f611';
set local role anon;
select 'P12 deletion makes projection unavailable' as probe where
 not exists(select 1 from public.findback_shared_report_preview('00000000-0000-4000-8000-00000000f611'));
reset role;
rollback;
