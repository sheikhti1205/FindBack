-- Deliberate safety RETAIN/ANONYMIZE vs private account DELETE. Real local SQL,
-- synthetic identities, exact expiry boundary and full rollback, not live proof.
begin;
create function pg_temp.m3_retention_assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'M3 RETENTION FAILED: %',label;end if;end$$;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9704-'||lpad(n::text,12,'0'),'m3retain'||n,'m3retain'||n||'@example.invalid','+880197040000'||n,1,now(),now() from generate_series(1,5)n;
insert into public.user_roles(user_id,role,granted_at) values
 ('00000000-0000-4000-9704-000000000001','ADMIN',now()),('00000000-0000-4000-9704-000000000005','ADMIN',now()),('00000000-0000-4000-9704-000000000002','MODERATOR',now());
insert into public.user_role_capabilities(user_id,capability,granted_at) values
 ('00000000-0000-4000-9704-000000000002','appeals_review',now()),('00000000-0000-4000-9704-000000000002','feedback_read',now());
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values('m3-retain-post','00000000-0000-4000-9704-000000000003','LOST','Original safety snapshot title','Original bounded context','Other','OPEN',current_date,now(),now());
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9704-000000000004',true);
select set_config('m3r.report',public.findback_submit_report('POST','m3-retain-post','OTHER','Private report explanation'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9704-000000000001',true);
select set_config('m3r.action',public.findback_apply_moderation('POST','m3-retain-post','HIDE','OTHER','Private original staff reason'),true);
select public.findback_apply_moderation('USER','00000000-0000-4000-9704-000000000003','WARN','OTHER','Private sanction');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9704-000000000003',true);
select set_config('m3r.appeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3r.action'),'Private safety appeal message'),true);
select set_config('m3r.feedback',public.findback_submit_feedback('BUG','Deletable private support message',true,'0.9.0-beta','android','feedback','phone'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9704-000000000002',true);
select public.findback_resolve_appeal(current_setting('m3r.appeal'),'DENIED','Private final safety reason');
select public.findback_review_feedback(current_setting('m3r.feedback'),'RESOLVED','NEW','Deletable private support note');
reset role;
select set_config('m3r.expiry',(select evidence_expires_at from public.content_reports where id=current_setting('m3r.report')),true);
-- Reviewer deletion must remove live identity pointers, not erase the result or
-- append-only decision/audit context. This field is not an immutable identity.
delete from public.users where id='00000000-0000-4000-9704-000000000002';
select pg_temp.m3_retention_assert((select resolved_by is null and status='RESOLVED' and decision='DENIED' and reviewer_note='Private final safety reason' from public.appeals where id=current_setting('m3r.appeal')),'reviewer live pointer anonymizes while durable outcome/reason stay');
select pg_temp.m3_retention_assert(not exists(select 1 from public.user_roles where user_id='00000000-0000-4000-9704-000000000002') and not exists(select 1 from public.user_role_capabilities where user_id='00000000-0000-4000-9704-000000000002'),'reviewer roles/capabilities deleted');
select pg_temp.m3_retention_assert((select actor_user_id is null from public.admin_audit_log where target_id=current_setting('m3r.appeal') and action='APPEAL_RESOLVED'),'audit actor pointer anonymizes');
delete from public.users where id in ('00000000-0000-4000-9704-000000000003','00000000-0000-4000-9704-000000000004','00000000-0000-4000-9704-000000000001');
select pg_temp.m3_retention_assert((select appellant_user_id is null and subject_id=current_setting('m3r.action') and message='Private safety appeal message' and decision='DENIED' from public.appeals where id=current_setting('m3r.appeal')),'safety appeal retains immutable subject/message/outcome with null appellant');
select pg_temp.m3_retention_assert((select reporter_user_id is null and target_post_id is null and reviewed_by is null and target_id='m3-retain-post' and evidence_snapshot->>'title'='Original safety snapshot title' and evidence_erased_at is null from public.content_reports where id=current_setting('m3r.report')),'report snapshot outlives reporter/target/reviewer without live identity pointers');
select pg_temp.m3_retention_assert(not exists(select 1 from public.feedback where id=current_setting('m3r.feedback')) and not exists(select 1 from public.account_sanctions where user_id='00000000-0000-4000-9704-000000000003'),'support text/context/note and sanctions deleted with account');
select pg_temp.m3_retention_assert(not exists(select 1 from public.notifications where user_id='00000000-0000-4000-9704-000000000003') and not exists(select 1 from public.appeal_notifications where appeal_id=current_setting('m3r.appeal')),'private notifications/receipt bookkeeping deleted');
select pg_temp.m3_retention_assert(not exists(select 1 from public.admin_audit_log where target_id=current_setting('m3r.feedback') and (coalesce(reason,'')||previous_state::text||new_state::text)~'Deletable|support message|support note'),'retained feedback audit never contains deletable support text');
-- The decider id has NO foreign key on purpose: a deleted account must never
-- evaporate a final decision or hand the case to another moderator. Retention
-- keeps the immutable attribution and closed state; only live identity pointers
-- (appeals.resolved_by, audit actor) are anonymized.
select pg_temp.m3_retention_assert((select decider_user_id='00000000-0000-4000-9704-000000000001' and reopened_at is null and audit_id=current_setting('m3r.action') and decision_action='HIDE' from public.moderation_case_decisions where target_type='POST' and target_id='m3-retain-post'),'deleted decider keeps immutable finality attribution, not a transferable or null decider');
set local role service_role;
select pg_temp.m3_retention_assert(public.findback_expire_report_evidence(100,current_setting('m3r.expiry'))=1,'exact90day boundary physically sweeps one snapshot');
select pg_temp.m3_retention_assert(public.findback_expire_report_evidence(100,current_setting('m3r.expiry'))=0,'expiry repetition is idempotent');
reset role;
select pg_temp.m3_retention_assert((select evidence_snapshot='{}'::jsonb and detail is null and internal_note is null and evidence_erased_at=current_setting('m3r.expiry') from public.content_reports where id=current_setting('m3r.report')),'snapshot/detail/internal note erased together, receipt retained');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9704-000000000005',true);
select pg_temp.m3_retention_assert(public.findback_staff_appeal(current_setting('m3r.appeal'))->'evidence'->0->'snapshot'='null'::jsonb,'staff read never reconstructs expired or deleted content');
select 'M3 deliberate safety retention/private support deletion verified' as probe;
rollback;
