-- M1 acquisition-fence and bulk-write ordering. RED evidence is the real
-- PostgreSQL beta_m1_lock_order.test.mjs suite, not a source-text assertion.
--
-- The existing coarse deletion key now serializes report mutations and fence
-- acquisition, not just proposals. RPCs that explicitly prelock reports acquire
-- it FIRST (040000/070000 and the declared-helper/staff wrappers below). Direct
-- UPDATE and the invoker edit RPC acquire it at a BEFORE STATEMENT trigger,
-- before the executor can lock the first tuple in an arbitrary bulk plan.
-- A row trigger acquiring this key is too late and creates a deadlock.
--
-- This is a short, database-only beta critical section. No network request
-- holds it. It trades report-write parallelism for one unambiguous lock order:
-- D1 -> Storage/account714 (where required) -> lifecycle -> reports -> matches.
-- The applied deletion-admission function stays byte-for-byte on disk; its
-- fence INSERT takes the key through the same all-writer statement boundary.
begin;

create function public.findback_order_report_lifecycle_write()
returns trigger language plpgsql volatile security definer
set search_path=public,pg_temp as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  return null;
end $$;
revoke all on function public.findback_order_report_lifecycle_write()
  from public,anon,authenticated,service_role;
create trigger trg_item_posts_order_lifecycle_update
  before update on public.item_posts for each statement
  execute function public.findback_order_report_lifecycle_write();
create trigger trg_account_fences_order_lifecycle_write
  before insert or update on public.account_deletion_fences for each statement
  execute function public.findback_order_report_lifecycle_write();

-- D25 already locks a report before UPDATE. A private delegate preserves that
-- approved writer, helper vocabulary and invoker identity; the public entry
-- takes the lifecycle key BEFORE it, and denies new recovery for a fenced
-- caller or nominated FindBack helper. Cancellation remains usable while fenced.
alter function public.findback_mark_recovered(text,text,text)
  rename to findback_mark_recovered_declared_helper;
revoke all on function public.findback_mark_recovered_declared_helper(text,text,text)
  from public,anon,authenticated,service_role;
create function public.findback_mark_recovered(
  p_post_id text,p_helper_kind text,p_helper_user_id text default null
)
returns text language plpgsql volatile security definer
set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  if exists(select 1 from public.account_deletion_fences f
    where f.user_id=v_uid or (upper(btrim(coalesce(p_helper_kind,'')))='FINDBACK_USER'
      and f.user_id=nullif(btrim(coalesce(p_helper_user_id,'')),''))) then
    raise exception 'Recovery unavailable' using errcode='P0002';
  end if;
  return public.findback_mark_recovered_declared_helper(p_post_id,p_helper_kind,p_helper_user_id);
end $$;
revoke all on function public.findback_mark_recovered(text,text,text) from public,anon;
grant execute on function public.findback_mark_recovered(text,text,text) to authenticated;

-- Staff POST moderation is another report-prelocking entry. Preserve the
-- canonical authorization/decision/audit/notification implementation. USER and
-- COMMENT actions neither mutate reports nor need this key.
alter function public.findback_apply_moderation(text,text,text,text,text,text,text)
  rename to findback_apply_moderation_before_lifecycle_order;
revoke all on function public.findback_apply_moderation_before_lifecycle_order(text,text,text,text,text,text,text)
  from public,anon,authenticated,service_role;
create function public.findback_apply_moderation(
  p_target_type text,p_target_id text,p_action text,p_reason_code text,p_note text,
  p_sanction_kind text default null,p_sanction_ends_at text default null
)
returns text language plpgsql volatile security definer
set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_target_type='POST' then
    perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  end if;
  return public.findback_apply_moderation_before_lifecycle_order(
    p_target_type,p_target_id,p_action,p_reason_code,p_note,p_sanction_kind,p_sanction_ends_at);
end $$;
revoke all on function public.findback_apply_moderation(text,text,text,text,text,text,text) from public,anon;
grant execute on function public.findback_apply_moderation(text,text,text,text,text,text,text) to authenticated;

comment on function public.findback_order_report_lifecycle_write() is
  'All-writer BEFORE STATEMENT lifecycle serialization for report UPDATE and deletion-fence INSERT/UPDATE. RPC prelockers must acquire this key before any report tuple; no consumer bypass flag.';
comment on function public.findback_mark_recovered(text,text,text) is
  'Canonical declared-helper recovery behind pre-report lifecycle ordering and account-deletion eligibility. No client access to the private delegate; existing helper/status/recovery validation is preserved.';
commit;
