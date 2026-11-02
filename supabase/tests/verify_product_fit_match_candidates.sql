-- Disposable actual-chain behavior test. Never run fixture DML against hosted.
-- The test-only selector allows the same recall assertion to expose the old
-- newest20 bug before v2 exists; production NEVER falls back to that old RPC.
begin;
create function pg_temp.fit_candidates(p_target text, p_limit integer default 80)
returns table(id text, category text, total_count bigint)
language plpgsql security invoker as $$
begin
  return query execute format('select id, category, total_count from public.%I($1,$2)',
    case when to_regprocedure('public.findback_match_candidates_v2(text,integer)') is not null
    then 'findback_match_candidates_v2' else 'findback_match_candidates_client' end)
    using p_target, p_limit;
end $$;

insert into public.users(id,username,email,phone,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000f101','fit_reader','reader@fit.invalid','+1555000f101','2020-01-01','2020-01-01'),
 ('00000000-0000-4000-8000-00000000f102','fit_partner','partner@fit.invalid','+1555000f102','2020-01-01','2020-01-01'),
 ('00000000-0000-4000-8000-00000000f103','fit_blocked','blocked@fit.invalid','+1555000f103','2020-01-01','2020-01-01');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,latitude,longitude,created_at,updated_at) values
 ('fit-target','00000000-0000-4000-8000-00000000f101','LOST','black umbrella','wooden handle','Clothing','OPEN','2020-01-01',23.81,90.41,'2020-01-01','2020-01-01'),
 ('fit-older','00000000-0000-4000-8000-00000000f102','FOUND','black umbrella','wooden handle','Clothing','OPEN','2020-01-01',23.81,90.41,'2020-01-02','2020-01-02'),
 ('fit-no-location','00000000-0000-4000-8000-00000000f102','FOUND','black umbrella','wooden handle','Clothing','OPEN','2020-01-01',null,null,'2020-01-02','2020-01-02'),
 ('fit-long-loss','00000000-0000-4000-8000-00000000f102','FOUND','black umbrella','wooden handle','Clothing','OPEN','2022-01-01',null,null,'2022-01-01','2022-01-01'),
 ('fit-category-only','00000000-0000-4000-8000-00000000f102','FOUND','scarlet coat','wool scarf','Clothing','OPEN','',null,null,'2020-01-01','2020-01-01'),
 ('fit-same-type','00000000-0000-4000-8000-00000000f102','LOST','black umbrella','wooden handle','Clothing','OPEN','2020-01-01',23.81,90.41,'2026-10-31','2026-10-31'),
 ('fit-closed','00000000-0000-4000-8000-00000000f102','FOUND','black umbrella','wooden handle','Clothing','CLOSED','2020-01-01',23.81,90.41,'2026-10-31','2026-10-31'),
 ('fit-own','00000000-0000-4000-8000-00000000f101','FOUND','black umbrella','wooden handle','Clothing','OPEN','2020-01-01',23.81,90.41,'2026-10-31','2026-10-31');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
select 'fit-noise-'||lpad(i::text,4,'0'),'00000000-0000-4000-8000-00000000f102',
 'FOUND','gym membership card','laminated paper','Documents & IDs','OPEN','','2026-10-31','2026-10-31'
from generate_series(1,1000) i;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f101',true);
select 'R0 historical newest20 loses the old correct report behind1000 unrelated newer ones' as probe
where not exists(select 1 from public.findback_match_candidates_client('fit-target',20) where id='fit-older');
select 'R1 relevance BEFORE cap keeps older correct match first' as probe
where (select id from pg_temp.fit_candidates('fit-target',1))='fit-older';
select 'R2 missing location and long-running loss stay in plausible pool; category beats irrelevant recency' as probe
where (select count(*) from pg_temp.fit_candidates('fit-target',4)
 where id in ('fit-older','fit-no-location','fit-long-loss','fit-category-only'))=4;
select 'R3 bounded80 pool and exact1004 eligible total before cap' as probe
where (select count(*)=80 and min(total_count)=1004 and max(total_count)=1004
 from pg_temp.fit_candidates('fit-target',999))
and (select count(*) from pg_temp.fit_candidates('fit-target',null))=80
and (select count(*) from pg_temp.fit_candidates('fit-target',0))=1
and (select count(*) from pg_temp.fit_candidates('fit-target',-1))=1;

-- Synthetic cost evidence only, NOT a hosted latency/corpus acceptance claim.
explain (analyze,buffers) select count(*) from public.findback_match_candidates_v2('fit-target',80);
reset role;
savepoint boundary_pool;
delete from public.item_posts where id like 'fit-noise-%' and id>'fit-noise-0076';
set local role authenticated;
select 'R3a exactly80 candidates are retained' as probe where
 (select count(*)=80 and min(total_count)=80 from pg_temp.fit_candidates('fit-target',80));
explain (analyze,buffers) select count(*) from public.findback_match_candidates_v2('fit-target',80);
reset role;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values('fit-noise-0077','00000000-0000-4000-8000-00000000f102','FOUND','gym card','paper','Documents & IDs','OPEN','','2026-10-31','2026-10-31');
set local role authenticated;
select 'R3b eighty-first row is bounded after scoring, count remains81' as probe where
 (select count(*)=80 and min(total_count)=81 from pg_temp.fit_candidates('fit-target',80));
explain (analyze,buffers) select count(*) from public.findback_match_candidates_v2('fit-target',80);
reset role;
rollback to boundary_pool;

reset role;
-- Isolate each signal with equal categories/text/created times; a score mutation
-- dropping geo/date/text must fail an ordering assertion, not just a token grep.
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,latitude,longitude,created_at,updated_at) values
 ('fit-geo-target','00000000-0000-4000-8000-00000000f101','LOST','geo marker','test','Pets & Animals','OPEN','',23.81,90.41,'2020-01-01','2020-01-01'),
 ('fit-geo-a-far','00000000-0000-4000-8000-00000000f102','FOUND','geo marker','test','Pets & Animals','OPEN','',-20,-40,'2020-01-01','2020-01-01'),
 ('fit-geo-z-near','00000000-0000-4000-8000-00000000f102','FOUND','geo marker','test','Pets & Animals','OPEN','',23.81,90.41,'2020-01-01','2020-01-01'),
 ('fit-date-target','00000000-0000-4000-8000-00000000f101','LOST','date marker','test','Keys','OPEN','2020-01-01',null,null,'2020-01-01','2020-01-01'),
 ('fit-date-a-far','00000000-0000-4000-8000-00000000f102','FOUND','date marker','test','Keys','OPEN','2025-01-01',null,null,'2020-01-01','2020-01-01'),
 ('fit-date-z-near','00000000-0000-4000-8000-00000000f102','FOUND','date marker','test','Keys','OPEN','2020-01-01',null,null,'2020-01-01','2020-01-01'),
 ('fit-text-target','00000000-0000-4000-8000-00000000f101','LOST','violet thermos','dented steel','Other','OPEN','',null,null,'2020-01-01','2020-01-01'),
 ('fit-text-z-similar','00000000-0000-4000-8000-00000000f102','FOUND','violet thermos','dented steel','Other','OPEN','',null,null,'2020-01-01','2020-01-01'),
 ('fit-text-a-different','00000000-0000-4000-8000-00000000f102','FOUND','canvas bag','silver zip','Other','OPEN','',null,null,'2020-01-01','2020-01-01');
set local role authenticated;
select 'R4 nearby bonus before cap' as probe where
 (select id from pg_temp.fit_candidates('fit-geo-target',1))='fit-geo-z-near';
select 'R5 event date before cap' as probe where
 (select id from pg_temp.fit_candidates('fit-date-target',1))='fit-date-z-near';
select 'R6 textual relevance before cap' as probe where
 (select id from pg_temp.fit_candidates('fit-text-target',1))='fit-text-z-similar';

reset role;
-- Invalid calendar dates/legacy prose must not crash or acquire a date bonus.
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at) values
 ('fit-invalid-target','00000000-0000-4000-8000-00000000f101','LOST','saffron watch','tiny dial','Electronics','OPEN','2020-02-29','2020-01-01','2020-01-01'),
 ('fit-invalid-a','00000000-0000-4000-8000-00000000f102','FOUND','saffron watch','tiny dial','Electronics','OPEN','2020-02-31','not-a-date','2020-01-01'),
 ('fit-valid-z','00000000-0000-4000-8000-00000000f102','FOUND','saffron watch','tiny dial','Electronics','OPEN','2020-02-29','2020-01-01','2020-01-01'),
 ('fit-third-lost','00000000-0000-4000-8000-00000000f103','LOST','violet thermos','dented steel','Other','OPEN','legacy prose','2020-01-01','2020-01-01');
set local role authenticated;
select 'R6a malformed date does not throw or outrank exact leap-day date' as probe where
 (select id from pg_temp.fit_candidates('fit-invalid-target',1))='fit-valid-z'
 and exists(select 1 from pg_temp.fit_candidates('fit-invalid-target',80) where id='fit-invalid-a');
select 'R6b target author and viewer own reports excluded before cap' as probe where
 (select array_agg(id) from pg_temp.fit_candidates('fit-text-z-similar',80))=array['fit-third-lost'];
reset role;
update public.item_posts set event_date='not-a-date' where id='fit-invalid-target';
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,location_label,created_at,updated_at) values
 ('fit-unicode-target','00000000-0000-4000-8000-00000000f101','LOST','নীল ছাতা','কাঠের হাতল','Other','OPEN','','ঢাকা','2020-01-01','2020-01-01'),
 ('fit-unicode-z','00000000-0000-4000-8000-00000000f102','FOUND','নীল ছাতা','কাঠের হাতল','Other','OPEN','','ঢাকা','2020-01-01','2020-01-01'),
 ('fit-unicode-a','00000000-0000-4000-8000-00000000f102','FOUND','different object','unrelated','Other','OPEN','','Paris','2020-01-01','2020-01-01'),
 ('fit-locality-target','00000000-0000-4000-8000-00000000f101','LOST','marker','same','Bags','OPEN','','DhAnMoNdI DHAKA','2020-01-01','2020-01-01'),
 ('fit-locality-z','00000000-0000-4000-8000-00000000f102','FOUND','marker','same','Bags','OPEN','','dhanmondi, dhaka','2020-01-01','2020-01-01'),
 ('fit-locality-a','00000000-0000-4000-8000-00000000f102','FOUND','marker','same','Bags','OPEN','','Paris','2020-01-01','2020-01-01');
set local role authenticated;
select 'R6c invalid target date still yields candidates' as probe where
 (select count(*) from pg_temp.fit_candidates('fit-invalid-target',80))>=2;
select 'R6d Unicode wording survives without English stemming' as probe where
 (select id from pg_temp.fit_candidates('fit-unicode-target',1))='fit-unicode-z';
select 'R6e normalized textual locality helps absent coordinates' as probe where
 (select id from pg_temp.fit_candidates('fit-locality-target',1))='fit-locality-z';
reset role;
insert into public.attachments(id,post_id,file_url,mime_type,file_name,file_size,created_at,display_order,width,height) values
 ('fit-photo','fit-older','https://example.invalid/fit.jpg','image/jpeg','fit.jpg',10,'2020-01-01',1,400,300);
insert into public.reactions(id,post_id,user_id,type,created_at) values
 ('fit-love','fit-older','00000000-0000-4000-8000-00000000f101','LOVE','2020-01-01');
set local role authenticated;
select 'R6f projection actually carries media, author and own reaction' as probe where exists
 (select 1 from public.findback_match_candidates_v2('fit-target',1)
 where id='fit-older' and author_username='fit_partner' and my_reaction='LOVE'
 and reaction_counts='{"LOVE":1}'::jsonb and reaction_total=1
 and attachments->0->>'id'='fit-photo' and (attachments->0->>'width')::integer=400);
reset role;
savepoint tied_reports;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,location_label,created_at,updated_at)
select 'fit-tied-'||s,user_id,type,title,description,category,status,event_date,location_label,created_at,updated_at
from public.item_posts cross join unnest(array['a','z']) s where id='fit-locality-z';
set local role authenticated;
select 'R6g deterministic descending ID tie-break' as probe where
 (select id from pg_temp.fit_candidates('fit-locality-target',1))='fit-tied-z';
reset role;
rollback to tied_reports;

insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values('fit-restricted','00000000-0000-4000-8000-00000000f103','FOUND','black umbrella','wooden handle','Clothing','OPEN','2020-01-01','2026-10-31','2026-10-31');
insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at)
values('00000000-0000-4000-8000-00000000f101','00000000-0000-4000-8000-00000000f103','2020-01-01');
set local role authenticated;
select 'R7 block exclusion before cap' as probe where not exists
 (select 1 from pg_temp.fit_candidates('fit-target',80) where id='fit-restricted');
select 'R8 blocked target cannot be queried' as probe where not exists
 (select 1 from pg_temp.fit_candidates('fit-restricted',80));
reset role;
delete from public.user_blocks where blocker_user_id='00000000-0000-4000-8000-00000000f101';
insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at)
values('00000000-0000-4000-8000-00000000f103','00000000-0000-4000-8000-00000000f101','2020-01-01');
set local role authenticated;
select 'R9 reverse block also excludes' as probe where not exists
 (select 1 from pg_temp.fit_candidates('fit-target',80) where id='fit-restricted');
reset role;
update public.item_posts set moderation_visibility='HIDDEN' where id='fit-older';
set local role authenticated;
select 'R10 hidden candidate AND hidden other target stay absent' as probe where
 not exists(select 1 from pg_temp.fit_candidates('fit-target',80) where id='fit-older')
 and not exists(select 1 from pg_temp.fit_candidates('fit-older',80));
select 'R11 closed/missing target returns nothing' as probe where
 not exists(select 1 from pg_temp.fit_candidates('fit-closed',80))
 and not exists(select 1 from pg_temp.fit_candidates('fit-missing',80));
reset role;
delete from public.item_posts where id='fit-no-location';
set local role authenticated;
select 'R11a deleted candidate cannot return' as probe where
 not exists(select 1 from pg_temp.fit_candidates('fit-target',80) where id='fit-no-location');
select set_config('request.jwt.claim.sub','',true);
select 'R12 no subject returns nothing' as probe where not exists
 (select 1 from pg_temp.fit_candidates('fit-target',80));
reset role;

select 'R13 versioned stable definer, authenticated only, pinned path and both visibility arms' as probe
where exists(select 1 from pg_proc where oid=to_regprocedure('public.findback_match_candidates_v2(text,integer)')
 and prosecdef and provolatile='s' and proconfig @> array['search_path=public, pg_temp']
 and pg_get_functiondef(oid) ~ 'findback_can_read_post\(t.id\)'
 and pg_get_functiondef(oid) ~ 'findback_can_read_post\(c.id\)')
and has_function_privilege('authenticated','public.findback_match_candidates_v2(text,integer)','EXECUTE')
and not has_function_privilege('anon','public.findback_match_candidates_v2(text,integer)','EXECUTE')
and not exists(select 1 from pg_proc p,lateral aclexplode(p.proacl) a
 where p.oid=to_regprocedure('public.findback_match_candidates_v2(text,integer)')
 and a.grantee=0 and a.privilege_type='EXECUTE');
select 'R14 mapper OUT columns unchanged, no block signal projected' as probe where
 (select array_agg(p.proargnames[i]||':'||p.proallargtypes[i]::regtype::text order by i)
 from pg_proc p,lateral generate_subscripts(p.proallargtypes,1) i
 where p.oid='public.findback_match_candidates_v2(text,integer)'::regprocedure and p.proargmodes[i]='t')=
 (select array_agg(p.proargnames[i]||':'||p.proallargtypes[i]::regtype::text order by i)
 from pg_proc p,lateral generate_subscripts(p.proallargtypes,1) i
 where p.oid='public.findback_match_candidates_client(text,integer)'::regprocedure and p.proargmodes[i]='t');
rollback;
