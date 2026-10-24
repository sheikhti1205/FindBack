-- Local PG17 delivery-boundary behavior. Does not send push or prove hosted
-- realtime. Captures calls to the local realtime.send shim inside a rollback.
begin;
create temporary table comment_delivery_broadcasts(payload jsonb,event text,topic text,private boolean);
create or replace function realtime.send(payload jsonb,event text,topic text,private boolean default false)
returns void language plpgsql as $$ begin
  insert into pg_temp.comment_delivery_broadcasts values($1,$2,$3,$4);
end $$;

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9300-'||lpad(n::text,12,'0'),'delivery_'||n,
 'delivery_'||n||'@example.invalid','+880193000000'||n,1,'2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z'
from generate_series(1,4) n;
insert into public.user_roles(user_id,role,granted_at)
values('00000000-0000-4000-9300-000000000004','ADMIN','2026-10-24T00:00:00.000Z');
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values('cd-post','00000000-0000-4000-9300-000000000001','LOST','Delivery post','Description','Electronics','OPEN',
 '2026-10-24','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.comments(id,post_id,user_id,body,created_at,updated_at)
values('cd-comment','cd-post','00000000-0000-4000-9300-000000000002','Private-test snippet',
 '2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z');
insert into public.notifications(id,user_id,actor_id,type,post_id,comment_id,preview,created_at)
values('cd-notification','00000000-0000-4000-9300-000000000003','00000000-0000-4000-9300-000000000002',
 'COMMENT','cd-post','cd-comment','Private-test snippet','2026-10-24T00:00:00.000Z');
insert into public.push_reply_tokens(id,user_id,post_id,parent_comment_id,token_hash,created_at,expires_at,notification_id)
values('cd-token','00000000-0000-4000-9300-000000000003','cd-post','cd-comment',repeat('a',64),
 '2026-10-24T00:00:00.000Z','2099-01-01T00:00:00.000Z','cd-notification');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select 'CD1 visible stored comment notification is in recipient inbox' as probe
where exists(select 1 from public.findback_list_notifications_client(false) where id='cd-notification');
select public.findback_submit_report('COMMENT','cd-comment','HARASSMENT',null) as receipt;
select 'CD2 recipient-local report removes stored snippet from inbox' as probe
where not exists(select 1 from public.findback_list_notifications_client(false) where id='cd-notification');
reset role;
select 'CD2 report concealment signals only the private recipient topic without content' as probe
where exists(select 1 from pg_temp.comment_delivery_broadcasts b
 where b.topic='notification:00000000-0000-4000-9300-000000000003' and b.event='comment:invalidate'
 and b.private and b.payload->>'postId'='cd-post'
 and b.payload - array['postId','entity','invalidate']::text[]='{}'::jsonb);
select set_config('cd.notification_count',(select count(*)::text from public.notifications where comment_id='cd-comment'
 and user_id='00000000-0000-4000-9300-000000000003'),true);
select public.findback_insert_notification('00000000-0000-4000-9300-000000000003',
 '00000000-0000-4000-9300-000000000002','COMMENT','cd-post','cd-comment','Do not deliver');
select 'CD3 new notification creation rechecks recipient-local eligibility' as probe
where (select count(*) from public.notifications where comment_id='cd-comment'
 and user_id='00000000-0000-4000-9300-000000000003')=current_setting('cd.notification_count')::integer;

set local role service_role;
select 'CD4 dispatcher resolves stored recipient, not a supplied actor' as probe
where not public.findback_notification_delivery_allowed('cd-notification')
 and not public.findback_notification_delivery_allowed('cd-missing');
select 'CD5 a concealed parent rejects a trusted token without burning it' as probe
from public.findback_consume_reply_token_and_add_comment(repeat('a',64),'Not sent') r
where not r.ok and r.reason='parent_unavailable' and r.comment_id is null;
reset role;
select 'CD5 rejected reply leaves token and notification unchanged' as probe
where (select used_at from public.push_reply_tokens where id='cd-token') is null
 and (select read from public.notifications where id='cd-notification')=0
 and not exists(select 1 from public.comments where body like '%Not sent%');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
do $$ begin
 begin
  perform public.findback_notification_delivery_allowed('cd-notification');
  raise exception 'CD6 consumer could use service delivery oracle' using errcode='0A000';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000004',true);
select public.findback_apply_moderation('COMMENT','cd-comment','NO_ACTION','HARASSMENT',null) as audit;
reset role;
select 'CD7 dismissal invalidates authorized lists even without a visibility-row change' as probe
where exists(select 1 from pg_temp.comment_delivery_broadcasts b where b.event='comment:invalidate'
 and b.topic='post:cd-post' and b.payload->>'op'='MODERATION');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select 'CD7 dismissal removes local concealment' as probe
where exists(select 1 from public.findback_list_notifications_client(false) where id='cd-notification');
select public.findback_block_user('00000000-0000-4000-9300-000000000002') as blocked;
reset role;
set local role service_role;
select 'CD8 blocked recipient is not eligible for dispatch or token reply' as probe
where not public.findback_notification_delivery_allowed('cd-notification');
select 'CD8 blocked token reply is neutral' as probe
from public.findback_consume_reply_token_and_add_comment(repeat('a',64),'Blocked reply') r
where not r.ok and r.reason='parent_unavailable' and r.comment_id is null;
reset role;
select 'CD8 blocked reply did not consume token' as probe
where (select used_at from public.push_reply_tokens where id='cd-token') is null;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select public.findback_unblock_user('00000000-0000-4000-9300-000000000002') as unblocked;
reset role;
set local role service_role;
select 'CD9 unblocked visible recipient is eligible' as probe
where public.findback_notification_delivery_allowed('cd-notification');
select 'CD9 trusted token succeeds as its server-owned user' as probe
from public.findback_consume_reply_token_and_add_comment(repeat('a',64),'Valid reply') r where r.ok;
reset role;
select 'CD9 success consumes token and attributes reply correctly' as probe
where (select used_at from public.push_reply_tokens where id='cd-token') is not null
 and (select read from public.notifications where id='cd-notification')=1
 and exists(select 1 from public.comments where body like '%Valid reply'
   and user_id='00000000-0000-4000-9300-000000000003' and parent_id='cd-comment');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000004',true);
select public.findback_apply_moderation('COMMENT','cd-comment','HIDE','HARASSMENT',null) as audit;
reset role;
insert into public.comment_reactions(id,comment_id,user_id,type,created_at)
values('cd-reaction','cd-comment','00000000-0000-4000-9300-000000000001','LOVE','2026-10-24T00:00:00.000Z');
delete from public.comment_reactions where id='cd-reaction';
update public.comments set body='New hidden-test body' where id='cd-comment';
do $$ declare v_events jsonb; begin
 select jsonb_agg(jsonb_build_object('event',b.event,'topic',b.topic,'keys',
   (select jsonb_agg(k order by k) from jsonb_object_keys(b.payload) k))) into v_events
 from pg_temp.comment_delivery_broadcasts b where b.topic='post:cd-post';
 raise notice 'CD10 captured event metadata: %',v_events;
end $$;
select 'CD10 shared comment broadcasts are invalidations only' as probe
where exists(select 1 from pg_temp.comment_delivery_broadcasts where event='comment:invalidate' and payload->>'op'='UPDATE')
 and exists(select 1 from pg_temp.comment_delivery_broadcasts where event='comment:invalidate' and payload->>'op'='INSERT')
 and exists(select 1 from pg_temp.comment_delivery_broadcasts where event='reaction:invalidate')
 and not exists(select 1 from pg_temp.comment_delivery_broadcasts b where b.topic='post:cd-post'
   and (b.event like 'comment:%' or b.event like 'reaction:%')
   and (b.event not in ('comment:invalidate','reaction:invalidate')
    or b.payload - array['postId','entity','invalidate','op']::text[] <> '{}'::jsonb
    or not b.private or b.payload->>'invalidate'<>'true'));

set local role service_role;
select 'CD11 queued dispatch rechecks global hide' as probe
where not public.findback_notification_delivery_allowed('cd-notification');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select 'CD11 stored recipient inbox also rechecks global hide' as probe
where not exists(select 1 from public.findback_list_notifications_client(false) where id='cd-notification');
reset role;

-- CD12. "Private channel" is only private when the subscriber is authorized.
-- The blanket authenticated-wide receive policy is gone and the replacement
-- names exactly the three product topics.
select 'CD12 realtime receive policy is topic-scoped, not blanket' as probe
where exists(
  select 1 from pg_policies p
  where p.schemaname='realtime' and p.tablename='messages'
    and p.policyname='findback_realtime_receive_authenticated'
    and p.cmd='SELECT' and 'authenticated'=any(p.roles)
    and p.qual like '%notification:%'
    and p.qual like '%post:%'
)
and not exists(
  select 1 from pg_policies p
  where p.schemaname='realtime' and p.tablename='messages'
    and p.qual in ('true','(true)')
    and p.policyname<>'findback_realtime_receive_authenticated'
);

-- CD13. Row-level authorization outcome, not just the policy text: the shim
-- writes no messages, so seed the table directly and read as a real account.
alter table realtime.messages enable row level security;
insert into realtime.messages(topic,extension,payload,event,private) values
 ('notification:00000000-0000-4000-9300-000000000003','broadcast','{"postId":"cd-post"}','comment:invalidate',true),
 ('notification:00000000-0000-4000-9300-000000000001','broadcast','{"postId":"cd-post"}','comment:invalidate',true),
 ('post:cd-post','broadcast','{"postId":"cd-post","invalidate":true}','comment:invalidate',true),
 ('feed','broadcast','{"invalidate":true}','post:changed',true),
 ('admin:ops','broadcast','{}','ops',true);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9300-000000000003',true);
select 'CD13 a stranger cannot read another account''s notification room' as probe
where exists(select 1 from realtime.messages m where m.topic='notification:00000000-0000-4000-9300-000000000003')
  and not exists(select 1 from realtime.messages m where m.topic='notification:00000000-0000-4000-9300-000000000001')
  and exists(select 1 from realtime.messages m where m.topic='post:cd-post')
  and exists(select 1 from realtime.messages m where m.topic='feed')
  and not exists(select 1 from realtime.messages m where m.topic='admin:ops');
reset role;
rollback;
