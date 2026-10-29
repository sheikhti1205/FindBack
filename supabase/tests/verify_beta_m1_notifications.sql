-- Actual status-trigger/RPC behavior, forced rollback fixtures. Not a SQL-text test.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9891-00000000000'||n,
       'm1_notify_'||n,'m1_notify_'||n||'@example.invalid','+880198910000'||n,1,now(),now()
from generate_series(1,2) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,
                             moderation_visibility,created_at,updated_at)
select 'm1-notify-'||lane||'-'||side,
       '00000000-0000-4000-9891-00000000000'||case when side='l' then 1 else 2 end,
       case when side='l' then 'LOST' else 'FOUND' end,
       'Wallet','Blue wallet near the station','Other','OPEN',current_date,'PUBLISHED',now(),now()
from unnest(array['happy','fault','close']) lane cross join unnest(array['l','f']) side;

-- nextval survives a subtransaction rollback: prove the injected failure was
-- on notification TWO, not a refusal before the mutation started.
create temporary sequence m1_notification_attempt;
create function pg_temp.m1_notification_fault() returns trigger language plpgsql as $$
begin
  if new.type='STATUS' and new.post_id like 'm1-notify-fault-%'
     and current_setting('m1.fail_notification',true)='yes'
     and nextval('pg_temp.m1_notification_attempt')=2 then
    raise exception 'M1 injected second notification failure';
  end if;
  return new;
end $$;
create trigger m1_notification_fault before insert on public.notifications
for each row execute function pg_temp.m1_notification_fault();

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9891-000000000001',true);
select set_config('m1.happy',public.findback_propose_match('m1-notify-happy-l','m1-notify-happy-f'),true);
select set_config('m1.fault',public.findback_propose_match('m1-notify-fault-l','m1-notify-fault-f'),true);
reset role;
do $$ begin
  if exists(select 1 from public.notifications where post_id like 'm1-notify-%') then
    raise exception 'Proposal incorrectly emitted a terminal status notification';
  end if;
end $$;

-- Confirmation rolls back consent, first occupancy and first notification if
-- the second status notification fails. No exception-swallowing partial success.
select set_config('m1.fail_notification','yes',true);
select setval('pg_temp.m1_notification_attempt',1,false);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9891-000000000002',true);
do $$ begin
  begin
    perform public.findback_confirm_match(current_setting('m1.fault'));
    raise exception 'Expected second notification failure';
  exception when raise_exception then
    if sqlerrm<>'M1 injected second notification failure' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if (select last_value from pg_temp.m1_notification_attempt)<>2
     or (select count(*) from public.match_confirmations where match_id=current_setting('m1.fault'))<>1
     or exists(select 1 from public.report_match_occupancy where match_id=current_setting('m1.fault'))
     or exists(select 1 from public.notifications where post_id like 'm1-notify-fault-%')
     or (select status from public.report_matches where id=current_setting('m1.fault'))<>'PENDING'
     or (select count(*) from public.item_posts where id like 'm1-notify-fault-%' and status='OPEN')<>2 then
    raise exception 'Confirmation notification failure left partial state';
  end if;
end $$;
select set_config('m1.fail_notification','no',true);
set local role authenticated;
select public.findback_confirm_match(current_setting('m1.fault'));
select public.findback_confirm_match(current_setting('m1.happy'));
select public.findback_confirm_match(current_setting('m1.happy'));
reset role;
do $$ begin
  if (select count(*) from public.notifications where post_id like 'm1-notify-happy-%' and type='STATUS' and actor_id is null)<>2 then
    raise exception 'Confirmation did not notify both owners exactly once';
  end if;
  if exists(select 1 from public.notifications n join public.item_posts p on p.id=n.post_id
             where p.id like 'm1-notify-%' and n.user_id<>p.user_id) then
    raise exception 'Status notification sent to a non-owner';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9891-000000000001',true);
do $$ begin
  if public.findback_handover_match(current_setting('m1.happy'))<>'PARTIAL'
     or public.findback_handover_match(current_setting('m1.fault'))<>'PARTIAL' then
    raise exception 'One handover fabricated completed recovery';
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from public.notifications where post_id like 'm1-notify-happy-%')<>2
     or exists(select 1 from public.successful_returns where lost_post_id like 'm1-notify-%') then
    raise exception 'Partial handover emitted recovery notification/relationship';
  end if;
end $$;

-- Durable return insertion, second handover, both statuses and notifications
-- are one transaction, including failure AFTER one notification was inserted.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9891-000000000002',true);
select public.findback_handover_match(current_setting('m1.happy'));
select public.findback_handover_match(current_setting('m1.happy'));
reset role;
do $$ begin
  if (select count(*) from public.notifications where post_id like 'm1-notify-happy-%')<>4 then
    raise exception 'Recovery STATUS was suppressed by the earlier confirmation notification';
  end if;
end $$;
select set_config('m1.fail_notification','yes',true);
select setval('pg_temp.m1_notification_attempt',1,false);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9891-000000000002',true);
do $$ begin
  begin
    perform public.findback_handover_match(current_setting('m1.fault'));
    raise exception 'Expected second recovery notification failure';
  exception when raise_exception then
    if sqlerrm<>'M1 injected second notification failure' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if (select last_value from pg_temp.m1_notification_attempt)<>2
     or (select count(*) from public.match_handovers where match_id=current_setting('m1.fault'))<>1
     or exists(select 1 from public.successful_returns where lost_post_id='m1-notify-fault-l')
     or (select count(*) from public.notifications where post_id like 'm1-notify-fault-%')<>2
     or (select count(*) from public.item_posts where id like 'm1-notify-fault-%' and status='MATCHED')<>2 then
    raise exception 'Recovery notification failure left partial state';
  end if;
end $$;
select set_config('m1.fail_notification','no',true);
set local role authenticated;
select public.findback_handover_match(current_setting('m1.fault'));
select public.findback_change_post_status_client('m1-notify-close-f','CLOSED');
select public.findback_change_post_status_client('m1-notify-close-f','CLOSED');
reset role;
do $$ begin
  if (select count(*) from public.notifications where post_id like 'm1-notify-happy-%')<>4
     or (select count(*) from public.successful_returns where lost_post_id='m1-notify-happy-l')<>1
     or (select count(*) from public.notifications where post_id='m1-notify-close-f')<>1 then
    raise exception 'Completion/retry/close notification cardinality';
  end if;
  -- Last so the fault/atomicity assertions execute on the old-copy RED chain too.
  if (select count(*) from public.notifications where post_id like 'm1-notify-happy-%'
       and preview='Both owners confirmed a match. Record the handover after the item is returned.')<>2
     or (select count(*) from public.notifications where post_id like 'm1-notify-happy-%'
       and preview='Recovery recorded. The item has been returned.')<>2
     or (select preview from public.notifications where post_id='m1-notify-close-f')<>'Your report is closed.' then
    raise exception 'Status notification still exposes raw lifecycle codes instead of consumer copy';
  end if;
  if has_function_privilege('anon','public.findback_notify_status()','EXECUTE')
     or has_function_privilege('authenticated','public.findback_notify_status()','EXECUTE') then
    raise exception 'Status trigger became a consumer-callable notification writer';
  end if;
end $$;
select 'PASS M1 status copy, current-owner recipients, exactly-once retries, partial-handovers, second-notification rollback' as result;
rollback;
