-- Bounded same-app staff data contracts, actually invoked as client roles.
begin;
create function pg_temp.m3_staff_assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'M3 STAFF FAILED: %',label; end if; end $$;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9500-'||lpad(n::text,12,'0'),'m3staff'||n,
 'm3staff'||n||'@example.invalid','+880195000000'||n,1,'2026-10-29T00:00:00Z','2026-10-29T00:00:00Z'
from generate_series(1,5)n;
insert into public.user_roles(user_id,role,granted_at) values
 ('00000000-0000-4000-9500-000000000001','ADMIN','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9500-000000000002','MODERATOR','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9500-000000000003','MODERATOR','2026-10-29T00:00:00Z');
insert into public.user_role_capabilities(user_id,capability,granted_at) values
 ('00000000-0000-4000-9500-000000000002','appeals_review','2026-10-29T00:00:00Z'),
 ('00000000-0000-4000-9500-000000000003','feedback_read','2026-10-29T00:00:00Z');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values('m3-staff-post','00000000-0000-4000-9500-000000000004','LOST','Synthetic staff case','Bounded fixture','Electronics','OPEN','2026-10-29','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9500-000000000005',true);
select public.findback_submit_report('POST','m3-staff-post','OTHER','Report fixture');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9500-000000000001',true);
select set_config('m3s.audit',public.findback_apply_moderation('POST','m3-staff-post','HIDE','OTHER','Original review'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9500-000000000004',true);
select set_config('m3s.appeal',public.findback_submit_appeal('MODERATION_ACTION',current_setting('m3s.audit'),'Please reconsider my fixture'),true);
select set_config('m3s.feedback',public.findback_submit_feedback('BUG','Synthetic feedback message',true,'0.9.0-beta.1','android','feedback','phone'),true);
set local role authenticated;
do $$ begin
 begin perform public.findback_staff_appeals(); raise exception 'M3 ordinary appeal queue allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_staff_appeal(current_setting('m3s.appeal')); raise exception 'M3 ordinary appeal detail allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_staff_appeal('missing'); raise exception 'M3 ordinary detail oracle' using errcode='0A000';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_staff_feedback(); raise exception 'M3 ordinary feedback queue allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_staff_feedback_detail(current_setting('m3s.feedback')); raise exception 'M3 ordinary feedback detail allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
 begin perform public.findback_review_feedback(current_setting('m3s.feedback'),'REVIEWING','NEW',null); raise exception 'M3 ordinary feedback write allowed' using errcode='0A000';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9500-000000000002',true);
select pg_temp.m3_staff_assert(public.findback_staff_appeals()->'items'->0->>'id'=current_setting('m3s.appeal'),'appeals-only moderator queue');
select pg_temp.m3_staff_assert(public.findback_staff_appeal(current_setting('m3s.appeal'))->>'message'='Please reconsider my fixture'
 and public.findback_staff_appeal(current_setting('m3s.appeal'))->'original_action'->>'action'='HIDE'
 and jsonb_array_length(public.findback_staff_appeal(current_setting('m3s.appeal'))->'evidence')=1,'original action/appellant/evidence detail without extra capability');
do $$ begin
 begin perform public.findback_staff_feedback(); raise exception 'M3 appeals cap reads feedback' using errcode='0A000'; exception when insufficient_privilege then null; end;
 begin perform public.findback_staff_appeals(null,1,'bad-time','id'); raise exception 'M3 bad appeal cursor accepted' using errcode='0A000'; exception when invalid_parameter_value then null; end;
 begin perform public.findback_staff_appeals('bad'); raise exception 'M3 bad appeal filter accepted' using errcode='0A000'; exception when invalid_parameter_value then null; end;
end $$;
select public.findback_resolve_appeal(current_setting('m3s.appeal'),'DENIED','Review decision stands');
select pg_temp.m3_staff_assert(jsonb_array_length(public.findback_staff_appeals()->'items')=0
 and public.findback_staff_appeals('RESOLVED')->'items'->0->>'decision'='DENIED','resolved leaves pending and remains in history');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9500-000000000003',true);
select pg_temp.m3_staff_assert(public.findback_staff_feedback()->'items'->0->>'id'=current_setting('m3s.feedback')
 and not(public.findback_staff_feedback()->'items'->0 ?| array['message','admin_note','technical_context','user_id']),'feedback queue minimal summary');
select pg_temp.m3_staff_assert(public.findback_staff_feedback_detail(current_setting('m3s.feedback'))->>'message'='Synthetic feedback message'
 and public.findback_staff_feedback_detail(current_setting('m3s.feedback'))->'technical_context'->>'screen'='feedback','feedback-only moderator detail');
do $$ begin
 begin perform public.findback_staff_appeals(); raise exception 'M3 feedback cap reads appeals' using errcode='0A000'; exception when insufficient_privilege then null; end;
 begin perform public.findback_review_feedback(current_setting('m3s.feedback'),null,'NEW',null); raise exception 'M3 null feedback status allowed' using errcode='0A000'; exception when invalid_parameter_value then null; end;
end $$;
select public.findback_review_feedback(current_setting('m3s.feedback'),'REVIEWING','NEW','Private triage note');
do $$ begin
 begin perform public.findback_review_feedback(current_setting('m3s.feedback'),'RESOLVED','NEW','Stale writer');
  raise exception 'M3 stale feedback writer allowed' using errcode='0A000';
 exception when sqlstate 'P0001' then if sqlerrm<>'FEEDBACK_CHANGED' then raise; end if; end;
end $$;
select public.findback_review_feedback(current_setting('m3s.feedback'),'RESOLVED','REVIEWING','Private resolution note');
select public.findback_review_feedback(current_setting('m3s.feedback'),'RESOLVED','RESOLVED','No-op retry');
reset role;
select pg_temp.m3_staff_assert((select status='RESOLVED' and admin_note='Private resolution note' from public.feedback where id=current_setting('m3s.feedback')),'status and private note atomically persist');
select pg_temp.m3_staff_assert((select count(*)=2 from public.admin_audit_log where action='FEEDBACK_REVIEWED' and target_id=current_setting('m3s.feedback')),'one audit per real feedback transition');
select pg_temp.m3_staff_assert(not exists(select 1 from public.admin_audit_log where target_id=current_setting('m3s.feedback')
 and (coalesce(reason,'')||coalesce(previous_state::text,'')||coalesce(new_state::text,''))~'Synthetic|Private|resolution note'),'no support text retained in audit');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9500-000000000004',true);
select pg_temp.m3_staff_assert((select status='RESOLVED' from public.feedback where id=current_setting('m3s.feedback')),'consumer receives updated own status only');
reset role;
delete from public.user_role_capabilities where user_id in ('00000000-0000-4000-9500-000000000002','00000000-0000-4000-9500-000000000003');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9500-000000000003',true);
do $$ begin
 begin perform public.findback_review_feedback(current_setting('m3s.feedback'),'REVIEWING','RESOLVED',null); raise exception 'M3 revoked writer allowed' using errcode='0A000'; exception when insufficient_privilege then null; end;
 begin perform public.findback_staff_feedback_detail(current_setting('m3s.feedback')); raise exception 'M3 revoked reader allowed' using errcode='0A000'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9500-000000000001',true);
delete from public.users where id='00000000-0000-4000-9500-000000000004';
select pg_temp.m3_staff_assert(not exists(select 1 from public.feedback where id=current_setting('m3s.feedback')),'feedback including note/context deletes with account');
select pg_temp.m3_staff_assert(public.findback_staff_appeal(current_setting('m3s.appeal'))->>'appellant_user_id' is null,'safety appeal retains only null live appellant pointer');
select 'M3 staff appeal/feedback authorization/write/privacy contracts verified' as probe;
rollback;
