-- Appeals resolver (CF-080): resolution, audit, notifications, reversal/expiry consistency.
-- Foundational migration. Full implementation requires admin UI and notification wiring.
begin;

-- 1. resolve_appeal RPC (staff-only)
create or replace function public.findback_resolve_appeal(
  p_appeal_id text,
  p_decision text,  -- 'GRANTED' or 'DENIED'
  p_reviewer_note text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_role text;
  v_appeal record;
  v_sanction record;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  -- Check staff role
  select role into v_role from public.users where id = v_uid;
  if v_role not in ('MODERATOR', 'ADMIN', 'OWNER') then
    raise exception 'Insufficient privileges' using errcode='42501';
  end if;

  if p_decision not in ('GRANTED', 'DENIED') then
    raise exception 'Invalid decision' using errcode='22023';
  end if;

  select * into v_appeal from public.appeals where id = p_appeal_id;
  if v_appeal is null then raise exception 'Appeal not found' using errcode='P0001'; end if;
  if v_appeal.status = 'RESOLVED' then raise exception 'Appeal already resolved' using errcode='P0001'; end if;

  -- Update appeal status
  update public.appeals
    set status = 'RESOLVED',
        resolved_at = clock_timestamp()::text,
        resolved_by = v_uid,
        reviewer_note = p_reviewer_note
    where id = p_appeal_id;

  -- If granted and subject is a sanction, revoke the sanction
  if p_decision = 'GRANTED' and v_appeal.subject_kind = 'SANCTION' and v_appeal.sanction_id is not null then
    update public.account_sanctions
      set active = false, revoked_at = clock_timestamp(), revoked_by = v_uid
      where id = v_appeal.sanction_id;
  end if;

  -- Audit log
  insert into public.admin_audit_log (actor_id, action, target_type, target_id, details)
  values (v_uid, 'APPEAL_RESOLVED', 'appeal', p_appeal_id,
    jsonb_build_object('decision', p_decision, 'subject_kind', v_appeal.subject_kind, 'subject_id', v_appeal.subject_id));
end;
$$;
revoke all on function public.findback_resolve_appeal(text,text,text) from public, anon, authenticated;
grant execute on function public.findback_resolve_appeal(text,text,text) to authenticated;

commit;