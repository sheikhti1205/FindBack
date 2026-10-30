-- M3 fix-forward for the deployed resolver/expiry placeholders. Real RED:
-- verify_beta_m3_appeals.sql hits undefined users.role on the authorized seam.
-- Preserve uppercase lifecycle, canonical capability/audit/notification models,
-- case finality, private evidence and report lifecycle. No applied SQL is edited.
begin;

alter table public.appeals add column decision text;
-- Do not invent the outcome of a historical RESOLVED appeal. Live preflight0;
-- abort on changed data rather than silently relabeling a prior resolution.
do $$ begin
 if exists(select 1 from public.appeals where status='RESOLVED') then
  raise exception 'M3 unresolved historical appeal outcome requires reconciliation' using errcode='P0001';
 end if;
end $$;
alter table public.appeals add constraint appeals_decision_check check (
 (status in ('SUBMITTED','UNDER_REVIEW') and decision is null and resolved_at is null)
 or (status='RESOLVED' and decision is not null and decision in ('GRANTED','DENIED','EXPIRED') and resolved_at is not null)
);
-- Resolution now actually records the reviewer. This is a live identity
-- pointer, not the immutable safety subject: delete the link, retain outcome,
-- reason and audit. Real retention RED previously left a deleted reviewer id.
alter table public.appeals add constraint appeals_resolved_by_user_fk
 foreign key(resolved_by) references public.users(id) on delete set null;
comment on column public.appeals.resolved_by is 'Nullable live reviewer pointer; anonymized with account deletion. Durable appeal result/reason and separate audit stay private and retained.';

-- Role changes/deletion use D1. Take it before lifecycle/case/row locks and
-- reauthorize after acquisition. Never consult a nonexistent users.role column.
create function public.findback_lock_appeal_case(p_appeal_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_type text; v_id text;
begin
 select d.target_type,d.target_id into v_type,v_id
 from public.moderation_case_decisions d join public.appeals a on a.id=p_appeal_id
 where (a.subject_kind='MODERATION_ACTION' and d.audit_id=a.subject_id)
    or (a.subject_kind='SANCTION' and d.sanction_id=a.subject_id)
 limit 1;
 if v_type is not null then
  perform pg_advisory_xact_lock(hashtextextended('findback_moderation:'||v_type||':'||v_id,0));
 end if;
end $$;
revoke all on function public.findback_lock_appeal_case(text) from public,anon,authenticated,service_role;

-- Existing canonical reversal entry, now private and implemented. Only the
-- resolver calls it after authorization/serialization. An old appeal may revoke
-- its own still-effective sanction, but never undo a newer visibility decision.
create or replace function public.findback_reverse_appeal_action(p_appeal_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
 a public.appeals%rowtype; l public.admin_audit_log%rowtype;
 d public.moderation_case_decisions%rowtype; s public.account_sanctions%rowtype;
 v_sanction text; v_before text; v_after text; v_action text;
 v_audit text:=gen_random_uuid()::text;
 v_now text:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_changed boolean:=false;
begin
 select * into a from public.appeals where id=p_appeal_id;
 if a.subject_kind='SANCTION' then
  v_sanction:=a.sanction_id;
 else
  select * into l from public.admin_audit_log where id=a.moderation_action_id;
  if l.target_type='USER' and l.action in ('WARN','PROBATION','RESTRICT_POSTING','SUSPEND','BAN') then
   select id into v_sanction from public.account_sanctions
    where id=l.new_state->>'sanction_id' and user_id=l.target_id and kind=l.new_state->>'kind';
  end if;
 end if;
 if v_sanction is not null then
  select * into s from public.account_sanctions where id=v_sanction for update;
  if s.active and s.revoked_at is null then
   update public.account_sanctions set active=false,revoked_at=v_now,revoked_by=auth.uid()::text where id=s.id;
   insert into public.admin_audit_log(id,actor_user_id,action,target_type,target_id,reason,previous_state,new_state,created_at)
   values(v_audit,auth.uid()::text,'NO_ACTION','USER',s.user_id,'APPEAL_GRANTED',
    jsonb_build_object('sanction_id',s.id,'active',true),
    jsonb_build_object('sanction_id',s.id,'active',false,'appeal_id',a.id),v_now);
   select * into d from public.moderation_case_decisions where target_type='USER' and target_id=s.user_id for update;
   v_changed:=d.sanction_id=s.id;
  end if;
 elsif l.target_type in ('POST','COMMENT') and l.action in ('HIDE','REMOVE') then
  select * into d from public.moderation_case_decisions
   where target_type=l.target_type and target_id=l.target_id for update;
  if d.audit_id=l.id then
   v_after:=l.previous_state->>'moderation_visibility';
   if v_after is null or v_after not in ('PUBLISHED','PENDING_REVIEW','HIDDEN','REMOVED') then
    raise exception 'Appeal original state unavailable' using errcode='P0002';
   end if;
   if l.target_type='POST' then
    select moderation_visibility into v_before from public.item_posts where id=l.target_id for update;
    if found and v_before=l.new_state->>'moderation_visibility' then
     update public.item_posts set moderation_visibility=v_after where id=l.target_id;
     v_changed:=true;
    end if;
   else
    select moderation_visibility into v_before from public.comments where id=l.target_id for update;
    if found and v_before=l.new_state->>'moderation_visibility' then
     update public.comments set moderation_visibility=v_after where id=l.target_id;
     v_changed:=true;
    end if;
   end if;
   if v_changed then
    v_action:=case v_after when 'PUBLISHED' then 'PUBLISH' when 'HIDDEN' then 'HIDE' when 'REMOVED' then 'REMOVE' else 'NO_ACTION' end;
    insert into public.admin_audit_log(id,actor_user_id,action,target_type,target_id,reason,previous_state,new_state,created_at)
    values(v_audit,auth.uid()::text,v_action,l.target_type,l.target_id,'APPEAL_GRANTED',
     jsonb_build_object('moderation_visibility',v_before),
     jsonb_build_object('moderation_visibility',v_after,'appeal_id',a.id,'decision_generation',d.generation+1),v_now);
   end if;
  end if;
 end if;
 if v_changed then
  insert into public.moderation_case_audits(audit_id,case_type,case_id,created_at)
   values(v_audit,d.target_type,d.target_id,v_now);
  update public.moderation_case_decisions set generation=generation+1,
   decider_user_id=auth.uid()::text,decision_action=coalesce(v_action,'NO_ACTION'),audit_id=v_audit,
   sanction_id=null,decided_at=v_now,reopened_at=null,reopened_by_appeal_id=null
   where target_type=d.target_type and target_id=d.target_id;
 end if;
end $$;
revoke all on function public.findback_reverse_appeal_action(text) from public,anon,authenticated,service_role;

-- Transfer/clear the re-evaluation marker for the case an appeal belongs to.
-- Derive the case from the appeal's DURABLE subject association, never from
-- moderation_case_decisions.reopened_by_appeal_id: a granted reversal rewrites
-- that row (new audit_id, sanction_id=null) before this runs, so the old filter
-- matched nothing and a still-open sibling appeal silently lost the marker while
-- the case read final. moderation_case_audits survives every rewrite; a sanction
-- appeal resolves its case through the sanction's owner.
create function public.findback_close_appeal_reopening(p_appeal_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_type text; v_id text; v_pending text;
 v_now text:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
 select ca.case_type,ca.case_id into v_type,v_id
 from public.appeals a join public.moderation_case_audits ca on ca.audit_id=a.subject_id
 where a.id=p_appeal_id and a.subject_kind='MODERATION_ACTION' limit 1;
 if v_type is null then
  select 'USER',s.user_id into v_type,v_id
  from public.appeals a join public.account_sanctions s on s.id=a.sanction_id
  where a.id=p_appeal_id and a.subject_kind='SANCTION' limit 1;
 end if;
 if v_type is null then return; end if;

 -- Next still-open appeal about the SAME case, through either subject identity.
 select a.id into v_pending from public.appeals a
 where a.status in ('SUBMITTED','UNDER_REVIEW') and a.id<>p_appeal_id and (
  (a.subject_kind='MODERATION_ACTION' and exists(
    select 1 from public.moderation_case_audits ca
    where ca.audit_id=a.subject_id and ca.case_type=v_type and ca.case_id=v_id))
  or (a.subject_kind='SANCTION' and v_type='USER' and exists(
    select 1 from public.account_sanctions s where s.id=a.sanction_id and s.user_id=v_id))
 ) order by a.submitted_at,a.id limit 1;

 if v_pending is null then
  update public.moderation_case_decisions set reopened_by_appeal_id=null,reopened_at=null
   where target_type=v_type and target_id=v_id;
 else
  update public.moderation_case_decisions set reopened_by_appeal_id=v_pending,
   reopened_at=coalesce(reopened_at,v_now) where target_type=v_type and target_id=v_id;
 end if;
end $$;
revoke all on function public.findback_close_appeal_reopening(text) from public,anon,authenticated,service_role;

create or replace function public.findback_resolve_appeal(p_appeal_id text,p_decision text,p_reviewer_note text default null)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a public.appeals%rowtype;
 v_note text:=nullif(btrim(p_reviewer_note),'');
 v_now text; v_applied boolean:=false;
begin
 if auth.uid() is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if not public.findback_can('appeals_review') then raise exception 'You may not review appeals' using errcode='42501'; end if;
 if p_appeal_id is null or btrim(p_appeal_id)='' or p_appeal_id<>btrim(p_appeal_id)
   or p_decision is null or p_decision not in ('GRANTED','DENIED')
   or v_note is null or char_length(v_note)>2000 then
  raise exception 'An appeal, decision and review reason are required' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(20261022143000);
 if not public.findback_can('appeals_review') then raise exception 'You may not review appeals' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(20261029060000);
 perform public.findback_lock_appeal_case(p_appeal_id);
 select * into a from public.appeals where id=p_appeal_id for update;
 if not found then raise exception 'Appeal unavailable' using errcode='P0002'; end if;
 -- A sanction does not revoke roles, so the appellant may still hold
 -- appeals_review. Nobody may decide their own appeal: that would lift their own
 -- sanction and, through the reversal, make them the final owner of the case
 -- about themselves (MODERATION_DECISION_FINAL then blocks any other staff).
 -- Only the appellant is compared, and only after the caller already passed the
 -- capability check, so no id exists as an enumeration oracle here.
 if a.appellant_user_id is not null and a.appellant_user_id=auth.uid()::text then
  raise exception 'You may not review your own appeal' using errcode='42501';
 end if;
 if a.status='RESOLVED' then raise exception 'APPEAL_ALREADY_RESOLVED' using errcode='P0001'; end if;
 if a.expires_at<=clock_timestamp() then raise exception 'APPEAL_EXPIRED' using errcode='P0001'; end if;
 if p_decision='GRANTED' then
  perform public.findback_reverse_appeal_action(a.id);
  -- The reversal writes reason APPEAL_GRANTED with this appeal id only when it
  -- actually restored/revoked something. The durable record lets the outcome
  -- trigger tell a real grant from a no-op against a superseded/deleted/already
  -- reversed target instead of claiming a change that never happened.
  v_applied:=exists(select 1 from public.admin_audit_log
   where reason='APPEAL_GRANTED' and new_state->>'appeal_id'=a.id);
 end if;
 v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 update public.appeals set status='RESOLVED',decision=p_decision,resolved_at=v_now,
  resolved_by=auth.uid()::text,reviewer_note=v_note where id=a.id;
 perform public.findback_write_audit('APPEAL_RESOLVED','APPEAL',a.id,v_note,
  jsonb_build_object('status',a.status),
  jsonb_build_object('status','RESOLVED','decision',p_decision,'reversal_applied',v_applied));
 perform public.findback_close_appeal_reopening(a.id);
end $$;
revoke all on function public.findback_resolve_appeal(text,text,text) from public,anon,authenticated;
grant execute on function public.findback_resolve_appeal(text,text,text) to authenticated;

-- Moderation outcomes are events, not a lifetime null-target row. Existing
-- visibility/block guards and other types' dedupe remain unchanged.
create or replace function public.findback_insert_notification(
 p_user_id text,p_actor_id text,p_type text,p_post_id text,p_comment_id text,p_preview text,p_reaction_kind text default null
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_now text:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
 if p_user_id is null or p_user_id=p_actor_id then return; end if;
 if p_actor_id is null and p_type not in ('STATUS','MODERATION') then return; end if;
 if p_post_id is not null and not public.findback_can_read_post_for(p_post_id,p_user_id) then return; end if;
 if p_comment_id is not null and (not public.findback_can_read_comment_for(p_comment_id,p_user_id)
  or not exists(select 1 from public.comments c where c.id=p_comment_id and c.post_id=p_post_id)) then return; end if;
 if p_actor_id is not null and public.findback_is_blocked_pair(p_user_id,p_actor_id) then return; end if;
 if p_comment_id is null and p_type<>'STATUS' and not(p_type='MODERATION' and p_actor_id is null) and exists(
  select 1 from public.notifications n where n.user_id=p_user_id and n.actor_id is not distinct from p_actor_id
   and n.type=p_type and n.post_id is not distinct from p_post_id and n.comment_id is null and n.deleted_at is null
   and (p_type<>'REACTION' or n.reaction_kind is not distinct from p_reaction_kind)
 ) then return; end if;
 insert into public.notifications(id,user_id,actor_id,type,post_id,comment_id,preview,read,created_at,deleted_at,reaction_kind)
 values(gen_random_uuid()::text,p_user_id,p_actor_id,p_type,p_post_id,p_comment_id,left(nullif(p_preview,''),200),0,v_now,null,p_reaction_kind);
end $$;
revoke all on function public.findback_insert_notification(text,text,text,text,text,text,text) from public,anon,authenticated;

create or replace function public.findback_notify_appeal_resolved()
returns trigger language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_inserted text; v_type text; v_applied boolean;
begin
 if new.status='RESOLVED' and old.status<>'RESOLVED' and new.appellant_user_id is not null then
  v_type:=case new.decision when 'EXPIRED' then 'appeal_expired' else 'appeal_resolved' end;
  -- "Granted" is only true when the reversal actually applied. A grant against a
  -- superseded, deleted, already-reversed or drifted target restores nothing, so
  -- the appellant must not be told their appeal changed the outcome.
  v_applied:=new.decision='GRANTED' and exists(
   select 1 from public.admin_audit_log where reason='APPEAL_GRANTED'
    and new_state->>'appeal_id'=new.id);
  insert into public.appeal_notifications(appeal_id,recipient_id,notification_type)
   values(new.id,new.appellant_user_id,v_type)
   on conflict(appeal_id,recipient_id,notification_type) do nothing returning id into v_inserted;
  if v_inserted is not null then
   perform public.findback_insert_notification(new.appellant_user_id,null,'MODERATION',null,null,
    case new.decision when 'GRANTED' then
      case when v_applied then 'Your appeal was granted.'
       else 'Your appeal was reviewed. No further change was applied.' end
     when 'DENIED' then 'Your appeal was denied.'
     else 'Your appeal expired before it could be reviewed. You can submit a new appeal.' end);
  end if;
 end if;
 return new;
end $$;
revoke all on function public.findback_notify_appeal_resolved() from public,anon,authenticated,service_role;

create or replace function public.findback_expire_stale_appeals()
returns integer language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_id text; a public.appeals%rowtype; v_count integer:=0; v_now text;
begin
 perform pg_advisory_xact_lock(20261022143000);
 perform pg_advisory_xact_lock(20261029060000);
 for v_id in select id from public.appeals where status in ('SUBMITTED','UNDER_REVIEW')
  and expires_at<=clock_timestamp() order by id limit 100 loop
  perform public.findback_lock_appeal_case(v_id);
  select * into a from public.appeals where id=v_id for update;
  if a.status='RESOLVED' or a.expires_at>clock_timestamp() then continue; end if;
  v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  update public.appeals set status='RESOLVED',decision='EXPIRED',resolved_at=v_now,
   resolved_by=null,reviewer_note=null where id=v_id;
  insert into public.admin_audit_log(id,actor_user_id,action,target_type,target_id,reason,previous_state,new_state,created_at)
  values(gen_random_uuid()::text,null,'APPEAL_EXPIRED','APPEAL',v_id,null,
   jsonb_build_object('status',a.status),jsonb_build_object('status','RESOLVED','decision','EXPIRED'),v_now);
  perform public.findback_close_appeal_reopening(v_id);
  v_count:=v_count+1;
 end loop;
 return v_count;
end $$;
revoke all on function public.findback_expire_stale_appeals() from public,anon,authenticated;
grant execute on function public.findback_expire_stale_appeals() to service_role;

-- Preserve strict owner/cursor/raw keyset behavior. Only a RESOLVED receipt
-- gains its safe decision; pending receipts remain the same six-field shape.
-- Full replacement (not rename+wrap): the chain keeps exactly one declaration of
-- this signature, so static ACL/EXECUTE guards can resolve every statement.
create or replace function public.findback_my_appeals(
 p_limit integer default 50,p_before_submitted_at text default null,p_before_id text default null
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
 v_limit integer:=least(greatest(coalesce(p_limit,50),1),100);
 v_result jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if (p_before_submitted_at is null)<>(p_before_id is null)
    or (p_before_id is not null and (btrim(p_before_id)='' or btrim(p_before_id)<>p_before_id)) then
  raise exception 'Invalid appeal cursor' using errcode='22023';
 end if;
 if p_before_submitted_at is not null then
  if p_before_submitted_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
   raise exception 'Invalid appeal cursor' using errcode='22023';
  end if;
  begin perform p_before_submitted_at::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
   raise exception 'Invalid appeal cursor' using errcode='22023'; end;
 end if;
 -- The durable receipt does NOT join the live target or a current decision.
 -- Identity remains useful after FK SET NULL; appellant NULL matches nobody.
 with candidates as materialized (
  select a.id,a.subject_kind,a.subject_id,a.status,a.submitted_at,a.resolved_at,
   case when a.status='RESOLVED' then a.decision else null end as decision
  from public.appeals a
  where a.appellant_user_id=v_uid
   and (p_before_submitted_at is null or (a.submitted_at,a.id)<(p_before_submitted_at,p_before_id))
  order by a.submitted_at desc,a.id desc limit v_limit+1
 ), page as materialized (
  select * from candidates order by submitted_at desc,id desc limit v_limit
 ) select jsonb_build_object(
  'items',coalesce((select jsonb_agg(to_jsonb(p) order by p.submitted_at desc,p.id desc) from page p),'[]'::jsonb),
  'next_cursor',case when (select count(*) from candidates)>v_limit then
   (select jsonb_build_object('submitted_at',p.submitted_at,'id',p.id) from page p order by p.submitted_at,p.id limit 1)
   else null end
 ) into v_result;
 return v_result;
end $$;
revoke all on function public.findback_my_appeals(integer,text,text) from public,anon;
grant execute on function public.findback_my_appeals(integer,text,text) to authenticated;
comment on function public.findback_my_appeals(integer,text,text) is 'Owner-only durable appeal receipt pages. Safe identity/status/time fields plus a decision only on a RESOLVED receipt; no staff identity, note, message or live-target dependency. Raw keyset continuation survives client filtering. No owner parameter or staff bypass.';

comment on table public.appeals is 'Durable safety appeals. Uppercase lifecycle; safe GRANTED/DENIED/EXPIRED result on resolution. Appellant/target pointers anonymize on deletion; private message/reviewer note never appear in consumer readers.';
comment on function public.findback_resolve_appeal(text,text,text) is 'Canonical appeals_review-authorized atomic resolver. D1/lifecycle/case/row ordering and reauthorization; required reason; refuses self-review; one APPEAL_RESOLVED resolution audit plus, only for a real grant, the reversal state-change audit; exactly one inbox outcome; exact original reversal only, never a newer visibility decision or report lifecycle; a no-op grant is reported honestly, not as a change.';
comment on function public.findback_reverse_appeal_action(text) is 'Private resolver delegate, no client execute. Restores exact original content state only while its case audit remains current; independently revokes only the appealed sanction; records state-change audit and final case generation.';
comment on function public.findback_expire_stale_appeals() is 'Internal30day expiry: same serialization as resolver; RESOLVED/EXPIRED, system audit and own generic inbox result, no reversal. Consumer execute denied.';
commit;
