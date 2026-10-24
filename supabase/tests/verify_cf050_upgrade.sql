-- Signature-upgrade regression only, NOT complete matching acceptance.
-- Run after --apply-chain using scripts/sql-behavior.mjs (one-row assertions).
-- Removing the transactional signature replacement must fail chain replay;
-- losing grants/owner checks or discarding partial consent must fail below.
begin;

select 'CFU1 the upgraded confirmation RPC returns its declared result' as probe
where (select prorettype from pg_proc
       where oid='public.findback_confirm_match(text)'::regprocedure)='text'::regtype
  and to_regclass('public.match_confirmations') is not null
  and to_regprocedure('public.findback_handover_match(text)') is not null;

select 'CFU2 replacement keeps only authenticated RPC execution and no table writes' as probe
where has_function_privilege('authenticated','public.findback_confirm_match(text)','execute')
  and not has_function_privilege('anon','public.findback_confirm_match(text)','execute')
  and not has_table_privilege('authenticated','public.match_confirmations','insert')
  and not has_table_privilege('authenticated','public.match_confirmations','update');

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9400-'||lpad(n::text,12,'0'), 'cf_upgrade_'||n,
  'cf_upgrade_'||n||'@example.invalid','+880194000000'||n,1,
  '2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'
from generate_series(1,3) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('cfu-lost','00000000-0000-4000-9400-000000000001','LOST','Keys','Synthetic keys','Other','OPEN','2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'),
  ('cfu-found','00000000-0000-4000-9400-000000000002','FOUND','Keys','Synthetic keys','Other','OPEN','2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.report_matches(id,lost_report_id,found_report_id,proposed_by)
values ('cfu-pending','cfu-lost','cfu-found','00000000-0000-4000-9400-000000000001');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000003',true);
do $$
begin
  perform public.findback_confirm_match('cfu-pending');
  raise exception 'CFU3 outsider confirmation unexpectedly succeeded' using errcode='XX000';
exception when insufficient_privilege then null;
end $$;
reset role;
select 'CFU3 outsider refusal changes no consent or report state' as probe
where not exists(select 1 from public.match_confirmations where match_id='cfu-pending')
  and (select status from public.report_matches where id='cfu-pending')='PENDING'
  and (select count(*) from public.item_posts where id in ('cfu-lost','cfu-found') and status='OPEN')=2;

set local role anon;
do $$
begin
  perform public.findback_confirm_match('cfu-pending');
  raise exception 'CFU4 anonymous execution unexpectedly succeeded' using errcode='XX000';
exception when insufficient_privilege then null;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000001',true);
select 'CFU5 first owner receives PARTIAL' as probe
where public.findback_confirm_match('cfu-pending')='PARTIAL';
select 'CFU6 a first-owner retry remains PARTIAL' as probe
where public.findback_confirm_match('cfu-pending')='PARTIAL';
reset role;
select 'CFU7 one distinct confirmation cannot change either report' as probe
where (select count(*) from public.match_confirmations where match_id='cfu-pending')=1
  and (select status from public.report_matches where id='cfu-pending')='PENDING'
  and (select count(*) from public.item_posts where id in ('cfu-lost','cfu-found') and status='OPEN')=2;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000002',true);
select 'CFU8 the second distinct owner receives MATCHED' as probe
where public.findback_confirm_match('cfu-pending')='MATCHED';
reset role;
select 'CFU9 consent and both MATCHED states persist together, not RECOVERED' as probe
where (select count(*) from public.match_confirmations where match_id='cfu-pending')=2
  and (select status from public.report_matches where id='cfu-pending')='CONFIRMED'
  and (select count(*) from public.item_posts where id in ('cfu-lost','cfu-found') and status='MATCHED')=2;

rollback;
