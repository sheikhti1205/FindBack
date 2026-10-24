-- Regression for independent safety audit F2: a service-owned notification
-- token is public participation by its author, not privileged repair work.
-- Disposable local PG only. No hosted/FCM/native acceptance is implied.
begin;

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9300-'||lpad(n::text,12,'0'), 'reply_standing_'||n,
       'reply_standing_'||n||'@example.invalid', '+880193000000'||n, 1,
       '2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'
from generate_series(1,7) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values('rs-target','00000000-0000-4000-9300-000000000007','LOST','Keys','Test fixture','Other','OPEN',
       '2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
values('rs-parent','rs-target','00000000-0000-4000-9300-000000000007','Parent',
       '2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');

insert into public.account_sanctions(id,user_id,kind,starts_at,ends_at,reason_code,active,created_at)
select 'rs-serious-'||n, '00000000-0000-4000-9300-'||lpad(n::text,12,'0'),
       case (n-1)%3 when 0 then 'RESTRICTED' when 1 then 'SUSPENDED' else 'BANNED' end,
       to_char((clock_timestamp()-interval '1 day') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       null,'OTHER',true,'2026-10-24T00:00:00.000Z'
from generate_series(1,6) n;
insert into public.account_sanctions(id,user_id,kind,starts_at,ends_at,reason_code,active,created_at)
select 'rs-probation-'||n, '00000000-0000-4000-9300-'||lpad(n::text,12,'0'), 'PROBATION',
       to_char((clock_timestamp()-interval '1 day') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       null,'OTHER',true,'2026-10-24T00:00:00.000Z'
from generate_series(4,6) n;
insert into public.notifications(id,user_id,actor_id,type,post_id,comment_id,preview,read,created_at)
select 'rs-notification-'||n,'00000000-0000-4000-9300-'||lpad(n::text,12,'0'),
       '00000000-0000-4000-9300-000000000007','COMMENT','rs-target','rs-parent',
       'Fixture',0,'2026-10-24T00:00:00.000Z'
from generate_series(1,6) n;
insert into public.push_reply_tokens(id,user_id,post_id,parent_comment_id,notification_id,token_hash,created_at,expires_at)
select 'rs-token-'||n,'00000000-0000-4000-9300-'||lpad(n::text,12,'0'),
       'rs-target','rs-parent','rs-notification-'||n,repeat(md5('rs-token-'||n),2),
       to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char((clock_timestamp()+interval '1 hour') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
from generate_series(1,6) n;

-- Use actual service-role provenance, NOT the author's authenticated JWT.
set local role service_role;
select set_config('request.jwt.claim.sub','',true);
do $$
declare n integer; r record;
begin
  for n in 1..6 loop
    begin
      select * into strict r from public.findback_consume_reply_token_and_add_comment(
        repeat(md5('rs-token-'||n),2),'restricted token reply');
      raise exception 'RS1 FAILED: serious author % returned ok=% reason=% instead of refusal',n,r.ok,r.reason
        using errcode='0A000';
    exception when raise_exception then
      if sqlerrm not like 'POST_NOT_AVAILABLE:%' then
        raise exception 'RS1 FAILED: author % got wrong refusal %',n,sqlerrm;
      end if;
    end;
  end loop;
end $$;
reset role;
select 'RS1 all six serious-standing token replies leave comments, admissions, tokens and inbox untouched' as probe
where (select count(*) from public.comments where post_id='rs-target')=1
  and not exists(select 1 from public.public_action_admissions where user_id like '00000000-0000-4000-9300-%')
  and (select count(*) from public.push_reply_tokens where id like 'rs-token-%' and used_at is null)=6
  and (select count(*) from public.notifications where id like 'rs-notification-%' and read=0)=6;

-- The same unburned tokens work after the independent serious restrictions are
-- revoked, including the three authors who remain on public-only probation.
update public.account_sanctions set active=false where id like 'rs-serious-%';
set local role service_role;
do $$
declare n integer; r record;
begin
  for n in 1..6 loop
    select * into strict r from public.findback_consume_reply_token_and_add_comment(
      repeat(md5('rs-token-'||n),2),'allowed after restriction revoked');
    if not coalesce(r.ok,false) or r.reason is not null or r.comment_id is null then
      raise exception 'RS2 FAILED: unburned token % did not recover after restriction revoked',n;
    end if;
  end loop;
end $$;
reset role;
select 'RS2 all six original tokens succeed after revocation, charging only the three probation authors' as probe
where (select count(*) from public.comments where post_id='rs-target')=7
  and (select count(*) from public.push_reply_tokens where id like 'rs-token-%' and used_at is not null)=6
  and (select count(*) from public.notifications where id like 'rs-notification-%' and read=1)=6
  and (select count(*) from public.public_action_admissions where user_id like '00000000-0000-4000-9300-%')=3
  and not exists(select 1 from public.public_action_admissions
      where user_id in ('00000000-0000-4000-9300-000000000001',
                       '00000000-0000-4000-9300-000000000002',
                       '00000000-0000-4000-9300-000000000003'));

rollback;
