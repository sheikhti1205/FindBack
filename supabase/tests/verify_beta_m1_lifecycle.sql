-- Real PostgreSQL behavior, disposable chain only. Aggregate failures so each
-- counterexample runs. Mutation targets: privacy preflight, owner cardinality,
-- unaudited wrong-match correction and fabricated unlinked MATCHED status.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9860-00000000000'||n,
       'm1_owner_'||n,'m1_owner_'||n||'@example.invalid','+880198600000'||n,1,now(),now()
from generate_series(1,3) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,
                             moderation_visibility,created_at,updated_at)
select 'm1-'||lane||'-'||side,
       '00000000-0000-4000-9860-00000000000'||case when side='l' then 1 else 2 end,
       case when side='l' then 'LOST' else 'FOUND' end,
       'Wallet','Blue wallet near the station','Other','OPEN',current_date,'PUBLISHED',now(),now()
from unnest(array['cancel','handover','closed','status','hidden']) lane cross join unnest(array['l','f']) side;
create temp table m1_failures(label text primary key, detail text) on commit drop;
grant insert,select on m1_failures to authenticated;
create function pg_temp.m1_error(label text, command text, expected_state text, expected_message text)
returns void language plpgsql as $$
declare actual_state text; actual_message text;
begin
  begin
    execute command;
    insert into m1_failures values(label,'accepted');
  exception when others then
    get stacked diagnostics actual_state=returned_sqlstate,actual_message=message_text;
    if actual_state is distinct from expected_state or actual_message is distinct from expected_message then
      insert into m1_failures values(label,actual_state||' / '||actual_message);
    end if;
  end;
end $$;
grant execute on function pg_temp.m1_error(text,text,text,text) to authenticated;

-- All pairs pass real proposal+confirmation; no forged confirmed fixtures.
set local role authenticated;
do $$
declare lane text; mid text;
begin
  foreach lane in array array['cancel','handover','closed','hidden'] loop
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
    mid:=public.findback_propose_match('m1-'||lane||'-l','m1-'||lane||'-f');
    perform set_config('m1.'||lane,mid,true);
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000002',true);
    if public.findback_confirm_match(mid)<>'MATCHED' then raise exception 'fixture did not confirm'; end if;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000003',true);
select pg_temp.m1_error('cancel_missing', $$select public.findback_cancel_match('m1-absent')$$,'P0002','Match unavailable');
select pg_temp.m1_error('cancel_foreign', format('select public.findback_cancel_match(%L)',current_setting('m1.cancel')),'P0002','Match unavailable');
select pg_temp.m1_error('handover_missing', $$select public.findback_handover_match('m1-absent')$$,'P0002','Match unavailable');
select pg_temp.m1_error('handover_foreign', format('select public.findback_handover_match(%L)',current_setting('m1.handover')),'P0002','Match unavailable');

select set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
select pg_temp.m1_error('unlinked_matched', $$select public.findback_change_post_status_client('m1-status-l','MATCHED')$$,
                       'P0001','Use a confirmed match to mark this report as matched');
select public.findback_cancel_match(current_setting('m1.cancel'));
-- Repeating the committed intent is a safe no-op, not another audit/action.
select pg_temp.m1_error('recovered_guard_placeholder', $$select public.findback_change_post_status_client('m1-status-l','RECOVERED')$$,
                       'P0001','Use Mark recovered on the report to record a recovery');
reset role;
do $$
begin
  if (select count(*) from public.admin_audit_log where action='MATCH_CANCELLED'
       and target_type='REPORT_MATCH' and target_id=current_setting('m1.cancel')
       and actor_user_id='00000000-0000-4000-9860-000000000001'
       and previous_state->>'status'='CONFIRMED' and new_state->>'status'='CANCELLED')<>1 then
    insert into m1_failures values('cancel_audit','missing canonical audited correction');
  end if;
  if exists(select 1 from public.report_match_occupancy where match_id=current_setting('m1.cancel')) then
    insert into m1_failures values('cancel_occupancy','not released');
  end if;
end $$;
set local role authenticated;
do $$ begin
  begin perform public.findback_cancel_match(current_setting('m1.cancel'));
  exception when others then insert into m1_failures values('cancel_retry',sqlstate||' / '||sqlerrm); end;
end $$;
reset role;

-- A legacy/injected foreign handover must NOT substitute for the other owner.
insert into public.match_handovers(match_id,match_id_original,owner_id,owner_id_original)
values(current_setting('m1.handover'),current_setting('m1.handover'),
       '00000000-0000-4000-9860-000000000003','00000000-0000-4000-9860-000000000003');
set local role authenticated;
do $$ begin
  if public.findback_handover_match(current_setting('m1.handover'))<>'PARTIAL' then
    insert into m1_failures values('handover_current_owners','foreign row completed recovery');
  end if;
end $$;
reset role;
do $$ begin
  if exists(select 1 from public.successful_returns where lost_post_id='m1-handover-l') then
    insert into m1_failures values('handover_no_fabricated_return','return exists without both owners');
  end if;
end $$;
delete from public.match_handovers where match_id=current_setting('m1.handover')
  and owner_id='00000000-0000-4000-9860-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000002',true);
select public.findback_handover_match(current_setting('m1.handover'));
select public.findback_handover_match(current_setting('m1.handover'));
reset role;
do $$ begin
  if (select count(*) from public.successful_returns where lost_post_id='m1-handover-l' and found_post_id='m1-handover-f')<>1
     or (select count(*) from public.item_posts where id in ('m1-handover-l','m1-handover-f') and status='RECOVERED')<>2 then
    insert into m1_failures values('handover_exactly_one_return','completion/retry lost canonical result');
  end if;
end $$;
set local role authenticated;
select pg_temp.m1_error('cannot_undo_recovery',format('select public.findback_cancel_match(%L)',current_setting('m1.handover')),
                       'P0001','A completed recovery cannot be undone here');
reset role;

-- Operator-created lifecycle drift must not be silently overwritten by cancel.
update public.item_posts set status='CLOSED' where id='m1-closed-f';
update public.item_posts set moderation_visibility='HIDDEN' where id='m1-hidden-f';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
select pg_temp.m1_error('cancel_no_clobber_closed',format('select public.findback_cancel_match(%L)',current_setting('m1.closed')),
                       'P0001','MATCH_STATUS_CONFLICT');
select pg_temp.m1_error('handover_hidden_peer',format('select public.findback_handover_match(%L)',current_setting('m1.hidden')),
                       'P0002','Match unavailable');
reset role;
do $$
declare failures text;
begin
  select string_agg(label||': '||detail,E'\n' order by label) into failures from m1_failures;
  if failures is not null then raise exception E'M1 lifecycle violations:\n%',failures; end if;
end $$;
select 'PASS M1 lifecycle privacy, cardinality, audited correction, terminal recovery, status' as result;
rollback;
