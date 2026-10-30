-- Real rollback-only state transitions; no source-string oracle.
begin;
create function pg_temp.m3_check(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'M3 BOUNDARY FAILED: %',label; end if; end $$;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9400-'||lpad(n::text,12,'0'),'m3boundary'||n,
 'm3boundary'||n||'@example.invalid','+880194000000'||n,1,'2026-10-29T00:00:00Z','2026-10-29T00:00:00Z'
from generate_series(1,5)n;
insert into public.user_roles(user_id,role,granted_at) values
 ('00000000-0000-4000-9400-000000000001','ADMIN','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9400-000000000002','MODERATOR','2026-10-29T00:00:00Z');
insert into public.user_role_capabilities(user_id,capability,granted_at) values
 ('00000000-0000-4000-9400-000000000002','appeals_review','2026-10-29T00:00:00Z');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
select 'm3-boundary-'||n,'00000000-0000-4000-9400-000000000003','LOST','Synthetic case '||n,
 'Rollback fixture','Electronics','OPEN','2026-10-29','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z'
from generate_series(1,4)n;
insert into public.comments(id,post_id,user_id,body,created_at,updated_at) values
 ('m3-boundary-comment','m3-boundary-1','00000000-0000-4000-9400-000000000004','Synthetic comment','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000001',true);
select set_config('m3b.audit',public.findback_apply_moderation('COMMENT','m3-boundary-comment','HIDE','OTHER','Comment case'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000004',true);
set local role authenticated;
select set_config('m3b.appeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3b.audit'),'Review comment action'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000002',true);
select public.findback_resolve_appeal(current_setting('m3b.appeal'),'GRANTED','Restore original comment visibility');
reset role;
select pg_temp.m3_check((select moderation_visibility='PUBLISHED' from public.comments where id='m3-boundary-comment'),'comment appeal restores isolated COMMENT atom');
select pg_temp.m3_check((select moderation_visibility='PUBLISHED' and status='OPEN' from public.item_posts where id='m3-boundary-1'),'comment appeal never changes parent POST');
select pg_temp.m3_check((select audit_id<>current_setting('m3b.audit') and generation=2 and target_type='COMMENT' from public.moderation_case_decisions where target_id='m3-boundary-comment'),'comment reversal uses original isolated case attribution');
select pg_temp.m3_check((select target_type='COMMENT' and target_id='m3-boundary-comment' from public.admin_audit_log where new_state->>'appeal_id'=current_setting('m3b.appeal') and action='PUBLISH'),'reversal audit preserves submitted subject');

-- Rejected malformed persisted results do not silently become unknown receipts.
do $$ begin
 begin
  update public.appeals set decision=null where id=current_setting('m3b.appeal');
  raise exception 'M3 BOUNDARY FAILED: null resolved decision accepted' using errcode='0A000';
 exception when check_violation then null; end;
end $$;

-- Current-state drift, a newer NO_ACTION and deleted live targets cannot be
-- overwritten by a granted old action. Grant is a receipt, not resurrection.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000001',true);
select set_config('m3b.deleted_audit',public.findback_apply_moderation('POST','m3-boundary-2','REMOVE','OTHER',null),true);
select set_config('m3b.drift_audit',public.findback_apply_moderation('POST','m3-boundary-3','HIDE','OTHER',null),true);
select set_config('m3b.noaction_audit',public.findback_apply_moderation('POST','m3-boundary-4','HIDE','OTHER',null),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000003',true);
select set_config('m3b.deleted_appeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3b.deleted_audit'),'Review before deletion'),true);
select set_config('m3b.drift_appeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3b.drift_audit'),'Review before drift'),true);
select set_config('m3b.noaction_appeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3b.noaction_audit'),'Review before new dismissal'),true);
delete from public.item_posts where id='m3-boundary-2';
update public.item_posts set moderation_visibility='REMOVED' where id='m3-boundary-3';
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000001',true);
select set_config('m3b.new_noaction',public.findback_apply_moderation('POST','m3-boundary-4','NO_ACTION','OTHER',null),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000002',true);
set local role authenticated;
select public.findback_resolve_appeal(current_setting('m3b.deleted_appeal'),'GRANTED','Do not resurrect deleted post');
select public.findback_resolve_appeal(current_setting('m3b.drift_appeal'),'GRANTED','Do not overwrite drift');
select public.findback_resolve_appeal(current_setting('m3b.noaction_appeal'),'GRANTED','Do not overwrite newer decision');
reset role;
select pg_temp.m3_check(not exists(select 1 from public.item_posts where id='m3-boundary-2'),'deleted report is not resurrected');
select pg_temp.m3_check((select moderation_visibility='REMOVED' from public.item_posts where id='m3-boundary-3'),'independent current state is not overwritten');
select pg_temp.m3_check((select audit_id=current_setting('m3b.new_noaction') from public.moderation_case_decisions where target_id='m3-boundary-4'),'new NO_ACTION attribution preserved');
select pg_temp.m3_check(not exists(select 1 from public.admin_audit_log where new_state->>'appeal_id' in (current_setting('m3b.deleted_appeal'),current_setting('m3b.drift_appeal'),current_setting('m3b.noaction_appeal'))),'no fabricated state-change audit on no-op grants');
-- A no-op grant must not tell the appellant their appeal changed anything. The
-- Inbox and durable appeal history must agree about actual change.
select pg_temp.m3_check((select count(*)=3 from public.notifications
 where user_id='00000000-0000-4000-9400-000000000003' and type='MODERATION'
  and preview='Your appeal was reviewed. No further change was applied.'),
 'no-op grants report an honest unchanged outcome');
select pg_temp.m3_check(not exists(select 1 from public.notifications
 where user_id='00000000-0000-4000-9400-000000000003' and preview='Your appeal was granted.'),
 'no-op grant never claims the appeal was granted');
select pg_temp.m3_check((select count(*)=3 from public.admin_audit_log
 where action='APPEAL_RESOLVED' and new_state->>'reversal_applied'='false'),
  'resolution audit records that no reversal applied');
set local role authenticated;
select pg_temp.m3_check((public.findback_staff_appeal(current_setting('m3b.deleted_appeal'))->>'change_applied')::boolean=false,
 'staff detail distinguishes granted no-op from actual reversal');
select pg_temp.m3_check((select count(*)=3 from jsonb_array_elements(public.findback_staff_appeals('RESOLVED')->'items') row
 where row->>'id' in(current_setting('m3b.deleted_appeal'),current_setting('m3b.drift_appeal'),current_setting('m3b.noaction_appeal'))
 and row->'change_applied'='false'::jsonb), 'staff history retains no-op outcome');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000003',true);
select pg_temp.m3_check((select count(*)=3 from jsonb_array_elements(public.findback_my_appeals()->'items') row
 where row->'change_applied'='false'::jsonb and row->>'decision'='GRANTED'),
 'consumer receipts distinguish all three no-op grants');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000004',true);
select pg_temp.m3_check((select count(*)=1 from jsonb_array_elements(public.findback_my_appeals()->'items') row
 where row->>'id'=current_setting('m3b.appeal') and row->'change_applied'='true'::jsonb),
 'consumer receipt records real reversal without disclosing audit text');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9400-000000000002',true);
reset role;
delete from public.user_role_capabilities where user_id='00000000-0000-4000-9400-000000000002';
set local role authenticated;
do $$ begin
 begin perform public.findback_resolve_appeal(current_setting('m3b.appeal'),'DENIED','Revoked role');
  raise exception 'M3 BOUNDARY FAILED: revoked capability executable' using errcode='0A000';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'M3 canonical reversal/null result/deletion/drift/revocation boundaries verified' as probe;
rollback;
