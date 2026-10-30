-- M3 same-app staff readers and feedback state writer; no new role, table grant
-- or admin application. Real RED: verify_beta_m3_staff.sql invokes missing RPCs.
begin;

create function public.findback_check_staff_cursor(p_time text,p_id text)
returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if (p_time is null)<>(p_id is null) or (p_id is not null and (btrim(p_id)='' or btrim(p_id)<>p_id)) then
  raise exception 'Invalid staff cursor' using errcode='22023';
 end if;
 if p_time is not null then
  if p_time !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
   raise exception 'Invalid staff cursor' using errcode='22023';
  end if;
  begin perform p_time::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
   raise exception 'Invalid staff cursor' using errcode='22023';
  end;
 end if;
end $$;
revoke all on function public.findback_check_staff_cursor(text,text) from public,anon,authenticated,service_role;

create function public.findback_staff_appeals(
 p_status text default null,p_limit integer default 25,p_before_submitted_at text default null,p_before_id text default null
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_limit integer:=least(greatest(coalesce(p_limit,25),1),100); v_result jsonb;
begin
 if not public.findback_can('appeals_review') then raise exception 'You may not review appeals' using errcode='42501'; end if;
 if p_status is not null and p_status not in ('SUBMITTED','UNDER_REVIEW','RESOLVED') then
  raise exception 'Invalid appeal filter' using errcode='22023';
 end if;
 perform public.findback_check_staff_cursor(p_before_submitted_at,p_before_id);
 with candidates as materialized (
  select a.id,a.subject_kind,a.subject_id,a.status,a.decision,a.submitted_at,a.resolved_at
  from public.appeals a where ((p_status is null and a.status in ('SUBMITTED','UNDER_REVIEW')) or a.status=p_status)
   -- The queue lists what this reviewer can actually act on. A sanctioned
   -- moderator keeps appeals_review, so their own appeal would otherwise appear
   -- as an actionable row whose Grant/Deny can only fail closed.
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

create function public.findback_staff_appeal(p_appeal_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.appeals%rowtype; l public.admin_audit_log%rowtype;
 v_case_type text; v_case_id text; v_action jsonb; v_evidence jsonb;
begin
 if not public.findback_can('appeals_review') then raise exception 'You may not review appeals' using errcode='42501'; end if;
 if p_appeal_id is null or btrim(p_appeal_id)='' or btrim(p_appeal_id)<>p_appeal_id then
  raise exception 'Choose an appeal' using errcode='22023';
 end if;
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
 -- Bounded case evidence, not live mutable content. Expired snapshots are never
 -- disclosed even if the erasure sweep has not yet run. No reporter identity.
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
  'expires_at',to_char(a.expires_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'appellant_user_id',a.appellant_user_id,'message',a.message,'reviewer_note',a.reviewer_note,
  'original_action',v_action,'evidence',v_evidence);
end $$;
revoke all on function public.findback_staff_appeal(text) from public,anon;
grant execute on function public.findback_staff_appeal(text) to authenticated;

create function public.findback_staff_feedback(
 p_status text default null,p_limit integer default 25,p_before_created_at text default null,p_before_id text default null
) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_limit integer:=least(greatest(coalesce(p_limit,25),1),100); v_result jsonb;
begin
 if not public.findback_can('feedback_read') then raise exception 'You may not review feedback' using errcode='42501'; end if;
 if p_status is not null and p_status not in ('NEW','REVIEWING','RESOLVED') then raise exception 'Invalid feedback filter' using errcode='22023'; end if;
 perform public.findback_check_staff_cursor(p_before_created_at,p_before_id);
 with candidates as materialized (
  select f.id,f.category,f.status,f.created_at,f.updated_at from public.feedback f
  where ((p_status is null and f.status in ('NEW','REVIEWING')) or f.status=p_status)
   and (p_before_created_at is null or (f.created_at,f.id)<(p_before_created_at,p_before_id))
  order by f.created_at desc,f.id desc limit v_limit+1
 ), page as materialized (
  select * from candidates order by created_at desc,id desc limit v_limit
 ) select jsonb_build_object(
  'items',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id desc) from page p),'[]'::jsonb),
  'next_cursor',case when (select count(*) from candidates)>v_limit then
   (select jsonb_build_object('created_at',p.created_at,'id',p.id) from page p order by p.created_at,p.id limit 1) else null end
 ) into v_result;
 return v_result;
end $$;
revoke all on function public.findback_staff_feedback(text,integer,text,text) from public,anon;
grant execute on function public.findback_staff_feedback(text,integer,text,text) to authenticated;

create function public.findback_staff_feedback_detail(p_feedback_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not public.findback_can('feedback_read') then raise exception 'You may not review feedback' using errcode='42501'; end if;
 if p_feedback_id is null or btrim(p_feedback_id)='' or btrim(p_feedback_id)<>p_feedback_id then
  raise exception 'Choose feedback to review' using errcode='22023';
 end if;
 select jsonb_build_object('id',f.id,'category',f.category,'status',f.status,'created_at',f.created_at,
  'updated_at',f.updated_at,'message',f.message,'technical_context',f.technical_context,'admin_note',f.admin_note)
 into result from public.feedback f where f.id=p_feedback_id;
 if result is null then raise exception 'Feedback unavailable' using errcode='P0002'; end if;
 return result;
end $$;
revoke all on function public.findback_staff_feedback_detail(text) from public,anon;
grant execute on function public.findback_staff_feedback_detail(text) to authenticated;

create function public.findback_review_feedback(p_feedback_id text,p_status text,p_expected_status text,p_admin_note text default null)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare f public.feedback%rowtype; v_note text:=nullif(btrim(p_admin_note),''); v_now text;
begin
 if not public.findback_can('feedback_read') then raise exception 'You may not review feedback' using errcode='42501'; end if;
 if p_feedback_id is null or btrim(p_feedback_id)='' or btrim(p_feedback_id)<>p_feedback_id
  or p_status is null or p_status not in ('NEW','REVIEWING','RESOLVED')
  or p_expected_status is null or p_expected_status not in ('NEW','REVIEWING','RESOLVED')
  or char_length(coalesce(v_note,''))>2000 then raise exception 'Invalid feedback review' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(20261022143000);
 if not public.findback_can('feedback_read') then raise exception 'You may not review feedback' using errcode='42501'; end if;
 select * into f from public.feedback where id=p_feedback_id for update;
 if not found then raise exception 'Feedback unavailable' using errcode='P0002'; end if;
 if f.status<>p_expected_status then raise exception 'FEEDBACK_CHANGED' using errcode='P0001'; end if;
 if f.status=p_status then return; end if;
 if p_status='NEW' then raise exception 'Feedback cannot return to New' using errcode='22023'; end if;
 v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 update public.feedback set status=p_status,admin_note=v_note,updated_at=v_now where id=f.id;
 -- Durable audit deliberately excludes message, technical context and note:
 -- all support text is deleted with the account, never copied into safety logs.
 perform public.findback_write_audit('FEEDBACK_REVIEWED','FEEDBACK',f.id,'STAFF_REVIEW',
  jsonb_build_object('status',f.status),jsonb_build_object('status',p_status));
end $$;
revoke all on function public.findback_review_feedback(text,text,text,text) from public,anon;
grant execute on function public.findback_review_feedback(text,text,text,text) to authenticated;

-- Length bounds alone cannot keep token-like input out of the optional scalars.
-- Keep the existing named-scalar writer/rate limit and opt-in; reconstruct only
-- known values at the table boundary, including privileged direct INSERTs.
create function public.findback_sanitize_feedback_context()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare c jsonb:=new.technical_context; v_version text:=c->>'app_version'; v_platform text:=c->>'platform';
 v_screen text:=c->>'screen'; v_device text:=c->>'device_class';
begin
 if not new.include_technical_info or c is null then new.technical_context:=null; return new; end if;
 if v_version !~ '^\d{1,4}\.\d{1,4}\.\d{1,4}([+-][A-Za-z0-9.-]{1,24})?$' or char_length(v_version)>40 then v_version:=null; end if;
 if v_platform not in ('android','ios','web') then v_platform:=null; end if;
 if v_screen not in ('feedback','settings','settings/privacy','feed','search','chat','profile','my-reports','post-detail') then v_screen:=null; end if;
 if v_device not in ('phone','large screen','wide screen','tablet','desktop') then v_device:=null; end if;
 new.technical_context:=jsonb_strip_nulls(jsonb_build_object('captured_at',new.created_at,
  'app_version',v_version,'platform',v_platform,'screen',v_screen,'device_class',v_device));
 return new;
end $$;
revoke all on function public.findback_sanitize_feedback_context() from public,anon,authenticated,service_role;
create trigger feedback_sanitize_context before insert or update of technical_context,include_technical_info
 on public.feedback for each row execute function public.findback_sanitize_feedback_context();
-- Sanitize any historical context without retaining an extra copy. No messages
-- or notes are altered, and the public writer's column/argument grants stay put.
update public.feedback set technical_context=technical_context where technical_context is not null;

create index ix_appeals_staff_pending on public.appeals(submitted_at desc,id desc) where status in ('SUBMITTED','UNDER_REVIEW');
create index ix_feedback_staff_pending on public.feedback(created_at desc,id desc) where status in ('NEW','REVIEWING');
comment on function public.findback_staff_appeals(text,integer,text,text) is 'appeals_review-only bounded raw keyset queue. Default pending; explicit lifecycle history. No live-target dependency, consumer bypass or private text in list.';
comment on function public.findback_staff_appeal(text) is 'appeals_review-only appeal detail, original action and up to ten bounded case evidence snapshots. Expired evidence never disclosed, reporter identity excluded.';
comment on function public.findback_review_feedback(text,text,text,text) is 'feedback_read-authorized same-app reviewer; D1 reauthorization, row lock/expected-status conflict fence, one audit per actual transition. No personal feedback content copied into audit.';
commit;
