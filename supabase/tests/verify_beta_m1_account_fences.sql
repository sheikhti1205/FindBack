-- A committed account-deletion admission removes eligibility for NEW consent
-- or handover, even while the storage/auth deletion steps are still pending.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9865-00000000000'||n,
       'm1_fence_'||n,'m1_fence_'||n||'@example.invalid','+880198650000'||n,1,now(),now()
from generate_series(1,2) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,
                             moderation_visibility,created_at,updated_at)
select 'm1fence-'||lane||'-'||side,
       '00000000-0000-4000-9865-00000000000'||case when side='l' then 1 else 2 end,
       case when side='l' then 'LOST' else 'FOUND' end,
       'Wallet','Blue wallet near station','Other','OPEN',current_date,'PUBLISHED',now(),now()
from unnest(array['proposal','confirm','handover','padded-l','padded-both','padded-f']) lane cross join unnest(array['l','f']) side;
create temp table m1fence_failures(label text primary key,detail text) on commit drop;
grant insert,select on m1fence_failures to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9865-000000000001',true);
select set_config('m1fence.confirm',public.findback_propose_match('m1fence-confirm-l','m1fence-confirm-f'),true);
select set_config('m1fence.handover',public.findback_propose_match('m1fence-handover-l','m1fence-handover-f'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9865-000000000002',true);
select public.findback_confirm_match(current_setting('m1fence.handover'));
reset role;
insert into public.account_deletion_fences(user_id) values('00000000-0000-4000-9865-000000000001');
set local role authenticated;
do $$
declare cmd text; label text;
begin
  foreach label in array array['proposal','confirm','handover'] loop
    cmd:=case label
      when 'proposal' then $sql$select public.findback_propose_match('m1fence-proposal-l','m1fence-proposal-f')$sql$
      when 'confirm' then format('select public.findback_confirm_match(%L)',current_setting('m1fence.confirm'))
      else format('select public.findback_handover_match(%L)',current_setting('m1fence.handover')) end;
    begin
      execute cmd;
      insert into m1fence_failures values(label,'accepted new operation involving deleting account');
    exception when others then
      if sqlstate<>'P0002' or sqlerrm<>'Match unavailable' then
        insert into m1fence_failures values(label,sqlstate||' / '||sqlerrm);
      end if;
    end;
  end loop;
end $$;
reset role;
-- The public delegate trims IDs; authorization must inspect that same pair.
set local role authenticated;
do $$ declare lane text; first_id text; second_id text; begin
  foreach lane in array array['padded-l','padded-both'] loop
    first_id:=' m1fence-'||lane||'-l ';
    second_id:=case lane when 'padded-both' then ' m1fence-'||lane||'-f ' else 'm1fence-'||lane||'-f' end;
    begin
      perform public.findback_propose_match(first_id,second_id);
      insert into m1fence_failures values(lane,'padding bypassed deleting LOST owner');
    exception when others then
      if sqlstate<>'P0002' or sqlerrm<>'Match unavailable' then
        insert into m1fence_failures values(lane,sqlstate||' / '||sqlerrm);
      end if;
    end;
  end loop;
end $$;
reset role;
delete from public.account_deletion_fences where user_id='00000000-0000-4000-9865-000000000001';
insert into public.account_deletion_fences(user_id) values('00000000-0000-4000-9865-000000000002');
set local role authenticated;
do $$ begin
  begin
    perform public.findback_propose_match('m1fence-padded-f-l',' m1fence-padded-f-f ');
    insert into m1fence_failures values('padded-f','padding bypassed deleting FOUND owner');
  exception when others then
    if sqlstate<>'P0002' or sqlerrm<>'Match unavailable' then
      insert into m1fence_failures values('padded-f',sqlstate||' / '||sqlerrm);
    end if;
  end;
end $$;
reset role;
do $$ declare failures text; begin
  if exists(select 1 from public.report_matches where lost_report_id like 'm1fence-padded-%') then
    insert into m1fence_failures values('no_padded_relationship','unauthorized proposal/consent persisted');
  end if;
  if (select count(*) from public.match_confirmations where match_id=current_setting('m1fence.confirm'))<>1 then
    insert into m1fence_failures values('no_new_consent','tentative acceptance committed');
  end if;
  if exists(select 1 from public.match_handovers where match_id=current_setting('m1fence.handover')) then
    insert into m1fence_failures values('no_new_handover','handover acknowledgement committed');
  end if;
  select string_agg(label||': '||detail,E'\n' order by label) into failures from m1fence_failures;
  if failures is not null then raise exception E'M1 account-fence violations:\n%',failures; end if;
end $$;
-- Escaping an unrecovered relationship remains possible; a fence must not lock
-- a surviving participant into a link with an account that is being removed.
set local role authenticated;
select public.findback_cancel_match(current_setting('m1fence.handover'));
reset role;
select 'PASS account deletion fence gates proposal/consent/handover but not safe cancellation' as result;
rollback;
