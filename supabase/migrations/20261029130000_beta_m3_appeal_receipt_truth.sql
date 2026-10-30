-- M3 audit repair, fix-forward: a granted review is not necessarily a reversal.
-- Preserve the adjudication, expose one safe fact from the existing reversal
-- audit, never staff notes/identities. No applied migration is modified.
begin;

create or replace function public.findback_my_appeals(
 p_limit integer default 50,p_before_submitted_at text default null,p_before_id text default null
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
 v_limit integer:=least(greatest(coalesce(p_limit,50),1),100); v_result jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if (p_before_submitted_at is null)<>(p_before_id is null)
    or (p_before_id is not null and (btrim(p_before_id)='' or btrim(p_before_id)<>p_before_id)) then
  raise exception 'Invalid appeal cursor' using errcode='22023';
 end if;
 if p_before_submitted_at is not null then
  if p_before_submitted_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
   raise exception 'Invalid appeal cursor' using errcode='22023'; end if;
  begin perform p_before_submitted_at::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
   raise exception 'Invalid appeal cursor' using errcode='22023'; end;
 end if;
 with candidates as materialized (
  select a.id,a.subject_kind,a.subject_id,a.status,a.submitted_at,a.resolved_at,
   case when a.status='RESOLVED' then a.decision else null end as decision,
   case when a.status='RESOLVED' and a.decision='GRANTED' then exists(
    select 1 from public.admin_audit_log l where l.reason='APPEAL_GRANTED'
     and l.new_state->>'appeal_id'=a.id) else null end as change_applied
  from public.appeals a where a.appellant_user_id=v_uid
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

create or replace function public.findback_staff_appeals(
 p_status text default null,p_limit integer default 25,p_before_submitted_at text default null,p_before_id text default null
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_limit integer:=least(greatest(coalesce(p_limit,25),1),100); v_result jsonb;
begin
 if not public.findback_can('appeals_review') then raise exception 'You may not review appeals' using errcode='42501'; end if;
 if p_status is not null and p_status not in ('SUBMITTED','UNDER_REVIEW','RESOLVED') then
  raise exception 'Invalid appeal filter' using errcode='22023'; end if;
 perform public.findback_check_staff_cursor(p_before_submitted_at,p_before_id);
 with candidates as materialized (
  select a.id,a.subject_kind,a.subject_id,a.status,a.decision,a.submitted_at,a.resolved_at,
   case when a.status='RESOLVED' and a.decision='GRANTED' then exists(
    select 1 from public.admin_audit_log l where l.reason='APPEAL_GRANTED'
     and l.new_state->>'appeal_id'=a.id) else null end as change_applied
  from public.appeals a where ((p_status is null and a.status in ('SUBMITTED','UNDER_REVIEW')) or a.status=p_status)
   and a.appellant_user_id is distinct from auth.uid()::text
   and (p_before_submitted_at is null or (a.submitted_at,a.id)<(p_before_submitted_at,p_before_id))
  order by a.submitted_at desc,a.id desc limit v_limit+1
 ), page as materialized (
  select * from candidates order by submitted_at desc,id desc limit v_limit
 ) select jsonb_build_object(
  'items',coalesce((select jsonb_agg(to_jsonb(p) order by p.submitted_at desc,p.id desc) from page p),'[]'::jsonb),
  'next_cursor',case when (select count(*) from candidates)>v_limit then
   (select jsonb_build_object('submitted_at',p.submitted_at,'id',p.id) from page p order by p.submitted_at,p.id limit 1) else null end
 ) into v_result;
 return v_result;
end $$;
revoke all on function public.findback_staff_appeals(text,integer,text,text) from public,anon;
grant execute on function public.findback_staff_appeals(text,integer,text,text) to authenticated;

create or replace function public.findback_staff_appeal(p_appeal_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.appeals%rowtype; l public.admin_audit_log%rowtype;
 v_case_type text; v_case_id text; v_action jsonb; v_evidence jsonb;
begin
 if not public.findback_can('appeals_review') then raise exception 'You may not review appeals' using errcode='42501'; end if;
 if p_appeal_id is null or btrim(p_appeal_id)='' or btrim(p_appeal_id)<>p_appeal_id then
  raise exception 'Choose an appeal' using errcode='22023'; end if;
 select * into a from public.appeals where id=p_appeal_id;
 if not found then raise exception 'Appeal unavailable' using errcode='P0002'; end if;
 if a.subject_kind='MODERATION_ACTION' then
  select * into l from public.admin_audit_log where id=a.subject_id;
 else
  select * into l from public.admin_audit_log where target_type='USER'
   and new_state->>'sanction_id'=a.subject_id order by created_at,id limit 1;
 end if;
 if l.id is not null then
  select ca.case_type,ca.case_id into v_case_type,v_case_id from public.moderation_case_audits ca where ca.audit_id=l.id;
  v_action:=jsonb_build_object('id',l.id,'target_type',l.target_type,'target_id',l.target_id,
   'action',l.action,'reason',l.reason,'created_at',l.created_at,
   'previous_visibility',l.previous_state->>'moderation_visibility','next_visibility',l.new_state->>'moderation_visibility',
   'sanction_kind',l.new_state->>'kind','sanction_ends_at',l.new_state->>'ends_at');
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'reason',r.reason,
  'captured_at',r.evidence_captured_at,'expires_at',r.evidence_expires_at,
  'snapshot',case when r.evidence_erased_at is null and r.evidence_expires_at::timestamptz>now()
   then r.evidence_snapshot else null end) order by r.evidence_captured_at desc,r.id desc),'[]'::jsonb)
 into v_evidence from (
  select * from public.content_reports where case_type=v_case_type and case_id=v_case_id
  order by evidence_captured_at desc,id desc limit 10
 ) r;
 return jsonb_build_object('id',a.id,'subject_kind',a.subject_kind,'subject_id',a.subject_id,
  'status',a.status,'decision',a.decision,'submitted_at',a.submitted_at,'resolved_at',a.resolved_at,
  'change_applied',case when a.status='RESOLVED' and a.decision='GRANTED' then exists(
   select 1 from public.admin_audit_log al where al.reason='APPEAL_GRANTED'
    and al.new_state->>'appeal_id'=a.id) else null end,
  'expires_at',to_char(a.expires_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'appellant_user_id',a.appellant_user_id,'message',a.message,'reviewer_note',a.reviewer_note,
  'original_action',v_action,'evidence',v_evidence);
end $$;
revoke all on function public.findback_staff_appeal(text) from public,anon;
grant execute on function public.findback_staff_appeal(text) to authenticated;

comment on function public.findback_my_appeals(integer,text,text) is 'Owner-only durable receipt pages; safe identity/status/time/decision and nullable change_applied fact. No staff text/identity or live-target dependency; raw keyset continuation.';
commit;
