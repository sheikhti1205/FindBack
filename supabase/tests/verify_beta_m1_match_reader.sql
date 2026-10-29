-- Reader contract is participant history, not an existence oracle or another
-- report/profile reader. Missing/hidden/blocked/deleted peers get neutral rows.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9866-00000000000'||n,
       'm1_reader_'||n,'m1_reader_'||n||'@example.invalid','+880198660000'||n,1,now(),now()
from generate_series(1,3) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,
                             moderation_visibility,created_at,updated_at)
select 'm1r-'||lane||'-'||side,
       '00000000-0000-4000-9866-00000000000'||case when side='l' then 1 else 2 end,
       case when side='l' then 'LOST' else 'FOUND' end,
       case when side='l' then 'My wallet' else 'Private peer title' end,
       'Wallet near station','Other','OPEN',current_date,'PUBLISHED',now(),now()
from unnest(array['visible','hidden','deleted','recovered']) lane cross join unnest(array['l','f']) side;
set local role authenticated;
do $$ declare lane text; mid text; begin
  foreach lane in array array['visible','hidden','deleted','recovered'] loop
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9866-000000000001',true);
    mid:=public.findback_propose_match('m1r-'||lane||'-l','m1r-'||lane||'-f');
    perform set_config('m1r.'||lane,mid,true);
    if lane='recovered' then
      perform set_config('request.jwt.claim.sub','00000000-0000-4000-9866-000000000002',true);
      perform public.findback_confirm_match(mid);
      perform public.findback_handover_match(mid);
      perform set_config('request.jwt.claim.sub','00000000-0000-4000-9866-000000000001',true);
      perform public.findback_handover_match(mid);
    end if;
  end loop;
end $$;
reset role;
-- Equal timestamps exercise the UUID tie-break cursor rather than relying on
-- incidental time differences between fixture proposals.
update public.report_matches set proposed_at='2026-10-29T00:00:00Z'
where lost_report_id like 'm1r-%';
update public.item_posts set moderation_visibility='HIDDEN' where id='m1r-hidden-f';
delete from public.item_posts where id in ('m1r-deleted-f','m1r-recovered-f');
create temp table m1r_failures(label text primary key,detail text) on commit drop;
grant insert,select on m1r_failures to authenticated;
set local role authenticated;
do $$
declare rows jsonb; r jsonb; first_page jsonb; second_page jsonb;
begin
  begin
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from public.findback_my_matches() x;
  exception when undefined_function then
    insert into m1r_failures values('reader_missing','participant projection does not exist');return;
  end;
  if jsonb_array_length(rows)<>4 then insert into m1r_failures values('own_history','not all own attempts retained');end if;
  select x into r from jsonb_array_elements(rows) x where x->>'match_id'=current_setting('m1r.visible');
  if r->>'peer_report_id' is distinct from 'm1r-visible-f' or r->>'peer_title' is distinct from 'Private peer title'
     or r->>'peer_available' is distinct from 'true' or r->>'my_confirmed' is distinct from 'true'
     or r->>'state' is distinct from 'PENDING' then
    insert into m1r_failures values('visible_projection',coalesce(r::text,'absent'));
  end if;
  for r in select x from jsonb_array_elements(rows) x where x->>'match_id'<>current_setting('m1r.visible') loop
    if r->>'peer_report_id' is not null or r->>'peer_title' is not null or r->>'peer_available' is distinct from 'false' then
      insert into m1r_failures values('unavailable_'||(r->>'match_id'),'peer content/identifier leaked');
    end if;
  end loop;
  select x into r from jsonb_array_elements(rows) x where x->>'match_id'=current_setting('m1r.recovered');
  if r->>'state' is distinct from 'RECOVERED' or r->>'my_handover' is distinct from 'true' then
    insert into m1r_failures values('recovered_history','missing terminal state after report removal');
  end if;
  if rows::text like '%original%' or rows::text like '%00000000-0000-4000-9866-000000000002%' then
    insert into m1r_failures values('retained_identity','private identifiers in projection');
  end if;
  if (select count(*) from public.findback_my_matches(p_post_id=>'m1r-visible-l'))<>1
     or (select count(*) from public.findback_my_matches(p_post_id=>'m1r-visible-f'))<>0 then
    insert into m1r_failures values('post_filter','foreign post filter exposes rows or own filter missing');
  end if;
  select to_jsonb(x) into first_page from public.findback_my_matches(p_limit=>1) x;
  select to_jsonb(x) into second_page from public.findback_my_matches(
    p_before_at=>(first_page->>'proposed_at')::timestamptz,p_before_id=>first_page->>'match_id',p_limit=>1) x;
  if first_page is null or second_page is null or first_page->>'match_id'=second_page->>'match_id' then
    insert into m1r_failures values('pagination','cursor repeats/skips the next row');
  end if;
end $$;
reset role;
insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at)
values('00000000-0000-4000-9866-000000000001','00000000-0000-4000-9866-000000000002',now());
set local role authenticated;
do $$ begin
  begin
    if exists(select 1 from public.findback_my_matches() where peer_available or peer_report_id is not null or peer_title is not null)
       or (select count(*) from public.findback_my_matches())<>4 then
      insert into m1r_failures values('blocked_history','blocked content leaked or own history dropped');
    end if;
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9866-000000000003',true);
    if exists(select 1 from public.findback_my_matches()) then
      insert into m1r_failures values('foreign_denial','foreign caller received participant history');
    end if;
  exception when undefined_function then null; end;
end $$;
reset role;
do $$ declare failures text; begin
  select string_agg(label||': '||detail,E'\n' order by label) into failures from m1r_failures;
  if failures is not null then raise exception E'M1 match-reader violations:\n%',failures;end if;
end $$;
select 'PASS participant reader visibility/history/privacy/pagination' as result;
rollback;
