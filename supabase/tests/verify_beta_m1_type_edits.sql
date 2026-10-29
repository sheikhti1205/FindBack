-- Mutation targets: direct type grant bypass; stale pending proposals; changing
-- the meaning of either side of a confirmed/recovered relationship.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9861-00000000000'||n,
       'm1_edit_'||n,'m1_edit_'||n||'@example.invalid','+880198610000'||n,1,now(),now()
from generate_series(1,2) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,
                             moderation_visibility,created_at,updated_at)
select 'm1e-'||lane||'-'||side,
       '00000000-0000-4000-9861-00000000000'||case when side='l' then 1 else 2 end,
       case when side='l' then 'LOST' else 'FOUND' end,
       'Wallet','Blue wallet near the station','Other','OPEN',current_date,'PUBLISHED',now(),now()
from unnest(array['pending','close','confirmed','recovered']) lane cross join unnest(array['l','f']) side;
create temp table m1e_failures(label text primary key, detail text) on commit drop;
grant insert,select on m1e_failures to authenticated;
create function pg_temp.m1e_error(label text, command text, expected_message text)
returns void language plpgsql as $$
begin
  begin execute command; insert into m1e_failures values(label,'accepted');
  exception when others then
    if sqlstate<>'P0001' or sqlerrm<>expected_message then
      insert into m1e_failures values(label,sqlstate||' / '||sqlerrm);
    end if;
  end;
end $$;
grant execute on function pg_temp.m1e_error(text,text,text) to authenticated;
set local role authenticated;
do $$
declare lane text; mid text;
begin
  foreach lane in array array['pending','close','confirmed','recovered'] loop
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9861-000000000001',true);
    mid:=public.findback_propose_match('m1e-'||lane||'-l','m1e-'||lane||'-f');
    perform set_config('m1e.'||lane,mid,true);
    if lane in ('confirmed','recovered') then
      perform set_config('request.jwt.claim.sub','00000000-0000-4000-9861-000000000002',true);
      perform public.findback_confirm_match(mid);
    end if;
    if lane='recovered' then
      perform public.findback_handover_match(mid);
      perform set_config('request.jwt.claim.sub','00000000-0000-4000-9861-000000000001',true);
      perform public.findback_handover_match(mid);
    end if;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9861-000000000001',true);
select pg_temp.m1e_error('confirmed_rpc_type',
  $$select public.findback_update_post_client('m1e-confirmed-l',p_type=>'FOUND')$$,
  'Cancel the match before changing this report type');
select pg_temp.m1e_error('confirmed_direct_type',
  $$update public.item_posts set type='FOUND' where id='m1e-confirmed-l'$$,
  'Cancel the match before changing this report type');
select pg_temp.m1e_error('recovered_direct_type',
  $$update public.item_posts set type='FOUND' where id='m1e-recovered-l'$$,
  'A recovered report cannot change type');
-- Content-only corrections remain available without changing consent/type.
select public.findback_update_post_client('m1e-confirmed-l',p_title=>'Blue wallet');
select public.findback_update_post_client('m1e-pending-l',p_type=>'FOUND');
select public.findback_change_post_status_client('m1e-close-l','CLOSED');
reset role;
do $$
declare lane text; failures text;
begin
  foreach lane in array array['pending','close'] loop
    if not exists(select 1 from public.report_matches where id=current_setting('m1e.'||lane)
                   and status='CANCELLED' and cancel_reason='REPORT_CHANGED') then
      insert into m1e_failures values(lane||'_invalidates','pending consent remains active');
    end if;
  end loop;
  if (select type from public.item_posts where id='m1e-confirmed-l')<>'LOST'
     or (select title from public.item_posts where id='m1e-confirmed-l')<>'Blue wallet' then
    insert into m1e_failures values('content_edit','guard blocked content or let type drift');
  end if;
  select string_agg(label||': '||detail,E'\n' order by label) into failures from m1e_failures;
  if failures is not null then raise exception E'M1 type-edit violations:\n%',failures; end if;
end $$;
select 'PASS M1 type edits protect relationship and invalidate pending consent' as result;
rollback;
