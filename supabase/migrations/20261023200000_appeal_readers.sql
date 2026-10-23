-- LIVE-PENDING. ADDITIVE ONLY: two owner-scoped reads; no table grants,
-- policies, writes, changes to existing outcomes, or consumer UI enablement.
-- Verification: supabase/tests/verify_20261023200000_appeal_readers.sql
-- Payload review is NOT hosted apply/readback or full appeals acceptance.
-- These subjects cover current adverse content decisions and effective own
-- sanctions. Historical/favorable action submissions keep their old contract.
-- Resolution, continuing hidden effects after NO_ACTION, legacy decisions and
-- affected-post-owner authority for comment actions remain follow-on work.
begin;

create or replace function public.findback_my_appeals(
  p_limit integer default 50,
  p_before_submitted_at text default null,
  p_before_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_limit integer := least(greatest(coalesce(p_limit,50),1),100);
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if (p_before_submitted_at is null) <> (p_before_id is null)
     or (p_before_id is not null and (btrim(p_before_id) = '' or btrim(p_before_id) <> p_before_id)) then
    raise exception 'Invalid appeal cursor' using errcode = '22023';
  end if;
  if p_before_submitted_at is not null then
    if p_before_submitted_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
      raise exception 'Invalid appeal cursor' using errcode = '22023';
    end if;
    begin
      perform p_before_submitted_at::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'Invalid appeal cursor' using errcode = '22023';
    end;
  end if;

  -- The durable receipt does NOT join the live target or a current decision.
  -- Identity remains useful after FK SET NULL; appellant NULL matches nobody.
  with candidates as materialized (
    select a.id,a.subject_kind,a.subject_id,a.status,a.submitted_at,a.resolved_at
    from public.appeals a
    where a.appellant_user_id = v_uid
      and (p_before_submitted_at is null or (a.submitted_at,a.id) < (p_before_submitted_at,p_before_id))
    order by a.submitted_at desc,a.id desc
    limit v_limit+1
  ), page as materialized (
    select * from candidates order by submitted_at desc,id desc limit v_limit
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by p.submitted_at desc,p.id desc) from page p),'[]'::jsonb),
    'next_cursor',case when (select count(*) from candidates)>v_limit then
      (select jsonb_build_object('submitted_at',p.submitted_at,'id',p.id) from page p order by p.submitted_at,p.id limit 1)
      else null end
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.findback_my_appeals(integer,text,text) from public,anon;
grant execute on function public.findback_my_appeals(integer,text,text) to authenticated;
comment on function public.findback_my_appeals(integer,text,text) is
  'Owner-only durable appeal receipt pages. Safe identity/status/time fields only, no staff identity, note, message or live-target dependency. Raw keyset continuation survives client filtering. No owner parameter or staff bypass.';

create or replace function public.findback_my_appeal_subjects(
  p_limit integer default 50,
  p_before_created_at text default null,
  p_before_subject_kind text default null,
  p_before_subject_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_limit integer := least(greatest(coalesce(p_limit,50),1),100);
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if num_nonnulls(p_before_created_at,p_before_subject_kind,p_before_subject_id) not in (0,3)
     or (p_before_subject_kind is not null and p_before_subject_kind not in ('SANCTION','MODERATION_ACTION'))
     or (p_before_subject_id is not null and (btrim(p_before_subject_id)='' or btrim(p_before_subject_id)<>p_before_subject_id)) then
    raise exception 'Invalid appeal cursor' using errcode = '22023';
  end if;
  if p_before_created_at is not null then
    if p_before_created_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
      raise exception 'Invalid appeal cursor' using errcode = '22023';
    end if;
    begin
      perform p_before_created_at::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'Invalid appeal cursor' using errcode = '22023';
    end;
  end if;

  with subjects as (
    -- Original AUDIT target ownership, identical to submission. A comment's
    -- canonical case is its post; that is NOT permission for the post owner.
    select 'MODERATION_ACTION'::text as subject_kind,l.id as subject_id,
           l.target_type,l.target_id,l.action,l.reason,l.created_at,
           (select a.id from public.appeals a
            where a.appellant_user_id=v_uid and a.subject_kind='MODERATION_ACTION'
              and a.subject_id=l.id and a.status in ('SUBMITTED','UNDER_REVIEW')
            order by a.submitted_at desc,a.id desc limit 1) as open_appeal_id
    from public.moderation_case_decisions d
    join public.admin_audit_log l on l.id=d.audit_id and l.action=d.decision_action
    where d.decision_action in ('HIDE','REMOVE') and (
      (l.target_type='POST' and exists(select 1 from public.item_posts p where p.id=l.target_id and p.user_id=v_uid))
      or (l.target_type='COMMENT' and exists(select 1 from public.comments c where c.id=l.target_id and c.user_id=v_uid))
    )
    union all
    -- Every effective sanction, not merely the newest or highest-precedence.
    -- Prefer its SANCTION identity instead of offering a duplicate audit alias.
    select 'SANCTION'::text,s.id,'USER'::text,s.user_id,
           case s.kind when 'WARNING' then 'WARN' when 'PROBATION' then 'PROBATION'
             when 'RESTRICTED' then 'RESTRICT_POSTING' when 'SUSPENDED' then 'SUSPEND' when 'BANNED' then 'BAN' end,
           s.reason_code,s.created_at,
           (select a.id from public.appeals a
            where a.appellant_user_id=v_uid and a.status in ('SUBMITTED','UNDER_REVIEW')
              and ((a.subject_kind='SANCTION' and a.subject_id=s.id)
                or (a.subject_kind='MODERATION_ACTION' and exists(
                  select 1 from public.admin_audit_log l where l.id=a.subject_id
                    and l.target_type='USER' and l.target_id=s.user_id
                    and l.new_state->>'sanction_id'=s.id and l.new_state->>'kind'=s.kind
                    and l.action=case s.kind when 'WARNING' then 'WARN' when 'PROBATION' then 'PROBATION'
                      when 'RESTRICTED' then 'RESTRICT_POSTING' when 'SUSPENDED' then 'SUSPEND' when 'BANNED' then 'BAN' end
                )))
            order by a.submitted_at desc,a.id desc limit 1)
    from public.account_sanctions s
    where s.user_id=v_uid and s.active and s.revoked_at is null
      and (nullif(btrim(s.starts_at),'') is null or nullif(btrim(s.starts_at),'')::timestamptz <= now())
      and (nullif(btrim(s.ends_at),'') is null or nullif(btrim(s.ends_at),'')::timestamptz > now())
  ), candidates as materialized (
    select * from subjects s
    where p_before_created_at is null or (s.created_at,s.subject_kind,s.subject_id)<(p_before_created_at,p_before_subject_kind,p_before_subject_id)
    order by s.created_at desc,s.subject_kind desc,s.subject_id desc limit v_limit+1
  ), page as materialized (
    select * from candidates order by created_at desc,subject_kind desc,subject_id desc limit v_limit
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc,p.subject_kind desc,p.subject_id desc) from page p),'[]'::jsonb),
    'next_cursor',case when (select count(*) from candidates)>v_limit then
      (select jsonb_build_object('created_at',p.created_at,'subject_kind',p.subject_kind,'subject_id',p.subject_id)
       from page p order by p.created_at,p.subject_kind,p.subject_id limit 1)
      else null end
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.findback_my_appeal_subjects(integer,text,text,text) from public,anon;
grant execute on function public.findback_my_appeal_subjects(integer,text,text,text) to authenticated;
comment on function public.findback_my_appeal_subjects(integer,text,text,text) is
  'Owner-only paged discovery of current adverse content audit subjects and all effective own sanctions. Original audit-target authority, never canonical case ownership. Explicit sanction audit aliases identify only own open receipts; no private audit fields are projected. Does not change submission eligibility, finality or resolve appeals.';
commit;
