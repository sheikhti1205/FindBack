-- Disposable real PostgreSQL only; synthetic fixture identities; full rollback.
-- Regression target: wrong legacy role/schema/status fields must not hide behind
-- green foundation probes. Resolution/expiry are actually invoked here.
begin;
create function pg_temp.m3_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'M3 FAILED: %',label; end if; end $$;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9300-'||lpad(n::text,12,'0'), 'm3user'||n,
 'm3user'||n||'@example.invalid','+880193000000'||n,1,'2026-10-29T00:00:00Z','2026-10-29T00:00:00Z'
from generate_series(1,6)n;
insert into public.user_roles(user_id,role,granted_at) values
 ('00000000-0000-4000-9300-000000000001','ADMIN','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9300-000000000002','MODERATOR','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9300-000000000005','MODERATOR','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9300-000000000006','ADMIN','2026-10-29T00:00:00Z');
insert into public.user_role_capabilities(user_id,capability,granted_at) values
 ('00000000-0000-4000-9300-000000000002','appeals_review','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9300-000000000005','reports_review','2026-10-29T00:00:00Z');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('m3-post','00000000-0000-4000-9300-000000000003','LOST','Synthetic appeal target','Only a fixture','Electronics','OPEN','2026-10-29','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z'),
 ('m3-post-stale','00000000-0000-4000-9300-000000000003','LOST','Synthetic newer decision target','Only a fixture','Electronics','OPEN','2026-10-29','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000001',true);
select set_config('m3.audit',public.findback_apply_moderation('POST','m3-post','HIDE','OTHER','Fixture action'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select set_config('m3.appeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3.audit'),'Please reconsider this fixture'),true);

-- Before looking up ANY target the canonical capability must refuse ordinary
-- accounts (both valid/missing IDs). Null/unknown decisions must not write.
do $$ begin
 begin perform public.findback_resolve_appeal(current_setting('m3.appeal'),'GRANTED','Reason');
  raise exception 'M3 ordinary resolver allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_resolve_appeal('missing','DENIED','Reason');
  raise exception 'M3 resolver enumeration allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000002',true);
do $$ begin
 begin perform public.findback_resolve_appeal(current_setting('m3.appeal'),null,'Reason');
  raise exception 'M3 null decision allowed' using errcode='0A000';
 exception when invalid_parameter_value then null; end;
 begin perform public.findback_resolve_appeal(current_setting('m3.appeal'),'GRANTED',' ');
  raise exception 'M3 blank reason allowed' using errcode='0A000';
 exception when invalid_parameter_value then null; end;
end $$;

-- Self-review: a sanction does not remove user_roles, so the sanctioned account
-- can still hold appeals_review. Deciding your own appeal would lift your own
-- sanction and, via the reversal, make you final owner of the case about you.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000001',true);
select set_config('m3.selfsanction',public.findback_apply_moderation('USER','00000000-0000-4000-9300-000000000002','WARN','OTHER','Fixture self sanction'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000002',true);
select set_config('m3.selfappeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3.selfsanction'),'Review my own warning'),true);
do $$ begin
 begin perform public.findback_resolve_appeal(current_setting('m3.selfappeal'),'GRANTED','Self grant');
  raise exception 'M3 self-review allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.m3_assert((select status='SUBMITTED' and decision is null and resolved_by is null from public.appeals where id=current_setting('m3.selfappeal')),'self-review refused without touching the appeal');
select pg_temp.m3_assert((select active and revoked_at is null from public.account_sanctions where id=(select new_state->>'sanction_id' from public.admin_audit_log where id=current_setting('m3.selfsanction'))),'self-review never lifts the reviewer own sanction');
select pg_temp.m3_assert((select decider_user_id='00000000-0000-4000-9300-000000000001' from public.moderation_case_decisions where target_type='USER' and target_id='00000000-0000-4000-9300-000000000002'),'self-review never takes case ownership');
select pg_temp.m3_assert(not exists(select 1 from public.admin_audit_log where target_id=current_setting('m3.selfappeal')),'self-review writes no audit');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000002',true);
set local role authenticated;
select public.findback_resolve_appeal(current_setting('m3.appeal'),'GRANTED','Reviewed the original action');
reset role;
select pg_temp.m3_assert((select status='OPEN' and moderation_visibility='PUBLISHED' from public.item_posts where id='m3-post'),'grant reverses visibility, never report lifecycle');
select pg_temp.m3_assert((select status='RESOLVED' and decision='GRANTED' and reviewer_note='Reviewed the original action' and resolved_by='00000000-0000-4000-9300-000000000002' from public.appeals where id=current_setting('m3.appeal')),'durable grant result and attribution');
select pg_temp.m3_assert((select count(*)=1 from public.admin_audit_log where action='APPEAL_RESOLVED' and target_id=current_setting('m3.appeal')),'one resolution audit');
select pg_temp.m3_assert((select count(*)=1 from public.notifications where user_id='00000000-0000-4000-9300-000000000003' and type='MODERATION' and preview='Your appeal was granted.'),'canonical consumer outcome exactly once');
select pg_temp.m3_assert((select generation=2 and decision_action='PUBLISH' and decider_user_id='00000000-0000-4000-9300-000000000002' and reopened_at is null from public.moderation_case_decisions where target_type='POST' and target_id='m3-post'),'reversal records canonical final case generation');
set local role authenticated;
do $$ begin
 begin perform public.findback_resolve_appeal(current_setting('m3.appeal'),'DENIED','Changed my mind');
  raise exception 'M3 already-resolved accepted' using errcode='0A000';
 exception when sqlstate 'P0001' then if sqlerrm<>'APPEAL_ALREADY_RESOLVED' then raise; end if; end;
 begin perform public.findback_reverse_appeal_action('missing');
  raise exception 'M3 internal reverse entry executable' using errcode='0A000';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select pg_temp.m3_assert(public.findback_my_appeals()->'items'->0->>'decision'='GRANTED'
 and not(public.findback_my_appeals()->'items'->0 ?| array['reviewer_note','resolved_by','message']),'safe own result without staff identity/note');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000004',true);
select pg_temp.m3_assert(jsonb_array_length(public.findback_my_appeals()->'items')=0,'no foreign result receipt');
reset role;

-- Granting an older action must not undo a new decision. Denial must not reverse.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000001',true);
select set_config('m3.oldaudit',public.findback_apply_moderation('POST','m3-post-stale','HIDE','OTHER',null),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select set_config('m3.oldappeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3.oldaudit'),'Old decision review'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000001',true);
select set_config('m3.newaudit',public.findback_apply_moderation('POST','m3-post-stale','REMOVE','OTHER',null),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000002',true);
select public.findback_resolve_appeal(current_setting('m3.oldappeal'),'GRANTED','The older action was mistaken');
select pg_temp.m3_assert((select moderation_visibility='REMOVED' from public.item_posts where id='m3-post-stale'),'new decision preserved after old appeal');
select pg_temp.m3_assert((select audit_id=current_setting('m3.newaudit') from public.moderation_case_decisions where target_id='m3-post-stale'),'new case attribution preserved');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select set_config('m3.denied',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3.newaudit'),'Current decision review'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000002',true);
select public.findback_resolve_appeal(current_setting('m3.denied'),'DENIED','The decision stands');
select pg_temp.m3_assert((select moderation_visibility='REMOVED' from public.item_posts where id='m3-post-stale'),'denial never reverses');

-- A live older sanction remains independently appealable; revoking one does
-- not revoke a later serious sanction or set a cached standing to GOOD.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000001',true);
select set_config('m3.warn',public.findback_apply_moderation('USER','00000000-0000-4000-9300-000000000003','WARN','OTHER',null),true);
select set_config('m3.ban',public.findback_apply_moderation('USER','00000000-0000-4000-9300-000000000003','BAN','OTHER',null),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select set_config('m3.warnappeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3.warn'),'Review warning'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000002',true);
select public.findback_resolve_appeal(current_setting('m3.warnappeal'),'GRANTED','Warning reversed');
select pg_temp.m3_assert((select not active and revoked_at is not null from public.account_sanctions where id=(select new_state->>'sanction_id' from public.admin_audit_log where id=current_setting('m3.warn'))),'exact sanction audit alias reversed');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select pg_temp.m3_assert(public.findback_standing('00000000-0000-4000-9300-000000000003')='BANNED','other serious sanction remains effective');

-- Real expiry invokes uppercase lifecycle; no phantom reversed/expired status.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select set_config('m3.expired',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3.ban'),'Time-bound review'),true);
update public.appeals set expires_at=clock_timestamp()-interval '1 day' where id=current_setting('m3.expired');
select set_config('request.jwt.claim.sub','',true);
select pg_temp.m3_assert(public.findback_expire_stale_appeals()=1,'stale appeal actually expires');
select pg_temp.m3_assert(public.findback_expire_stale_appeals()=0,'expiry repeats idempotently');
select pg_temp.m3_assert((select status='RESOLVED' and decision='EXPIRED' and resolved_by is null from public.appeals where id=current_setting('m3.expired')),'expiry durable safe result');
select pg_temp.m3_assert((select count(*)=1 from public.notifications where user_id='00000000-0000-4000-9300-000000000003' and preview='Your appeal expired before it could be reviewed. You can submit a new appeal.'),'expiry canonical outcome once');
select pg_temp.m3_assert((select count(*)=1 from public.admin_audit_log where target_id=current_setting('m3.expired') and action='APPEAL_EXPIRED' and actor_user_id is null),'expiry system audit');

-- Two open identities may refer to one sanction (SANCTION and audit alias).
-- Closing the first must transfer the re-evaluation marker to the still-open
-- one; closing the last must restore finality, not leave a resolved marker.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select set_config('m3.alias1',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3.ban'),'Another alias review'),true);
select set_config('m3.alias2',public.findback_submit_appeal('SANCTION',(select new_state->>'sanction_id' from public.admin_audit_log where id=current_setting('m3.ban')),'Sanction review'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000002',true);
select public.findback_resolve_appeal(current_setting('m3.alias1'),'DENIED','Original action stands');
select pg_temp.m3_assert((select reopened_by_appeal_id=current_setting('m3.alias2') from public.moderation_case_decisions where target_type='USER' and target_id='00000000-0000-4000-9300-000000000003'),'last open alias owns pending reopening');
select public.findback_resolve_appeal(current_setting('m3.alias2'),'DENIED','Sanction stands');
select pg_temp.m3_assert((select reopened_by_appeal_id is null and reopened_at is null from public.moderation_case_decisions where target_type='USER' and target_id='00000000-0000-4000-9300-000000000003'),'closing final alias restores case finality');
select pg_temp.m3_assert((select count(*)=3 from public.notifications where user_id='00000000-0000-4000-9300-000000000003' and preview='Your appeal was denied.'),'separate appeal outcomes not lifetime-deduplicated');

-- A GRANTED resolution reverses the action and rewrites the case row (new
-- audit_id, sanction_id=null) BEFORE the marker transfer runs. The still-open
-- sibling must keep owning the reopening marker, and only the resolution that
-- really reversed something may claim a grant.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000001',true);
select set_config('m3.restrict',public.findback_apply_moderation('USER','00000000-0000-4000-9300-000000000003','RESTRICT_POSTING','OTHER',null),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select set_config('m3.galias1',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3.restrict'),'Audit alias grant'),true);
select set_config('m3.galias2',public.findback_submit_appeal('SANCTION',(select new_state->>'sanction_id' from public.admin_audit_log where id=current_setting('m3.restrict')),'Sanction alias still open'),true);
select set_config('m3.granted_before',(select count(*)::text from public.notifications where user_id='00000000-0000-4000-9300-000000000003' and preview='Your appeal was granted.'),true);
select set_config('m3.honest_before',(select count(*)::text from public.notifications where user_id='00000000-0000-4000-9300-000000000003' and preview='Your appeal was reviewed. No further change was applied.'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000002',true);
select public.findback_resolve_appeal(current_setting('m3.galias1'),'GRANTED','Restriction lifted');
select pg_temp.m3_assert((select reopened_by_appeal_id=current_setting('m3.galias2') and reopened_at is not null from public.moderation_case_decisions where target_type='USER' and target_id='00000000-0000-4000-9300-000000000003'),'granted reversal transfers reopening to the still-open alias');
select pg_temp.m3_assert((select not active from public.account_sanctions where id=(select new_state->>'sanction_id' from public.admin_audit_log where id=current_setting('m3.restrict'))),'granted alias actually lifted the restriction');
select pg_temp.m3_assert((select count(*)=current_setting('m3.granted_before')::int+1 from public.notifications where user_id='00000000-0000-4000-9300-000000000003' and preview='Your appeal was granted.'),'real reversal claims a grant');
select public.findback_resolve_appeal(current_setting('m3.galias2'),'GRANTED','Second alias after reversal');
select pg_temp.m3_assert((select reopened_by_appeal_id is null and reopened_at is null from public.moderation_case_decisions where target_type='USER' and target_id='00000000-0000-4000-9300-000000000003'),'closing the last alias restores finality after a grant');
select pg_temp.m3_assert((select count(*)=current_setting('m3.honest_before')::int+1 from public.notifications where user_id='00000000-0000-4000-9300-000000000003' and preview='Your appeal was reviewed. No further change was applied.'),'already-reversed alias reports an honest unchanged outcome');
select pg_temp.m3_assert((select count(*)=current_setting('m3.granted_before')::int+1 from public.notifications where user_id='00000000-0000-4000-9300-000000000003' and preview='Your appeal was granted.'),'second alias never claims a second grant');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000005',true);
set local role authenticated;
do $$ begin
 begin perform public.findback_resolve_appeal('missing','DENIED','Reason');
  raise exception 'M3 bounded moderator resolver allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_expire_stale_appeals();
  raise exception 'M3 client expiry executable' using errcode='0A000';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000001',true);
delete from public.users where id='00000000-0000-4000-9300-000000000003';
select pg_temp.m3_assert((select appellant_user_id is null and status='RESOLVED' from public.appeals where id=current_setting('m3.appeal')),'safety appeal retained after appellant deletion');
select pg_temp.m3_assert(not exists(select 1 from public.appeal_notifications where recipient_id='00000000-0000-4000-9300-000000000003'),'private notification state deleted with recipient');
select 'M3 resolver/expiry/reversal/receipt behavior verified' as probe;
rollback;
