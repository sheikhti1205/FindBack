-- Match-candidate verifier. NOT been applied hosted; never claim hosted PASS
-- from this file's presence. Static guards are text checks, not engine proof.
-- Section 1 is read-only; section 2 is DISPOSABLE LOCAL PostgreSQL ONLY and
-- rolls back all fixtures. Authenticated reads use the real roles and RLS;
-- fixture/block/moderation setup is privileged, never an unauthorized client DML.
-- Hosted-only readback is in readback_20261022160000_match_candidates_hosted.sql.

-- 1. Catalog: exact singleton signature, posture, ACL and OUT columns.
select 'P1 singleton signature, invoker, stable, locked path' as probe
where (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='findback_match_candidates_client') = 1
and exists(select 1 from pg_proc p
 where p.oid=to_regprocedure('public.findback_match_candidates_client(text,integer)')
 and pg_get_function_identity_arguments(p.oid)='p_target_id text, p_limit integer'
 and p.pronargdefaults=1 and not p.prosecdef and p.provolatile='s'
 and p.proconfig @> array['search_path=public, pg_temp']);

select 'P2 authenticated-only ACL' as probe
where has_function_privilege('authenticated','public.findback_match_candidates_client(text,integer)','EXECUTE')
and not has_function_privilege('anon','public.findback_match_candidates_client(text,integer)','EXECUTE')
and not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 where p.oid=to_regprocedure('public.findback_match_candidates_client(text,integer)')
 and a.grantee=0 and a.privilege_type='EXECUTE');

-- pg_attribute describes RELATIONS, not functions. Compare pg_proc OUT names
-- AND types, preserving ordinality; do not let a missing function pass vacuously.
select 'P3-P4 feed shape minus exactly blocked_author, same types/order' as probe
where (
 select array_agg(p.proargnames[s.i] || ':' || p.proallargtypes[s.i]::regtype::text order by s.i)
 from pg_proc p, lateral generate_subscripts(p.proallargtypes,1) s(i)
 where p.oid=to_regprocedure('public.findback_match_candidates_client(text,integer)') and p.proargmodes[s.i]='t'
) = (
 select array_agg(p.proargnames[s.i] || ':' || p.proallargtypes[s.i]::regtype::text order by s.i)
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
 lateral generate_subscripts(p.proallargtypes,1) s(i)
 where n.nspname='public' and p.proname='findback_query_posts_client' and p.proargmodes[s.i]='t'
 and p.proargnames[s.i]<>'blocked_author'
)
and pg_get_function_result('public.findback_match_candidates_client(text,integer)'::regprocedure) not like '%blocked_author%'
and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='findback_query_posts_client'
 and pg_get_function_result(p.oid) like '%blocked_author boolean%');

-- 2. DISPOSABLE LOCAL behavior assertions. Fifty opposite-type OPEN reports:
-- twenty-five newer blocked-author rows and twenty-five older unblocked rows.
-- Exact counts prove filtering precedes LIMIT and total_count precedes LIMIT.
begin;
insert into public.users(id,username,email,phone,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000d501','cand_reader','reader@example.invalid','+1555000d501','2020-01-01','2020-01-01'),
 ('00000000-0000-4000-8000-00000000d502','cand_partner','partner@example.invalid','+1555000d502','2020-01-01','2020-01-01'),
 ('00000000-0000-4000-8000-00000000d503','cand_stranger','stranger@example.invalid','+1555000d503','2020-01-01','2020-01-01');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at) values
 ('cand-target','00000000-0000-4000-8000-00000000d501','LOST','Lost wallet','A brown wallet','Electronics','OPEN','2020-01-01','2020-01-01','2020-01-01'),
 ('cand-own-found','00000000-0000-4000-8000-00000000d501','FOUND','Own found wallet','My found wallet','Electronics','OPEN','2020-01-01','2020-01-01','2020-01-01'),
 ('cand-closed','00000000-0000-4000-8000-00000000d503','FOUND','Closed wallet','No longer open','Electronics','CLOSED','2020-01-01','2020-01-01','2020-01-01'),
 ('cand-same-type','00000000-0000-4000-8000-00000000d503','LOST','Other lost wallet','A lost wallet','Electronics','OPEN','2020-01-01','2020-01-01','2020-01-01');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
select id, uid, 'FOUND', 'Title '||id, 'Description '||id, 'Electronics','OPEN','2020-01-01',created,'2020-01-01'
from (
 select 'cand-blocked-'||lpad(i::text,2,'0') id, '00000000-0000-4000-8000-00000000d502' uid, '2020-01-03' created from generate_series(1,25) i
 union all
 select 'cand-open-'||lpad(i::text,2,'0'), '00000000-0000-4000-8000-00000000d503', '2020-01-02' from generate_series(1,25) i
) fixtures;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d501',true);
select 'B1 no block: fifty eligible, capped at twenty, newest first' as probe
where (select count(*)=20 and min(total_count)=50 and max(total_count)=50
       and bool_and(id like 'cand-blocked-%') from public.findback_match_candidates_client('cand-target',20));

-- Privileged fixture setup; client RPCs remain authenticated invokers.
reset role;
insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at)
values('00000000-0000-4000-8000-00000000d501','00000000-0000-4000-8000-00000000d502','2020-01-01');
set local role authenticated;
select 'B2 block exclusion BEFORE limit, no own/same/closed rows, truthful total' as probe
where (select count(*)=20 and min(total_count)=25 and max(total_count)=25
       and bool_and(id like 'cand-open-%' and type='FOUND' and status='OPEN'
                    and user_id='00000000-0000-4000-8000-00000000d503')
       from public.findback_match_candidates_client('cand-target',20));

select 'B3 exact clamp and default' as probe
where (select count(*) from public.findback_match_candidates_client('cand-target',null))=20
and (select count(*) from public.findback_match_candidates_client('cand-target',0))=1
and (select count(*) from public.findback_match_candidates_client('cand-target',-5))=1
and (select count(*) from public.findback_match_candidates_client('cand-target',999))=20
and (select count(*) from public.findback_match_candidates_client('cand-target'))=20;

select 'B4 descending id tiebreak, non-swapped text, aggregate shapes' as probe
where (select id from public.findback_match_candidates_client('cand-target',1))='cand-open-25'
and (select bool_and(title='Title '||id and description='Description '||id
      and jsonb_typeof(attachments)='array' and jsonb_typeof(reaction_counts)='object'
      and like_count=0 and dislike_count=0 and rating_count=0 and comment_count=0
      and reaction_total=0 and my_reaction is null)
     from public.findback_match_candidates_client('cand-target',20));

select 'B5 opposite type follows FOUND target; nonexistent target is empty' as probe
where (select array_agg(id) from public.findback_match_candidates_client('cand-open-01',20))=array['cand-same-type']
and (select count(*) from public.findback_match_candidates_client('cand-missing',20))=0;

-- Legacy DISLIKE rows remain readable even though current consumer writes
-- no longer offer that action. Nonzero fixtures catch a misspelled aggregate.
reset role;
insert into public.reactions(id,post_id,user_id,type,created_at)
values('cand-legacy-dislike','cand-open-25','00000000-0000-4000-8000-00000000d501','DISLIKE','2020-01-01');
set local role authenticated;
select 'B10 legacy DISLIKE count, reaction aggregate and own reaction remain readable' as probe
where (select dislike_count=1 and reaction_total=1
       and reaction_counts->>'DISLIKE'='1' and my_reaction='DISLIKE'
       from public.findback_match_candidates_client('cand-target',1));

-- Reverse-direction block is the same exclusion; direction is not exposed.
reset role;
delete from public.user_blocks where blocker_user_id='00000000-0000-4000-8000-00000000d501';
insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at)
values('00000000-0000-4000-8000-00000000d502','00000000-0000-4000-8000-00000000d501','2020-01-01');
set local role authenticated;
select 'B6 reverse-direction block excludes the same author' as probe
where (select count(*)=20 and min(total_count)=25 and bool_and(id like 'cand-open-%')
 from public.findback_match_candidates_client('cand-target',20));

reset role;
update public.item_posts set moderation_visibility='HIDDEN' where id in ('cand-open-01','cand-target');
set local role authenticated;
select 'B7 other hidden target empty; own hidden target follows canonical owner visibility' as probe
where (select count(*) from public.findback_match_candidates_client('cand-open-01',20))=0
and (select count(*)=20 and min(total_count)=24 from public.findback_match_candidates_client('cand-target',20));

select set_config('request.jwt.claim.sub','',true);
select 'B8 NULL subject receives zero rows' as probe
where (select count(*) from public.findback_match_candidates_client('cand-target',20))=0;
set local role anon;
do $$ begin
  begin
    perform public.findback_match_candidates_client('cand-target',20);
    raise exception 'B9 anonymous EXECUTE was allowed';
  exception when sqlstate '42501' then null; end;
end $$;
reset role;
select 'B9 anonymous EXECUTE refused' as probe;
rollback;
