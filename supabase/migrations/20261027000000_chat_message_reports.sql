-- Message reports retain only bounded evidence, never the ordinary chat body.
begin;
alter table public.content_reports drop constraint if exists content_reports_target_type_check;
alter table public.content_reports add constraint content_reports_target_type_check
  check (target_type in ('POST','COMMENT','USER','MESSAGE'));
alter table public.content_reports add column target_message_id text references public.chat_messages(id) on delete set null;
alter table public.content_reports drop constraint content_reports_target_shape_check;
alter table public.content_reports add constraint content_reports_target_shape_check check (
  (target_type='POST' and (target_post_id is null or target_post_id=target_id) and target_comment_id is null and target_user_id is null and target_message_id is null)
  or (target_type='COMMENT' and (target_comment_id is null or target_comment_id=target_id) and target_post_id is null and target_user_id is null and target_message_id is null)
  or (target_type='USER' and (target_user_id is null or target_user_id=target_id) and target_post_id is null and target_comment_id is null and target_message_id is null)
  or (target_type='MESSAGE' and (target_message_id is null or target_message_id=target_id) and target_post_id is null and target_comment_id is null and target_user_id is null)
);
create index content_reports_message_idx on public.content_reports(target_message_id) where target_type='MESSAGE';

create or replace function public.findback_guard_report_identity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_op='INSERT' then
  if (new.target_type='POST' and new.target_post_id is null)
    or (new.target_type='COMMENT' and new.target_comment_id is null)
    or (new.target_type='USER' and new.target_user_id is null)
    or (new.target_type='MESSAGE' and new.target_message_id is null) then
   raise exception 'A report needs its live target pointer' using errcode='23514';
  end if;
  return new;
 end if;
 if new.target_type is distinct from old.target_type or new.target_id is distinct from old.target_id then
  raise exception 'A report target identity is immutable' using errcode='42501';
 end if;
 if (new.target_post_id is distinct from old.target_post_id and new.target_post_id is not null)
   or (new.target_comment_id is distinct from old.target_comment_id and new.target_comment_id is not null)
   or (new.target_user_id is distinct from old.target_user_id and new.target_user_id is not null)
   or (new.target_message_id is distinct from old.target_message_id and new.target_message_id is not null) then
  raise exception 'A report target pointer cannot be set or repointed' using errcode='42501';
 end if;
 return new;
end $$;

-- A message is the receipt target; the server-derived author owns its existing
-- USER moderation case. No client-supplied author or case identifier is used.
create or replace function public.findback_set_report_case()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.target_type='MESSAGE' then
  select 'USER',m.sender_id into new.case_type,new.case_id from public.chat_messages m where m.id=new.target_id;
  if new.case_id is null then raise exception 'Report target unavailable' using errcode='P0002'; end if;
 else
  new.case_type:=new.target_type; new.case_id:=new.target_id;
 end if;
 return new;
end $$;

create function public.findback_submit_message_report(
 p_account_id text,p_message_id text,p_reason text,p_detail text,p_body text
) returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
 v_uid text:=auth.uid()::text; v_detail text:=nullif(btrim(coalesce(p_detail,'')),'');
 v_message public.chat_messages%rowtype; v_existing text; v_id text; v_now text;
 v_limit integer; v_burst integer; v_count integer; v_last text; v_snapshot jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 if p_message_id is null or btrim(p_message_id)='' then raise exception 'Report target unavailable' using errcode='P0002'; end if;
 if p_reason is null or p_reason<>all(public.findback_report_reasons()) then raise exception 'Unknown report reason' using errcode='22023'; end if;
 if char_length(v_detail)>2000 then raise exception 'Report detail is too long' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('findback_report:'||v_uid,0));
 -- A retry is a receipt lookup owned by this authenticated reporter, including
 -- after unsend or message unlinkage; it never changes captured evidence.
 select r.id into v_existing from public.content_reports r where r.reporter_user_id=v_uid
  and r.target_type='MESSAGE' and r.target_id=p_message_id;
 if v_existing is not null then return v_existing; end if;
 select m.* into v_message from public.chat_messages m
  join public.chat_conversations c on c.id=m.conversation_id
  join public.chat_message_audience a on a.message_id=m.id and a.user_id=v_uid
  where m.id=p_message_id and v_uid in(c.user_a,c.user_b) and m.sender_id in(c.user_a,c.user_b);
 if not found or p_body is null or length(p_body)>100000 or v_message.payload_digest is null
    or encode(sha256(convert_to(p_body,'UTF8')),'hex') is distinct from v_message.payload_digest then
  raise exception 'Report target unavailable' using errcode='P0002';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('findback_moderation:USER:'||v_message.sender_id,0));
 -- Recheck delivery provenance after the case lock; row deletion is serialized
 -- by the message FK on insert. Missing or changed identity fails closed.
 if not exists(select 1 from public.chat_messages m join public.chat_conversations c on c.id=m.conversation_id
  join public.chat_message_audience a on a.message_id=m.id and a.user_id=v_uid
  where m.id=p_message_id and m.sender_id=v_message.sender_id and v_uid in(c.user_a,c.user_b)
   and m.sender_id in(c.user_a,c.user_b) and m.payload_digest=v_message.payload_digest) then
  raise exception 'Report target unavailable' using errcode='P0002';
 end if;
 v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 select l.limit_per_day,l.burst_cooldown_seconds into v_limit,v_burst from public.findback_report_limit() l;
 select count(*),max(r.created_at) into v_count,v_last from public.content_reports r where r.reporter_user_id=v_uid
  and r.created_at>=to_char((clock_timestamp() at time zone 'utc')-interval '24 hours','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 if v_count>=v_limit or (v_last is not null and v_last>to_char((clock_timestamp() at time zone 'utc')-
  make_interval(secs=>v_burst),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) then
  raise exception 'REPORT_LIMIT_REACHED' using errcode='P0001';
 end if;
 v_snapshot:=jsonb_build_object('target_type','MESSAGE','body_excerpt',left(p_body,500),
  'event_sequence',v_message.event_sequence,'captured_at',v_now);
 insert into public.content_reports(id,reporter_user_id,target_type,target_id,target_message_id,
  reason,detail,status,evidence_snapshot,evidence_captured_at,evidence_expires_at,created_at,updated_at)
 values(gen_random_uuid()::text,v_uid,'MESSAGE',p_message_id,p_message_id,p_reason,v_detail,'OPEN',v_snapshot,v_now,
  to_char((clock_timestamp() at time zone 'utc')+interval '90 days','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),v_now,v_now)
 returning id into v_id;
 return v_id;
end $$;
revoke all on function public.findback_submit_message_report(text,text,text,text,text) from public,anon;
grant execute on function public.findback_submit_message_report(text,text,text,text,text) to authenticated;

-- Existing USER decisions close USER target reports, not MESSAGE targets that
-- share their case. Wrap the one decider under its same lock; include those
-- receipts in its existing decision atom, not a second moderation owner.
alter function public.findback_apply_moderation(text,text,text,text,text,text,text)
 rename to findback_apply_moderation_043_internal;
revoke all on function public.findback_apply_moderation_043_internal(text,text,text,text,text,text,text) from public,anon,authenticated,service_role;
create function public.findback_apply_moderation(
 p_target_type text,p_target_id text,p_action text,p_reason_code text,p_note text,
 p_sanction_kind text default null,p_sanction_ends_at text default null
) returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_audit text; v_closed text[]; v_now text;
begin
 if p_target_type='USER' and p_target_id is not null then
  perform pg_advisory_xact_lock(hashtextextended('findback_moderation:USER:'||p_target_id,0));
 end if;
 v_audit:=public.findback_apply_moderation_043_internal(p_target_type,p_target_id,p_action,p_reason_code,p_note,p_sanction_kind,p_sanction_ends_at);
 if p_target_type='USER' then
  v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  with closed as (
   update public.content_reports r set status=case when p_action='NO_ACTION' then 'DISMISSED' else 'ACTIONED' end,
    reviewed_by=auth.uid()::text,reviewed_at=v_now,updated_at=v_now,internal_note=p_note
   where r.case_type='USER' and r.case_id=p_target_id and r.target_type='MESSAGE'
    and r.status in ('OPEN','UNDER_REVIEW') returning r.id
  ) select coalesce(array_agg(id),'{}'::text[]) into v_closed from closed;
  update public.moderation_case_decisions d set closed_report_ids=d.closed_report_ids||v_closed
   where d.target_type='USER' and d.target_id=p_target_id and d.audit_id=v_audit;
 end if;
 return v_audit;
end $$;
revoke all on function public.findback_apply_moderation(text,text,text,text,text,text,text) from public,anon;
grant execute on function public.findback_apply_moderation(text,text,text,text,text,text,text) to authenticated;
commit;
