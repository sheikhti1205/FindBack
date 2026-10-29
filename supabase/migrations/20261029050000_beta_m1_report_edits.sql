-- Forward-only guard shared by the invoker edit RPC and direct column grants.
-- RED: verify_beta_m1_type_edits.sql. Does not lock a peer report from a row
-- trigger; the updated report is already locked before relationship rows.
begin;
alter table public.report_matches drop constraint report_matches_cancel_reason_check;
alter table public.report_matches add constraint report_matches_cancel_reason_check
  check(cancel_reason is null or cancel_reason in
    ('USER_CANCELLED','SUPERSEDED_BY_CONFIRMED','REPORT_CHANGED'));

create or replace function public.findback_guard_report_edit()
returns trigger language plpgsql volatile security definer
set search_path = public, pg_temp as $$
begin
  if new.type is distinct from old.type then
    if exists(select 1 from public.successful_returns r
               where r.lost_post_id=old.id or r.found_post_id=old.id) then
      raise exception 'A recovered report cannot change type' using errcode='P0001';
    end if;
    if exists(select 1 from public.report_matches m where m.status='CONFIRMED'
               and (m.lost_report_id=old.id or m.found_report_id=old.id)) then
      raise exception 'Cancel the match before changing this report type' using errcode='P0001';
    end if;
  end if;
  if new.type is distinct from old.type
     or (new.status is distinct from old.status and new.status<>'OPEN') then
    -- A pending proposal does not freeze editing/closing a report. End that
    -- attempt instead; reopening later must not reactivate obsolete consent.
    perform 1 from public.report_matches m where m.status='PENDING'
      and (m.lost_report_id=old.id or m.found_report_id=old.id) order by m.id for update;
    update public.report_matches set status='CANCELLED',cancel_reason='REPORT_CHANGED',
      cancelled_at=clock_timestamp(),cancelled_by=null
      where status='PENDING' and (lost_report_id=old.id or found_report_id=old.id);
  end if;
  return new;
end $$;
revoke all on function public.findback_guard_report_edit() from public,anon,authenticated,service_role;
create trigger trg_item_posts_match_edit_guard before update of type,status on public.item_posts
  for each row execute function public.findback_guard_report_edit();
comment on function public.findback_guard_report_edit() is
  'All-writer relationship type guard. Confirmed/recovered reports cannot change type. Type changes and non-OPEN transitions invalidate pending consent without acquiring any peer report lock.';
commit;
