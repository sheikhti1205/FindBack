-- Owner amendment 2026-10-24: real local role probes, not hosted acceptance.
-- Run with scripts/sql-behavior.mjs. Each SELECT must produce exactly one row.
-- Mutation caught: COMMENT moderation canonicalized to POST or permissive child RLS.
begin;

insert into public.users (id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9100-'||lpad(n::text,12,'0'), 'comment_isolation_'||n,
       'comment_isolation_'||n||'@example.invalid', '+880191000000'||n, 1,
       '2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'
from generate_series(1,6) n;
insert into public.user_roles (user_id,role,granted_at)
values ('00000000-0000-4000-9100-000000000004','ADMIN','2026-10-24T00:00:00.000Z'),
       ('00000000-0000-4000-9100-000000000005','ADMIN','2026-10-24T00:00:00.000Z');
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('ci-post','00000000-0000-4000-9100-000000000001','LOST','Isolation post','Description','Electronics','OPEN','2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'),
       ('ci-other-post','00000000-0000-4000-9100-000000000001','FOUND','Other post','Description','Electronics','OPEN','2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.comments (id,post_id,user_id,body,created_at,updated_at)
values ('ci-target','ci-post','00000000-0000-4000-9100-000000000002','Target body','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'),
       ('ci-sibling','ci-post','00000000-0000-4000-9100-000000000003','Sibling body','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'),
       ('ci-report-target','ci-post','00000000-0000-4000-9100-000000000002','Report only body','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.comment_reactions (id,comment_id,user_id,type,created_at)
values ('ci-reaction','ci-target','00000000-0000-4000-9100-000000000003','LIKE','2026-10-24T00:00:00.000Z');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000004',true);
select public.findback_apply_moderation('COMMENT','ci-target','HIDE','HARASSMENT',null) as audit;
reset role;

-- This is intentionally first: the baseline hides ci-post and must fail here.
select 'CI1 hiding a comment never changes its parent report' as probe
where (select moderation_visibility from public.item_posts where id='ci-post')='PUBLISHED';
select 'CI2 the effect and finality key belong to the exact comment' as probe
where (select moderation_visibility from public.comments where id='ci-target')='HIDDEN'
  and (select moderation_visibility from public.comments where id='ci-sibling')='PUBLISHED'
  and exists(select 1 from public.moderation_case_decisions where target_type='COMMENT' and target_id='ci-target')
  and not exists(select 1 from public.moderation_case_decisions where target_type='POST' and target_id='ci-post');
select 'CI3 only the commenter receives this moderation outcome' as probe
where exists(select 1 from public.notifications where type='MODERATION' and user_id='00000000-0000-4000-9100-000000000002')
  and not exists(select 1 from public.notifications where type='MODERATION' and user_id='00000000-0000-4000-9100-000000000001');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000006',true);
select 'CI4 ordinary list/raw/count exclude only hidden target' as probe
where (select count(*) from public.comments where post_id='ci-post')=2
  and (select count(*) from public.findback_list_comments_client('ci-post'))=2
  and not exists(select 1 from public.comments where id='ci-target')
  and not exists(select 1 from public.comment_reactions where comment_id='ci-target');
do $$ begin
  begin
    perform public.findback_react_comment_client('ci-target','LOVE');
    raise exception 'CI5 definer reaction revealed a hidden target' using errcode='0A000';
  exception when no_data_found then null; end;
end $$;

-- Own reporting conceals locally, not globally, and a lost-response retry works.
select set_config('ci.receipt',public.findback_submit_report('COMMENT','ci-report-target','HARASSMENT',null),true);
select 'CI6 reporter no longer reads target and retry returns own receipt' as probe
where not exists(select 1 from public.comments where id='ci-report-target')
  and not exists(select 1 from public.findback_list_comments_client('ci-post') where id='ci-report-target')
  and public.findback_submit_report('COMMENT','ci-report-target','HARASSMENT',null)=current_setting('ci.receipt');
reset role;
select 'CI7 report case is COMMENT without a sanction or global effect' as probe
where exists(select 1 from public.content_reports where id=current_setting('ci.receipt') and case_type='COMMENT' and case_id='ci-report-target')
  and (select moderation_visibility from public.comments where id='ci-report-target')='PUBLISHED'
  and not exists(select 1 from public.account_sanctions where user_id='00000000-0000-4000-9100-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000003',true);
select 'CI8 another viewer still reads the reported comment' as probe
where exists(select 1 from public.comments where id='ci-report-target');

-- An unrelated administrator may decide the parent but not reverse this comment.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000005',true);
select public.findback_apply_moderation('POST','ci-post','NO_ACTION','HARASSMENT',null) as audit;
do $$ begin
  begin
    perform public.findback_apply_moderation('COMMENT','ci-target','PUBLISH','HARASSMENT',null);
    raise exception 'CI9 independent decider reversed a finalized comment' using errcode='0A000';
   exception when sqlstate 'P0001' then
    if sqlerrm <> 'MODERATION_DECISION_FINAL' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000004',true);
select public.findback_apply_moderation('COMMENT','ci-target','PUBLISH','HARASSMENT',null) as audit;
reset role;
select 'CI10 same-decider revision advances only comment generation' as probe
where (select generation from public.moderation_case_decisions where target_type='COMMENT' and target_id='ci-target')=2
  and (select generation from public.moderation_case_decisions where target_type='POST' and target_id='ci-post')=1
  and (select moderation_visibility from public.comments where id='ci-target')='PUBLISHED';

select 'CI11 clients cannot read, insert or update the moderation atom' as probe
where not has_column_privilege('authenticated','public.comments','moderation_visibility','SELECT')
  and not has_column_privilege('authenticated','public.comments','moderation_visibility','INSERT')
  and not has_column_privilege('authenticated','public.comments','moderation_visibility','UPDATE')
  and not has_table_privilege('authenticated','public.comments','INSERT');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000006',true);
do $$ begin
  begin
    insert into public.comments(id,post_id,user_id,body,created_at,updated_at,moderation_visibility)
    values('ci-forged','ci-post',auth.uid()::text,'Forged',now()::text,now()::text,'HIDDEN');
    raise exception 'CI12 raw insert forged moderation state' using errcode='0A000';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.comments(id,post_id,user_id,body,created_at,updated_at,parent_id,depth)
    values('ci-cross-parent','ci-other-post',auth.uid()::text,'Cross-post',now()::text,now()::text,'ci-sibling',1);
    raise exception 'CI12 raw insert forged a cross-post parent' using errcode='0A000';
  exception when no_data_found then null; end;
end $$;
reset role;

-- New unauthorized targets are always neutral; a known own COMMENT receipt is
-- a retry, not a second report, even if the live subject was subsequently gone.
delete from public.comments where id='ci-report-target';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000006',true);
select 'CI13 an own deleted COMMENT receipt retry remains idempotent' as probe
where public.findback_submit_report('COMMENT','ci-report-target','HARASSMENT',null)=current_setting('ci.receipt');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000003',true);
do $$ begin
  begin
    perform public.findback_submit_report('COMMENT','ci-report-target','HARASSMENT',null);
    raise exception 'CI13 a stranger obtained a deleted subject receipt' using errcode='0A000';
  exception when no_data_found then
    if sqlerrm<>'Report target unavailable' then raise; end if;
  end;
end $$;
reset role;

-- Ordinary readers see promoted visible descendants, never hidden ancestor ids.
insert into public.comments(id,post_id,user_id,parent_id,depth,body,created_at,updated_at)
values('ci-tree-middle','ci-post','00000000-0000-4000-9100-000000000002','ci-sibling',1,'Hidden ancestor','2026-10-24T00:00:01.000Z','2026-10-24T00:00:01.000Z');
insert into public.comments(id,post_id,user_id,parent_id,depth,body,created_at,updated_at)
values('ci-tree-child','ci-post','00000000-0000-4000-9100-000000000003','ci-tree-middle',2,'Visible descendant','2026-10-24T00:00:02.000Z','2026-10-24T00:00:02.000Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000004',true);
select public.findback_apply_moderation('COMMENT','ci-tree-middle','HIDE','HARASSMENT',null) as audit;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000006',true);
select 'CI14 visible descendant is promoted without hidden ancestry' as probe
from public.findback_list_comments_client('ci-post') c
where c.id='ci-tree-child' and c.parent_id='ci-sibling' and c.depth=1
  and not exists(select 1 from public.findback_list_comments_client('ci-post') where id='ci-tree-middle');
do $$ begin
  begin
    perform parent_id from public.comments where id='ci-tree-child';
    raise exception 'CI14 raw topology bypassed safe projection' using errcode='0A000';
  exception when insufficient_privilege then null; end;
  begin
    perform public.findback_can_read_comment_for('ci-tree-middle','00000000-0000-4000-9100-000000000002');
    raise exception 'CI15 arbitrary-actor eligibility was callable' using errcode='0A000';
  exception when insufficient_privilege then null; end;
  begin
    perform public.findback_add_comment_client('ci-post','Reply','ci-tree-middle');
    raise exception 'CI15 reply to hidden parent succeeded' using errcode='0A000';
  exception when no_data_found then null; end;
end $$;
reset role;

-- F1: BEFORE-trigger diagnostics must not use a forged actor as read authority.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9100-000000000006',true);
do $$ declare v_parent text; begin
  foreach v_parent in array array['ci-tree-middle','ci-never-existed','ci-sibling'] loop
    begin
      insert into public.comments(id,post_id,user_id,parent_id,body,created_at,updated_at)
      values('ci-forged-actor','ci-post','00000000-0000-4000-9100-000000000002',v_parent,'Forged actor',now()::text,now()::text);
      raise exception 'CI16 forged actor inserted' using errcode='0A000';
    exception when insufficient_privilege then
      if sqlerrm<>'Comment actor unavailable' then
        raise exception 'CI16 actor diagnostics leaked target state: %',sqlerrm;
      end if;
    end;
  end loop;
end $$;
reset role;

-- R9-E: the list projection's per-row kernel cost rests on covering indexes.
-- This records the index review structurally; release-scale measurement is
-- still open and is not claimed here.
select 'CI17 kernel and list lookups have covering indexes' as probe
where exists(select 1 from pg_indexes i where i.schemaname='public'
    and i.indexname='content_reports_dedupe_key')
  and exists(select 1 from pg_indexes i where i.schemaname='public'
    and i.indexname='idx_comments_post')
  and exists(select 1 from pg_indexes i where i.schemaname='public'
    and i.indexname='idx_comment_reactions_comment')
  and exists(select 1 from pg_indexes i where i.schemaname='public'
    and i.indexname='idx_comment_attachments_comment');

rollback;
