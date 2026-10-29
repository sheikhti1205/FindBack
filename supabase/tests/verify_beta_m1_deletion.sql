-- Real report/account deletion matrix. Missing retention and survivor repair
-- must fail observably; no source-text checks or invented hosted acceptance.
begin;
insert into auth.users(id,email)
select ('00000000-0000-4000-9862-'||lpad(n::text,12,'0'))::uuid,
       'm1_delete_'||n||'@example.invalid' from generate_series(1,20) n;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9862-'||lpad(n::text,12,'0'),
       'm1_delete_'||n,'m1_delete_'||n||'@example.invalid','+88019862'||lpad(n::text,5,'0'),1,now(),now()
from generate_series(1,20) n on conflict(id) do nothing;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,
                             moderation_visibility,created_at,updated_at)
select 'm1d-'||lane||'-'||side,
       '00000000-0000-4000-9862-'||lpad((2*lane-case when side='l' then 1 else 0 end)::text,12,'0'),
       case when side='l' then 'LOST' else 'FOUND' end,
       'Wallet','Blue wallet near the station','Other','OPEN',current_date,'PUBLISHED',now(),now()
from generate_series(1,10) lane cross join unnest(array['l','f']) side;
create temp table m1d_failures(label text primary key, detail text) on commit drop;
grant insert,select on m1d_failures to authenticated;
set local role authenticated;
do $$
declare lane integer; mid text; rid text;
begin
  for lane in 1..10 loop
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9862-'||lpad((2*lane-1)::text,12,'0'),true);
    mid:=public.findback_propose_match('m1d-'||lane||'-l','m1d-'||lane||'-f');
    perform set_config('m1d.match'||lane,mid,true);
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9862-'||lpad((2*lane)::text,12,'0'),true);
    perform public.findback_confirm_match(mid);
    if lane in (3,4,7,8) then
      perform public.findback_handover_match(mid);
      perform set_config('request.jwt.claim.sub','00000000-0000-4000-9862-'||lpad((2*lane-1)::text,12,'0'),true);
      perform public.findback_handover_match(mid);
    end if;
  end loop;
end $$;
reset role;
-- Rate both directions for report-only removal cases.
do $$ declare lane integer; rid text; begin
  for lane in 3..4 loop
    select id into rid from public.successful_returns where lost_post_id='m1d-'||lane||'-l';
    perform set_config('m1d.return'||lane,rid,true);
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9862-'||lpad((2*lane-1)::text,12,'0'),true);
    perform public.findback_rate_return(rid,5);
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9862-'||lpad((2*lane)::text,12,'0'),true);
    perform public.findback_rate_return(rid,4);
  end loop;
end $$;

-- The owner RPC is the only client deletion seam. A statement-level definer
-- prelocker must not be triggerable by arbitrary direct/zero-row client DELETE.
set local role authenticated;
do $$ declare lane integer; side text; owner_num integer; begin
  for lane in 1..4 loop
    side:=case when lane%2=1 then 'l' else 'f' end;
    owner_num:=2*lane-case when side='l' then 1 else 0 end;
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9862-'||lpad(owner_num::text,12,'0'),true);
    if side='f' then
      begin
        delete from public.item_posts where id='m1d-'||lane||'-f';
        -- Roll back an unexpectedly accepted DELETE before recording failure,
        -- so the real owner RPC below still exercises the same input.
        raise exception 'direct delete accepted' using errcode='Z0001';
      exception
        when insufficient_privilege then null;
        when sqlstate 'Z0001' then
          insert into m1d_failures values('direct_delete_acl_'||lane,'client bypass remains granted');
      end;
    end if;
    perform public.findback_delete_post_client('m1d-'||lane||'-'||side);
  end loop;
end $$;
reset role;
-- 5/7 profile deletion and 6/8 auth deletion cover real account cascade roads.
delete from public.users where id in ('00000000-0000-4000-9862-000000000009','00000000-0000-4000-9862-000000000013');
delete from auth.users where id in ('00000000-0000-4000-9862-000000000012'::uuid,'00000000-0000-4000-9862-000000000016'::uuid);
-- Both sides in ONE SQL statement must not update a peer tuple that the same
-- command still intends to delete (PostgreSQL's triggered-data-change guard).
delete from public.item_posts where id in ('m1d-9-l','m1d-9-f');
delete from auth.users where id in ('00000000-0000-4000-9862-000000000019'::uuid,'00000000-0000-4000-9862-000000000020'::uuid);
set constraints all immediate;

do $$
declare lane integer; survivor text; expected_status text; mid text; failures text;
begin
  for lane in 1..8 loop
    survivor:='m1d-'||lane||'-'||case when lane%2=1 then 'f' else 'l' end;
    expected_status:=case when lane in (3,4,7,8) then 'RECOVERED' else 'OPEN' end;
    mid:=current_setting('m1d.match'||lane);
    if (select status from public.item_posts where id=survivor) is distinct from expected_status then
      insert into m1d_failures values('survivor_'||lane,'expected '||expected_status);
    end if;
    if not exists(select 1 from public.report_matches where id=mid
       and status=case when expected_status='RECOVERED' then 'CONFIRMED' else 'CANCELLED' end) then
      insert into m1d_failures values('history_'||lane,'relationship erased or not deliberately cancelled');
    end if;
    if (select count(*) from public.match_confirmations where match_id_original=mid)<>2 then
      insert into m1d_failures values('consent_'||lane,'acknowledgement history erased');
    end if;
    if expected_status='RECOVERED' then
      if not exists(select 1 from public.successful_returns where
          (lost_post_id=survivor or found_post_id=survivor)) then
        insert into m1d_failures values('return_'||lane,'recovery relationship erased');
      end if;
    elsif exists(select 1 from public.report_match_occupancy where report_id=survivor) then
      insert into m1d_failures values('occupancy_'||lane,'cancelled survivor still occupied');
    end if;
  end loop;
  for lane in 3..4 loop
    if (select count(*) from public.return_ratings where successful_return_id=current_setting('m1d.return'||lane))<>2 then
      insert into m1d_failures values('ratings_'||lane,'report deletion erased participant ratings');
    end if;
  end loop;
  for lane in 9..10 loop
    mid:=current_setting('m1d.match'||lane);
    if exists(select 1 from public.item_posts where id in ('m1d-'||lane||'-l','m1d-'||lane||'-f'))
       or not exists(select 1 from public.report_matches where id=mid and status='CANCELLED')
       or exists(select 1 from public.report_match_occupancy where match_id=mid) then
      insert into m1d_failures values('bulk_delete_'||lane,'both-side deletion left live state');
    end if;
  end loop;
  select string_agg(label||': '||detail,E'\n' order by label) into failures from m1d_failures;
  if failures is not null then raise exception E'M1 deletion violations:\n%',failures; end if;
end $$;
select 'PASS M1 report/account LOST/FOUND before/after handover, ratings and survivor history' as result;
rollback;
