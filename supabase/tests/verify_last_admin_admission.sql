-- Disposable full-chain PostgreSQL only. ROLLBACK includes every fixture.
begin;
set local lock_timeout = '10s';
insert into public.users(id,username,email,phone,password_hash,created_at,updated_at)
select 'admit-' || n, 'admit' || n, 'admit' || n || '@example.test', '+1990000000' || n, 'x', '2026-10-22', '2026-10-22' from generate_series(1,5) n;
insert into public.user_roles(user_id,role,granted_at) values ('admit-1','ADMIN','2026-10-22'),('admit-1','MODERATOR','2026-10-22');
insert into public.user_role_capabilities(user_id,capability,granted_at) values ('admit-1','reports_review','2026-10-22');
do $$ declare v_detail text; begin
  begin
    perform public.findback_begin_account_deletion('admit-1');
    raise exception 'sole dual-role admin admission must refuse before writes';
  exception when sqlstate '42501' then
    get stacked diagnostics v_detail=pg_exception_detail;
    if sqlerrm <> 'This is the only admin account. Promote another admin before deleting this one.' or v_detail <> 'LAST_ADMIN_DELETION_BLOCKED' then raise exception 'wrong refusal'; end if;
  end;
  if exists(select 1 from public.account_deletion_fences where user_id='admit-1') then raise exception 'refused admission fenced'; end if;
  if (select count(*) from public.user_roles where user_id='admit-1') <> 2 then raise exception 'refused admission removed roles'; end if;
  if (select count(*) from public.user_role_capabilities where user_id='admit-1') <> 1 then raise exception 'refused admission removed capabilities'; end if;
  if exists(select 1 from public.admin_audit_log where target_id='admit-1') then raise exception 'refused admission audited'; end if;
end $$;
-- The admission marker cannot be forged through the old table INSERT grant.
do $$ begin
  if has_column_privilege('service_role','public.account_deletion_fences','admission_id','INSERT') then raise exception 'service role can forge admission marker'; end if;
  if has_function_privilege('authenticated','public.findback_begin_account_deletion(text)','EXECUTE') or has_function_privilege('anon','public.findback_begin_account_deletion(text)','EXECUTE') then raise exception 'public admission RPC'; end if;
end $$;
insert into public.user_roles(user_id,role,granted_at) values ('admit-2','ADMIN','2026-10-22');
do $$ declare a jsonb; b jsonb; begin
  select to_jsonb(public.findback_begin_account_deletion('admit-1')) into a;
  select to_jsonb(public.findback_begin_account_deletion('admit-1')) into b;
  if a->>'status' is distinct from 'admitted' or a is distinct from b then raise exception 'admission retry not stable: %, %',a,b; end if;
  if exists(select 1 from public.user_roles where user_id='admit-1') then raise exception 'admitted roles remain'; end if;
  if exists(select 1 from public.user_role_capabilities where user_id='admit-1') then raise exception 'admitted capabilities remain'; end if;
  if (select count(*) from public.admin_audit_log where target_id='admit-1' and action='account_deletion_admitted') <> 1 then raise exception 'audit not exactly once'; end if;
  begin
    insert into public.user_roles(user_id,role,granted_at) values ('admit-1','ADMIN','2026-10-22');
    raise exception 'regrant succeeded';
  exception when sqlstate '42501' then null; end;
  begin
    insert into public.user_role_capabilities(user_id,capability,granted_at) values ('admit-1','reports_review','2026-10-22');
    raise exception 'capability acquisition succeeded';
  exception when sqlstate '42501' then null; end;
  delete from public.users where id='admit-1';
  if not exists(select 1 from public.admin_audit_log where target_id='admit-1' and previous_state->'roles' @> '[{"role":"ADMIN"}]'::jsonb and previous_state->'capabilities' @> '[{"capability":"reports_review"}]'::jsonb and new_state->>'admission_id'=a->>'admission_id' and new_state->>'verified_user_id'='admit-1') then raise exception 'audit lost durable provenance'; end if;
end $$;
-- An old fence does NOT admit/strip the only admin.
insert into public.account_deletion_fences(user_id) values ('admit-2');
do $$ begin
  begin
    perform public.findback_begin_account_deletion('admit-2');
    raise exception 'legacy fence bypassed sole admin guard';
  exception when sqlstate '42501' then null; end;
  if not exists(select 1 from public.user_roles where user_id='admit-2' and role='ADMIN') then raise exception 'legacy fence stripped only admin'; end if;
end $$;
-- Moderator and roleless admissions are allowed.
-- Once another admin exists, the legacy fence may be converted ONLY by the
-- same checked transaction (it must not remain a privileged admission).
insert into public.user_roles(user_id,role,granted_at) values ('admit-5','ADMIN','2026-10-22');
do $$ declare r jsonb; begin
  select to_jsonb(public.findback_begin_account_deletion('admit-2')) into r;
  if r->>'status' is distinct from 'admitted' or exists(select 1 from public.user_roles where user_id='admit-2') then raise exception 'legacy conversion unsafe'; end if;
  if not exists(select 1 from public.account_deletion_fences where user_id='admit-2' and admission_id is not null) then raise exception 'legacy conversion missing marker'; end if;
end $$;
insert into public.user_roles(user_id,role,granted_at) values ('admit-3','MODERATOR','2026-10-22');
-- Fault injection: a canonical-audit failure rolls back privilege removal and
-- the fence together. This temporary trigger exists only in this ROLLBACK.
create function pg_temp.reject_admission_audit() returns trigger language plpgsql as $$
begin raise exception 'injected admission audit failure'; end $$;
create trigger guard_probe_audit_failure before insert on public.admin_audit_log
  for each row execute function pg_temp.reject_admission_audit();
do $$ begin
  begin
    perform public.findback_begin_account_deletion('admit-3');
    raise exception 'audit failure did not abort';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'injected admission audit failure' then raise; end if;
  end;
  if not exists(select 1 from public.user_roles where user_id='admit-3' and role='MODERATOR') or exists(select 1 from public.account_deletion_fences where user_id='admit-3') then raise exception 'admission failure left partial state'; end if;
end $$;
drop trigger guard_probe_audit_failure on public.admin_audit_log;
do $$ declare r jsonb; begin
  for i in 3..4 loop
    select to_jsonb(public.findback_begin_account_deletion('admit-' || i)) into r;
    if r->>'status' is distinct from 'admitted' then raise exception 'ordinary admission refused'; end if;
  end loop;
  if exists(select 1 from public.user_roles where user_id='admit-3') then raise exception 'moderator remains privileged'; end if;
end $$;
select 'atomic admission probes passed' as result;
rollback;
