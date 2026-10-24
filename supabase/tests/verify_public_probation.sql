-- Owner amendment 2026-10-24: public-only probation, 30 days, exactly 30 s
-- spacing across covered PUBLIC interactions. Local PG17 roles/time only.
-- Run with scripts/sql-behavior.mjs; every SELECT probe returns exactly one row.
-- A must-fail probe catches its own refusal inside a DO block.
begin;

insert into public.users (id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9200-'||lpad(n::text,12,'0'), 'probation_'||n,
       'probation_'||n||'@example.invalid', '+880192000000'||n, 1,
       '2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'
from generate_series(1,6) n;
insert into public.user_roles (user_id,role,granted_at)
values ('00000000-0000-4000-9200-000000000006','ADMIN','2026-10-24T00:00:00.000Z');
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('pb-target','00000000-0000-4000-9200-000000000006','LOST','Probation target','Description','Electronics','OPEN','2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.comments (id,post_id,user_id,body,created_at,updated_at)
values ('pb-target-comment','pb-target','00000000-0000-4000-9200-000000000006','Target comment','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');

-- ---------------------------------------------------------------------------
-- P1. The admission ledger is server-owned: RLS on, no client grant at all,
--     and the internal writers are not client-executable.
-- ---------------------------------------------------------------------------
select 'PB1 the admission ledger is protected rate-limit state' as probe
where exists (
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='public_action_admissions' and c.relrowsecurity
)
and not exists (
  select 1 from information_schema.role_table_grants g
  where g.table_schema='public' and g.table_name='public_action_admissions'
    and g.grantee in ('anon','authenticated','PUBLIC')
)
and not exists (
  select 1 from information_schema.column_privileges g
  where g.table_schema='public' and g.table_name='public_action_admissions'
    and g.grantee in ('anon','authenticated','PUBLIC')
)
and not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname in ('findback_public_admission_check','findback_public_admission_spend','findback_post_limit_for')
    and (has_function_privilege('authenticated',p.oid,'execute')
      or has_function_privilege('anon',p.oid,'execute'))
);

-- P2. The self-admission seam exists for the invoker writers and can only
--     charge the caller: it reads auth.uid() and takes no user parameter.
select 'PB2 the invoker seam derives its own actor' as probe
where exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='findback_admit_public_action'
    and p.pronargs=1
    and has_function_privilege('authenticated',p.oid,'execute')
)
and exists (
  select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where not t.tgisinternal and c.relname in ('item_posts','comments')
    and t.tgname in ('trg_findback_item_posts_public_admission','trg_findback_comments_public_admission')
);

-- P3. Writer-applied PROBATION gets the server's 30-day default, and the audit
--     records the SAME persisted instant (no silent trigger rewrite).
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000006',true);
select public.findback_apply_moderation(
  'USER','00000000-0000-4000-9200-000000000002','PROBATION','SPAM_OR_DUPLICATE',null) as probation_audit;
reset role;
select 'PB3 the default probation expiry is 30 days and audited exactly' as probe
where (
  select nullif(btrim(s.ends_at),'')::timestamptz
    from public.account_sanctions s
   where s.user_id='00000000-0000-4000-9200-000000000002' and s.kind='PROBATION'
) between clock_timestamp() + interval '29 days 23 hours' and clock_timestamp() + interval '30 days 1 hour'
and (
  select a.new_state->>'ends_at' from public.admin_audit_log a
   where a.target_id='00000000-0000-4000-9200-000000000002' and a.action='PROBATION'
) = (
  select s.ends_at from public.account_sanctions s
   where s.user_id='00000000-0000-4000-9200-000000000002' and s.kind='PROBATION'
);

-- P4. Probation keeps the tier daily ceiling (NEW = 3) but replaces the old
--     1/day + 120 s hardship with exactly 30 s spacing.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
select 'PB4 probation limit is the baseline daily cap plus 30 s spacing' as probe
where (select l.limit_per_day from public.findback_post_limit() l)=3
  and (select l.burst_cooldown_seconds from public.findback_post_limit() l)=30
  and public.findback_standing()='PROBATION';

-- P5. First public write lands and spends exactly one admission.
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('pb-u2-post-1','00000000-0000-4000-9200-000000000002','LOST','study keys','desc','Other','OPEN','2026-10-24',
        to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
reset role;
select 'PB5 a first public write is admitted once' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002' and action_kind='POST')=1;

-- P6. The very next public write is refused with the SAME client-visible
--     refusal word, and spends nothing.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
do $$
begin
  insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
  values ('pb-u2-post-2','00000000-0000-4000-9200-000000000002','LOST','second keys','desc','Other','OPEN','2026-10-24',
          to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  raise exception 'PB6 FAILED: a second public write landed inside the 30 s window' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_COOLDOWN: wait % seconds before posting again' then
    raise exception 'PB6 FAILED: refused with % instead of POST_COOLDOWN', sqlerrm;
  end if;
  raise notice 'PB6 ok: %', sqlerrm;
end $$;
reset role;
select 'PB6 a refused write spends nothing' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002')=1;

-- P7. Spacing is CROSS-ACTION, not per table: a comment right after the post
--     is refused, and a post right after a comment is refused.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
do $$
begin
  insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
  values('pb-u2-c1','pb-target','00000000-0000-4000-9200-000000000002','close comment',
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  raise exception 'PB7 FAILED: a comment landed 30 s after a post' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_COOLDOWN%' then
    raise exception 'PB7 FAILED: cross-action refusal was %', sqlerrm;
  end if;
end $$;
reset role;
-- Move the recorded instant back past the window, then a comment is admitted.
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
values('pb-u2-c1','pb-target','00000000-0000-4000-9200-000000000002','after the window',
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
do $$
begin
  insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
  values ('pb-u2-post-2','00000000-0000-4000-9200-000000000002','LOST','after comment','desc','Other','OPEN','2026-10-24',
          to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  raise exception 'PB7b FAILED: a post landed 30 s after a comment' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_COOLDOWN%' then
    raise exception 'PB7b FAILED: reverse cross-action refusal was %', sqlerrm;
  end if;
end $$;
reset role;
select 'PB7 one 30 s clock covers posts and comments together' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002' and action_kind in ('POST','COMMENT'))=2;

-- P8. A changed reaction is a covered public interaction; a same-kind no-op and
--     a removal are not, and they neither spend nor wait.
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
select public.findback_react_client('pb-target','LOVE') as first_reaction;
reset role;
select 'PB8a an added reaction spends one admission' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002' and action_kind='POST_REACTION')=1;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
select public.findback_react_client('pb-target','LOVE') as same_kind;
select public.findback_react_client('pb-target',null) as removed_kind;
reset role;
select 'PB8b a same-kind no-op and a removal spend nothing' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002' and action_kind='POST_REACTION')=1;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
do $$
begin
  perform public.findback_react_client('pb-target','SUPPORT');
  raise exception 'PB8c FAILED: a changed reaction was admitted inside the window' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_COOLDOWN%' then
    raise exception 'PB8c FAILED: refusal was %', sqlerrm;
  end if;
end $$;

-- P9. A comment reaction shares the same clock and the same no-op exemptions.
reset role;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000002';
select public.findback_react_comment_client('pb-target-comment','HELPFUL') as first_comment_reaction;
select public.findback_react_comment_client('pb-target-comment','HELPFUL') as same_comment_reaction;
reset role;
select 'PB9 a comment reaction is covered once, with no-op exempt' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002' and action_kind='COMMENT_REACTION')=1;

-- P10. A public return rating shares the clock; a duplicate is a refusal, not a
--      spend.
insert into public.successful_returns (id,lost_post_id,lost_owner_user_id,helper_user_id,recovered_at,created_at)
values ('pb-return','pb-target','00000000-0000-4000-9200-000000000006',
        '00000000-0000-4000-9200-000000000002','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
do $$
begin
  perform public.findback_rate_return('pb-return',5);
  raise exception 'PB10 FAILED: a return rating landed inside the window' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_COOLDOWN%' then
    raise exception 'PB10 FAILED: refusal was %', sqlerrm;
  end if;
end $$;
reset role;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
select public.findback_rate_return('pb-return',5) as return_rating;
do $$
begin
  perform public.findback_rate_return('pb-return',5);
  raise exception 'PB10b FAILED: a duplicate rating was accepted' using errcode='0A000';
exception when others then
  if sqlerrm not like 'You have already rated%' then
    raise exception 'PB10b FAILED: a duplicate inside the window answered %', sqlerrm;
  end if;
end $$;
reset role;
select 'PB10 a public return rating is covered' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002' and action_kind='RETURN_RATING')=1;

-- P11. Safety and private functions never wait on the public clock: report,
--      block, standing, appeal reads and own-comment removal all succeed
--      immediately after an admission, and none of them spends one.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
select public.findback_submit_report('POST','pb-target','SPAM_OR_DUPLICATE',null) as report_receipt;
select public.findback_block_user('00000000-0000-4000-9200-000000000006') as block;
select public.findback_standing() as standing;
select public.findback_my_appeals() as appeals;
select public.findback_my_reports() as reports;
select public.findback_delete_comment_client('pb-u2-c1') as deletion;
reset role;
select 'PB11 report/block/standing/appeals/removal bypass the public clock' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002')=5
  and not exists(select 1 from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000002'
          and action_kind not in ('POST','COMMENT','POST_REACTION','COMMENT_REACTION','RETURN_RATING'));

-- P12. Restoration must not charge the admitted user's clock for someone else.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000006',true);
select public.findback_standing() as other_standing;
reset role;
select 'PB12 the other participant keeps their own untouched clock' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000006')=0;

-- P13. The daily ceiling for a probation account is the TIER ceiling, counted
--      from admissions so deleting the content cannot reset it.
reset role;
insert into public.account_sanctions (id,user_id,kind,starts_at,ends_at,reason_code,active,created_at)
values ('pb-sanc-u4','00000000-0000-4000-9200-000000000004','PROBATION',
        to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char((now() + interval '30 days') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'OTHER',true,to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000004',true);
insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
values('pb-u4-c1','pb-target','00000000-0000-4000-9200-000000000004','three one',
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
reset role;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000004',true);
insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
values('pb-u4-c2','pb-target','00000000-0000-4000-9200-000000000004','three two',
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
reset role;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000004',true);
insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
values('pb-u4-c3','pb-target','00000000-0000-4000-9200-000000000004','three three',
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
reset role;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000004',true);
do $$
begin
  insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
  values('pb-u4-c4','pb-target','00000000-0000-4000-9200-000000000004','fourth',
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  raise exception 'PB13 FAILED: a fourth same-day comment landed' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_LIMIT_REACHED%' then
    raise exception 'PB13 FAILED: refusal was %', sqlerrm;
  end if;
end $$;
-- Deleting the three comments must not restore the fourth slot.
select public.findback_delete_comment_client('pb-u4-c1') as d1;
select public.findback_delete_comment_client('pb-u4-c2') as d2;
select public.findback_delete_comment_client('pb-u4-c3') as d3;
do $$
begin
  insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
  values('pb-u4-c4','pb-target','00000000-0000-4000-9200-000000000004','fourth',
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  raise exception 'PB13b FAILED: deleting content reset the daily ceiling' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_LIMIT_REACHED%' then
    raise exception 'PB13b FAILED: refusal was %', sqlerrm;
  end if;
end $$;
reset role;
select 'PB13 the tier daily ceiling survives content deletion' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000004' and action_kind='COMMENT')=3;

-- PB13c. The ceiling is PER TABLE, exactly like the ordinary contract: three
--        comments must not consume the post ceiling.
reset role;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000004',true);
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('pb-u4-post-1','00000000-0000-4000-9200-000000000004','LOST','spaced post','Description','Other','OPEN','2026-10-24',
        to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
reset role;
select 'PB13c probation keeps the per-table ceiling, not a pooled one' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000004' and action_kind='POST')=1
  and (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000004' and action_kind='COMMENT')=3;

-- PB13d. The reaction/rating tables are no longer a second, ungated write path:
--        no INSERT/UPDATE/DELETE for a client role on any of the three tables,
--        table-level or column-level, including anon and PUBLIC, while reads
--        stay available.
select 'PB13d reaction and rating tables are not directly writable by clients' as probe
where not exists (
  select 1 from information_schema.role_table_grants g
   where g.table_schema='public'
     and g.table_name in ('reactions','comment_reactions','ratings')
     and g.grantee in ('anon','authenticated','PUBLIC')
     and g.privilege_type in ('INSERT','UPDATE','DELETE')
)
and not exists (
  select 1 from information_schema.column_privileges g
   where g.table_schema='public'
     and g.table_name in ('reactions','comment_reactions','ratings')
     and g.grantee in ('anon','authenticated','PUBLIC')
     and g.privilege_type in ('INSERT','UPDATE','DELETE')
)
and has_any_column_privilege('authenticated','public.reactions','SELECT')
and has_any_column_privilege('authenticated','public.comment_reactions','SELECT')
and has_any_column_privilege('authenticated','public.ratings','SELECT');

-- PB13e. A definer writer must restate BOTH halves of the policy it replaced
--        (review R2-F1): a stranger can neither react to nor count a post that
--        is HIDDEN from it, so the reaction notification/broadcast triggers
--        cannot be scheduled from outside, and an unreadable id answers exactly
--        like an id that never existed (contract 13.1).
reset role;
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('pb-hidden','00000000-0000-4000-9200-000000000006','LOST','hidden target','Description','Other','OPEN','2026-10-24',
        '2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.reactions (id,post_id,user_id,type,created_at)
values (md5('reaction|pb-hidden|00000000-0000-4000-9200-000000000006'),'pb-hidden',
        '00000000-0000-4000-9200-000000000006','LIKE','2026-10-24T00:00:00.000Z');
update public.item_posts set moderation_visibility='HIDDEN' where id='pb-hidden';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000001',true);
do $$
declare r record;
begin
  select * into r from public.findback_react_client('pb-hidden','LOVE');
  raise exception 'PB13e FAILED: a stranger reacted to a hidden post' using errcode='0A000';
exception when others then
  if sqlerrm like 'PB13e%' then raise; end if;
  if sqlerrm not like 'Post not found%' then
    raise exception 'PB13e FAILED: the write refusal was %', sqlerrm using errcode='0A000';
  end if;
end $$;
do $$
declare r record;
begin
  select * into r from public.findback_react_client('pb-hidden',null);
  perform set_config('pb.hidden_counts',
    coalesce(r.like_count::text,'-')||'|'||coalesce(r.my_reaction,'-')||'|'||coalesce(r.reaction_counts::text,'-'),
    true);
end $$;
reset role;
select 'PB13e a stranger can neither react to nor count a hidden post' as probe
where current_setting('pb.hidden_counts')='0|-|{}'
  and (select count(*) from public.reactions where post_id='pb-hidden')=1
  and (select count(*) from public.reactions
        where post_id='pb-hidden' and user_id='00000000-0000-4000-9200-000000000001')=0
  and (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000001')=0;

-- PB13f. The rating writer is a definer too and carries the same restated read
--        visibility (it is service-only today, but the invariant is uniform: no
--        writer of these tables touches a target it cannot read).
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000001',true);
do $$
begin
  perform public.findback_rate_client('pb-hidden', 4);
  raise exception 'PB13f FAILED: an unreadable post was rated' using errcode='0A000';
exception when others then
  if sqlerrm like 'PB13f%' then raise; end if;
  if sqlerrm not like 'Post not found%' then
    raise exception 'PB13f FAILED: the refusal was %', sqlerrm using errcode='0A000';
  end if;
end $$;
reset role;
select 'PB13f the rating writer refuses an unreadable post' as probe
where (select count(*) from public.ratings where post_id='pb-hidden')=0
  and (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000001')=0;

-- P14. A TRUSTED probation account keeps the 2x baseline ceiling, proving no
--      probation-only cap was reintroduced.
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
select 'pb-tier-post-'||n,'00000000-0000-4000-9200-000000000006','LOST','tier history','Description','Other','OPEN',
       '2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z' from generate_series(1,5) n;
insert into public.successful_returns (id,lost_post_id,lost_owner_user_id,helper_user_id,recovered_at,created_at)
select 'pb-tier-'||n,'pb-tier-post-'||n,'00000000-0000-4000-9200-000000000006',
       '00000000-0000-4000-9200-000000000002','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'
from generate_series(1,5) n;
insert into public.return_ratings (id,successful_return_id,rater_user_id,rated_user_id,score,created_at,updated_at)
select 'pb-rating-'||n,'pb-tier-'||n,'00000000-0000-4000-9200-000000000006',
       '00000000-0000-4000-9200-000000000002',5,'2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'
from generate_series(1,5) n;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
select 'PB14 probation keeps the tier ceiling: TRUSTED = 2 x base, 30 s' as probe
where public.findback_reputation_tier('00000000-0000-4000-9200-000000000002')='TRUSTED'
  and (select l.limit_per_day from public.findback_post_limit() l)=2*public.findback_base_interaction_limit()
  and (select l.burst_cooldown_seconds from public.findback_post_limit() l)=30;

-- P15. A NON-probation account is unchanged: no ledger row, the accepted
--      NEW ceiling and cooldown, and the same refusal word.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000001',true);
select 'PB15 non-probation limits and clock are unchanged' as probe
where public.findback_standing()='GOOD'
  and (select l.limit_per_day from public.findback_post_limit() l)=3
  and (select l.burst_cooldown_seconds from public.findback_post_limit() l)=120;
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('pb-u1-post-1','00000000-0000-4000-9200-000000000001','LOST','good standing','desc','Other','OPEN','2026-10-24',
        to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
reset role;
select 'PB15b a non-probation write is not recorded as an admission' as probe
where (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000001')=0;

-- P16. Expiry is immediate for every reader: the ledger stops applying at the
--      server expiry and the ordinary cooldown returns.
reset role;
update public.account_sanctions
   set ends_at = to_char((now() - interval '1 second') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 where user_id='00000000-0000-4000-9200-000000000002' and kind='PROBATION';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000002',true);
select 'PB16 expiry stops the probation clock and restores the ordinary one' as probe
where public.findback_standing()='GOOD'
  and (select l.burst_cooldown_seconds from public.findback_post_limit() l)=60
  and (select l.limit_per_day from public.findback_post_limit() l)=2*public.findback_base_interaction_limit();
reset role;

-- P17. A revocation fact removes only its own sanction: an unrelated serious
--      restriction stays effective immediately.
insert into public.account_sanctions (id,user_id,kind,starts_at,ends_at,reason_code,active,created_at)
values ('pb-sanc-u3-probation','00000000-0000-4000-9200-000000000003','PROBATION',
        to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char((now() + interval '30 days') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'OTHER',true,to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
       ('pb-sanc-u3-restricted','00000000-0000-4000-9200-000000000003','RESTRICTED',
        to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),null,'OTHER',true,
        to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
update public.account_sanctions
   set active=false, revoked_at=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 where id='pb-sanc-u3-probation';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000003',true);
select 'PB17 revoking probation leaves the unrelated restriction intact' as probe
where public.findback_standing()='RESTRICTED'
  and (select l.limit_per_day from public.findback_post_limit() l)=0;

-- P18. The notification-reply path is a covered public action: the row's own
--      author is charged and spaced even though the insert has no client subject.
reset role;
delete from public.public_action_admissions where user_id='00000000-0000-4000-9200-000000000005';
insert into public.account_sanctions (id,user_id,kind,starts_at,ends_at,reason_code,active,created_at)
values ('pb-sanc-u5','00000000-0000-4000-9200-000000000005','PROBATION',
        to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char((now() + interval '30 days') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'OTHER',true,to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
insert into public.push_reply_tokens (id,user_id,post_id,parent_comment_id,token_hash,created_at,expires_at)
values ('pb-token-1','00000000-0000-4000-9200-000000000005','pb-target','pb-target-comment',
        repeat('a',64),to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char((clock_timestamp() + interval '1 hour') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
       ('pb-token-2','00000000-0000-4000-9200-000000000005','pb-target','pb-target-comment',
        repeat('b',64),to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char((clock_timestamp() + interval '1 hour') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
set local role service_role;
do $$
declare r record;
begin
  select * into r from public.findback_consume_reply_token_and_add_comment(repeat('a',64),'reply one');
  perform set_config('pb.reply1', r.ok::text, true);
  perform set_config('pb.reason1', coalesce(r.reason,'-'), true);
  raise notice 'PB18 first reply ok=% reason=%', r.ok, r.reason;
end $$;
set local role service_role;
do $$
declare r record;
begin
  begin
    select * into r from public.findback_consume_reply_token_and_add_comment(repeat('b',64),'reply two');
    raise notice 'PB18 second reply returned ok=% reason=%', r.ok, r.reason;
    raise exception 'PB18b FAILED: a second notification reply was not refused (%)', r.reason using errcode='0A000';
  exception when no_data_found then
    raise exception 'PB18b FAILED: second reply probe returned nothing' using errcode='0A000';
  end;
exception when others then
  if sqlerrm like 'PB18b%' then raise; end if;
  raise notice 'PB18 second reply raised % / %', sqlstate, sqlerrm;
  perform set_config('pb.refusal', sqlerrm, true);
end $$;
reset role;
select 'PB18a a first notification reply is admitted once for its author' as probe
where current_setting('pb.reply1')::boolean
  and (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000005' and action_kind='COMMENT')=1;
select 'PB18b the refused second reply is spaced by the same 30 s clock' as probe
where (select used_at from public.push_reply_tokens where id='pb-token-2') is null
  and (select count(*) from public.public_action_admissions
        where user_id='00000000-0000-4000-9200-000000000005')=1;
update public.public_action_admissions set admitted_at = admitted_at - interval '31 seconds'
 where user_id='00000000-0000-4000-9200-000000000005';
set local role service_role;
-- The retry is reported, not merely set: R2-F6 was exactly this — a value that
-- was assigned and never observed. Whatever the retry answers is now in the log.
do $$
declare r record;
begin
  begin
    select * into r from public.findback_consume_reply_token_and_add_comment(repeat('b',64),'reply two');
    perform set_config('pb.reply2', coalesce(r.ok::text,'?'), true);
    perform set_config('pb.reason2', coalesce(r.reason,'-'), true);
    raise notice 'PB18 retry after the wait ok=% reason=%', r.ok, r.reason;
  exception when others then
    perform set_config('pb.reply2', 'f', true);
    perform set_config('pb.reason2', 'raised:' || sqlstate || ':' || sqlerrm, true);
    raise notice 'PB18 retry after the wait raised % / %', sqlstate, sqlerrm;
  end;
end $$;
reset role;
-- PB18c. The refused reply carried its own reason, and the retry after the wait
--        really succeeds (the token is burned and the second reply lands), so the
--        refusal is a wait and not a lost reply.
--        The stored body is NOT the raw p_body: the RPC prefixes an actor mention
--        (`comment_isolation.sql:635`), so the assertion matches on the suffix
--        instead of assuming verbatim storage — the assumption that broke this
--        probe the first time it ever ran.
select 'PB18c the refusal names its reason and the retry after the wait succeeds' as probe
where current_setting('pb.reply1')::boolean
  and current_setting('pb.reason1')='-'
  and current_setting('pb.refusal') like 'POST_COOLDOWN%'
  and current_setting('pb.reply2')::boolean
  and current_setting('pb.reason2')='-'
  and (select used_at from public.push_reply_tokens where id='pb-token-2') is not null
  and exists (select 1 from public.comments
               where post_id='pb-target' and body like '%reply one')
  and exists (select 1 from public.comments
               where post_id='pb-target' and body like '%reply two');

-- P19. A zero self-derived limit is a STANDING fact, not a spent day. Both causes
--      used to share the word POST_LIMIT_REACHED, which made the consumer copy
--      ("that's all your replies for today") false for a restricted account (R3
--      F-1). This probe pins the distinct word on both guard branches, so a client
--      can tell the two apart; PB13/PB13b still pin POST_LIMIT_REACHED for the
--      spent day, which is what makes the distinction provable rather than claimed.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000003',true);
do $$
begin
  insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
  values('pb-u3-standing','pb-target','00000000-0000-4000-9200-000000000003','standing test',
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  raise exception 'PB19 FAILED: a zero-limit author wrote a comment' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_NOT_AVAILABLE%' then
    raise exception 'PB19 FAILED: refusal was % (expected POST_NOT_AVAILABLE)', sqlerrm;
  end if;
end $$;
reset role;
select 'PB19 a zero-limit standing refusal is its own reason on the non-probation branch' as probe
where (select l.limit_per_day from public.findback_post_limit_for('00000000-0000-4000-9200-000000000003') l)=0;

-- PB19b. The RESTRICTED-plus-PROBATION author: the other guard branch, same
--        distinct word (which branch fires depends on the standing precedence, so
--        the probe asserts the reason and not the branch).
reset role;
insert into public.account_sanctions (id,user_id,kind,starts_at,ends_at,reason_code,active,created_at)
values ('pb-sanc-u4-restricted','00000000-0000-4000-9200-000000000004','RESTRICTED',
        to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),null,'OTHER',true,
        to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9200-000000000004',true);
do $$
begin
  insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
  values('pb-u4-standing','pb-target','00000000-0000-4000-9200-000000000004','standing test',
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  raise exception 'PB19b FAILED: a restricted author wrote a comment' using errcode='0A000';
exception when raise_exception then
  if sqlerrm not like 'POST_NOT_AVAILABLE%' then
    raise exception 'PB19b FAILED: refusal was % (expected POST_NOT_AVAILABLE)', sqlerrm;
  end if;
end $$;
reset role;
select 'PB19b a restricted author is refused by standing, not by the day''s quota' as probe
where public.findback_active_sanction_kind('00000000-0000-4000-9200-000000000004')='RESTRICTED'
  and (select l.limit_per_day from public.findback_post_limit_for('00000000-0000-4000-9200-000000000004') l)=0;

rollback;
