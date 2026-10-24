-- Disposable-local behavioral assertions. Hosted execution is UNRUN.
-- Run through scripts/sql-behavior.mjs so an empty SELECT is a failure.
begin;

select 'AR0 readers exist' as probe
where to_regprocedure('public.findback_my_appeals(integer,text,text)') is not null
  and to_regprocedure('public.findback_my_appeal_subjects(integer,text,text,text)') is not null;

insert into public.users (id, username, email, phone, email_verified, created_at, updated_at)
select '00000000-0000-4000-9000-' || lpad(n::text,12,'0'), 'appeals_reader_' || n,
       'appeals_reader_' || n || '@example.invalid', '+880190000000' || n, 1,
       '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'
from generate_series(1,4) n;
insert into public.user_roles (user_id,role,granted_at)
values ('00000000-0000-4000-9000-000000000003','ADMIN','2026-10-23T00:00:00.000Z');
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values ('ar-post','00000000-0000-4000-9000-000000000001','LOST','Appeal post','Description','Electronics','OPEN','2026-10-22','2026-10-23T00:00:00.000Z','2026-10-23T00:00:00.000Z');
insert into public.comments (id,post_id,user_id,body,created_at,updated_at)
values ('ar-comment','ar-post','00000000-0000-4000-9000-000000000002','Another owner comment','2026-10-23T00:00:00.000Z','2026-10-23T00:00:00.000Z');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000003',true);
select public.findback_apply_moderation('COMMENT','ar-comment','HIDE','HARASSMENT',null) as audit;

-- Canonical case belongs to post owner A; audit target belongs to comment owner B.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000001',true);
select 'AR1 parent ownership cannot expand appeal authority' as probe
where jsonb_array_length(public.findback_my_appeal_subjects()->'items') = 0;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000002',true);
select 'AR2 original comment owner gets actionable identity only' as probe
where public.findback_my_appeal_subjects()->'items'->0->>'target_type' = 'COMMENT'
  and public.findback_my_appeal_subjects()->'items'->0->>'target_id' = 'ar-comment'
  and (select count(*) from jsonb_object_keys(public.findback_my_appeal_subjects()->'items'->0)) = 8;
select public.findback_submit_appeal('MODERATION_ACTION',public.findback_my_appeal_subjects()->'items'->0->>'subject_id','Please reconsider') as appeal;
select 'AR3 durable receipt and open marker agree' as probe
where public.findback_my_appeal_subjects()->'items'->0->>'open_appeal_id' = public.findback_my_appeals()->'items'->0->>'id'
  and (select count(*) from jsonb_object_keys(public.findback_my_appeals()->'items'->0)) = 6;
reset role;
delete from public.comments where id='ar-comment';
set local role authenticated;
select 'AR4 receipt survives live comment deletion' as probe
where jsonb_array_length(public.findback_my_appeal_subjects()->'items') = 0
  and jsonb_array_length(public.findback_my_appeals()->'items') = 1;

select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000003',true);
select 'AR5 admin cannot read other appellants' as probe
where jsonb_array_length(public.findback_my_appeals()->'items') = 0;
select public.findback_apply_moderation('USER','00000000-0000-4000-9000-000000000001','WARN','HARASSMENT',null) as audit;
select public.findback_apply_moderation('USER','00000000-0000-4000-9000-000000000001','PROBATION','SPAM_OR_DUPLICATE',null) as audit;
reset role;

-- Create an action-alias receipt for the OLDER still-effective warning.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000001',true);
reset role;
do $$ declare action_id text; begin
  select id into action_id from public.admin_audit_log where target_id='00000000-0000-4000-9000-000000000001' and action='WARN';
  perform public.findback_submit_appeal('MODERATION_ACTION',action_id,'Old warning appeal');
end $$;
set local role authenticated;
select 'AR6 older sanction and explicit audit alias remain discoverable' as probe
where jsonb_array_length(public.findback_my_appeal_subjects()->'items') = 2
  and exists(select 1 from jsonb_array_elements(public.findback_my_appeal_subjects()->'items') x where x->>'action'='WARN' and x->>'open_appeal_id' is not null)
  and not exists(select 1 from jsonb_array_elements(public.findback_my_appeal_subjects()->'items') x where x->>'subject_kind'<>'SANCTION');

-- Deterministic two-page traversal when timestamps tie.
do $$ declare p1 jsonb; p2 jsonb; c jsonb; begin
  p1 := public.findback_my_appeal_subjects(1);
  c := p1->'next_cursor';
  p2 := public.findback_my_appeal_subjects(1,c->>'created_at',c->>'subject_kind',c->>'subject_id');
  if jsonb_array_length(p1->'items') <> 1 or jsonb_array_length(p2->'items') <> 1
     or p1->'items'->0->>'subject_id' = p2->'items'->0->>'subject_id'
     or p2->'next_cursor' <> 'null'::jsonb then raise exception 'AR7 incomplete subject pagination'; end if;
end $$;
reset role;

insert into public.account_sanctions (id,user_id,kind,starts_at,ends_at,reason_code,active,created_at,revoked_at)
values
('ar-expired','00000000-0000-4000-9000-000000000001','BANNED','',now()::text,'OTHER',true,'2026-10-23T00:00:00.000Z',null),
('ar-future','00000000-0000-4000-9000-000000000001','BANNED',(now()+interval '1 day')::text,null,'OTHER',true,'2026-10-23T00:00:00.000Z',null),
('ar-revoked','00000000-0000-4000-9000-000000000001','BANNED','',null,'OTHER',true,'2026-10-23T00:00:00.000Z',now()::text),
('ar-inactive','00000000-0000-4000-9000-000000000001','BANNED','',null,'OTHER',false,'2026-10-23T00:00:00.000Z',null),
('ar-blank','00000000-0000-4000-9000-000000000001','WARNING',' ',' ','OTHER',true,'2026-10-23T00:00:00.000Z',null);
set local role authenticated;
select 'AR8 effective-time predicate matches standing including empty times' as probe
where jsonb_array_length(public.findback_my_appeal_subjects()->'items') = 3
  and exists(select 1 from jsonb_array_elements(public.findback_my_appeal_subjects()->'items') x where x->>'subject_id'='ar-blank');

-- Receipts do NOT depend on current discovery eligibility; seed history with
-- tied timestamps and closed rows, without pretending a resolver already exists.
reset role;
insert into public.appeals (id,appellant_user_id,subject_kind,subject_id,sanction_id,message,status,submitted_at,resolved_at,reviewer_note,resolved_by)
select 'ar-receipt-'||lpad(n::text,3,'0'),'00000000-0000-4000-9000-000000000004','SANCTION','ar-blank','ar-blank',
       'Private original body','RESOLVED','2026-10-22T00:00:00.000Z','2026-10-23T00:00:00.000Z','Private staff note','private-moderator'
from generate_series(1,105) n;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000004',true);
do $$ declare p1 jsonb; p2 jsonb; c jsonb; begin
  p1 := public.findback_my_appeals(500);
  c := p1->'next_cursor';
  p2 := public.findback_my_appeals(100,c->>'submitted_at',c->>'id');
  if jsonb_array_length(p1->'items')<>100 or jsonb_array_length(p2->'items')<>5
     or p2->'next_cursor'<>'null'::jsonb
     or p1->'items'->99->>'id'<>'ar-receipt-006'
     or p2->'items'->0->>'id'<>'ar-receipt-005' then raise exception 'AR9 receipt tuple pagination failed'; end if;
  if p1::text like '%Private%' or p1::text like '%private-moderator%' then raise exception 'AR9 private fields leaked'; end if;
end $$;

do $$ begin
  begin perform public.findback_my_appeals(50,null,'id'); raise exception 'AR10 missing time accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.findback_my_appeals(50,'invalid','id'); raise exception 'AR10 invalid time accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.findback_my_appeal_subjects(50,null,'SANCTION','id'); raise exception 'AR10 invalid subject cursor accepted'; exception when invalid_parameter_value then null; end;
end $$;

reset role;
delete from public.account_sanctions where id='ar-blank';
set local role authenticated;
select 'AR11 receipt survives nulled subject FK' as probe
where jsonb_array_length(public.findback_my_appeals(100)->'items')=100;
reset role;
delete from public.users where id='00000000-0000-4000-9000-000000000004';
set local role authenticated;
select 'AR12 nulled appellant is not a caller wildcard' as probe
where jsonb_array_length(public.findback_my_appeals()->'items')=0;

select set_config('request.jwt.claim.sub','',true);
do $$ begin
  begin perform public.findback_my_appeals(); raise exception 'AR13 missing auth accepted'; exception when invalid_authorization_specification then null; end;
  begin perform public.findback_my_appeal_subjects(); raise exception 'AR13 missing auth accepted'; exception when invalid_authorization_specification then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.findback_my_appeals(); raise exception 'AR14 anon accepted'; exception when insufficient_privilege then null; end;
  begin perform public.findback_my_appeal_subjects(); raise exception 'AR14 anon subjects accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'AR15 sensitive tables remain ungranted and policy-free' as probe
where not exists (
  select 1 from pg_class c where c.oid in ('public.appeals'::regclass,'public.admin_audit_log'::regclass,'public.account_sanctions'::regclass,'public.moderation_case_decisions'::regclass)
  and (not c.relrowsecurity or has_table_privilege('authenticated',c.oid,'SELECT') or has_table_privilege('anon',c.oid,'SELECT') or exists(select 1 from pg_policy p where p.polrelid=c.oid))
);

-- IR1: remove s.user_id=v_uid and these raw, paged reads MUST fail.
insert into public.users (id,username,email,phone,email_verified,created_at,updated_at)
values ('00000000-0000-4000-9000-000000000005','ar_unrelated','ar_unrelated@example.invalid','+8801900000005',1,'2026-10-23T00:00:00.000Z','2026-10-23T00:00:00.000Z');
insert into public.account_sanctions (id,user_id,kind,starts_at,reason_code,active,created_at)
values ('ar-foreign-warning','00000000-0000-4000-9000-000000000002','WARNING','','OTHER',true,'2026-10-23T00:00:00.000Z'),
       ('ar-foreign-restricted','00000000-0000-4000-9000-000000000002','RESTRICTED','','OTHER',true,'2026-10-23T00:00:00.000Z');
insert into public.appeals (id,appellant_user_id,subject_kind,subject_id,sanction_id,message,status,submitted_at)
values ('ar-foreign-open','00000000-0000-4000-9000-000000000002','SANCTION','ar-foreign-restricted','ar-foreign-restricted','Private foreign receipt','SUBMITTED','2026-10-23T00:00:00.000Z');
create temporary table ar_expected_sanctions as
select s.id,s.user_id,
  (select a.id from public.appeals a where a.appellant_user_id=s.user_id and a.status in ('SUBMITTED','UNDER_REVIEW')
    and ((a.subject_kind='SANCTION' and a.subject_id=s.id) or
         (a.subject_kind='MODERATION_ACTION' and a.subject_id in (select l.id from public.admin_audit_log l where l.new_state->>'sanction_id'=s.id)))
   order by a.submitted_at desc,a.id desc limit 1) as open_id
from public.account_sanctions s where s.active and s.revoked_at is null
  and (nullif(btrim(s.starts_at),'') is null or s.starts_at::timestamptz<=now())
  and (nullif(btrim(s.ends_at),'') is null or s.ends_at::timestamptz>now());
grant select on ar_expected_sanctions to authenticated;
set local role authenticated;
do $$ declare uid text; page jsonb; cursor jsonb; rows jsonb; n integer; begin
  foreach uid in array array['00000000-0000-4000-9000-000000000001','00000000-0000-4000-9000-000000000002','00000000-0000-4000-9000-000000000005','00000000-0000-4000-9000-000000000003'] loop
    perform set_config('request.jwt.claim.sub',uid,true);
    cursor := null; rows := '[]'::jsonb; n := 0;
    loop
      page := public.findback_my_appeal_subjects(1,cursor->>'created_at',cursor->>'subject_kind',cursor->>'subject_id');
      rows := rows || (page->'items'); cursor := page->'next_cursor'; n := n+1;
      if n>10 then raise exception 'AR16 pagination failed to terminate'; end if;
      exit when cursor='null'::jsonb;
    end loop;
    if jsonb_array_length(rows)<>(select count(*) from ar_expected_sanctions e where e.user_id=uid)
       or exists(select 1 from jsonb_array_elements(rows) r where not exists(
         select 1 from ar_expected_sanctions e where e.user_id=uid and e.id=r->>'subject_id'
           and r->>'subject_kind'='SANCTION' and r->>'target_type'='USER' and r->>'target_id'=uid
           and (r->>'open_appeal_id') is not distinct from e.open_id)) then
      raise exception 'AR16 foreign sanction/receipt leaked or own paged subject missing for %',uid;
    end if;
  end loop;
end $$;
reset role;

-- IR2: raw discovery must only expose the current adverse audit, not a
-- favorable/dismissal revision or an old adverse audit that still has a receipt.
-- The author is a NON-probation fixture account on purpose: this suite puts
-- user ...001 on probation at line 49, and the amended public-interaction clock
-- now spaces any author who is on probation - five system inserts in one
-- transaction included. Author identity is irrelevant to these moderation
-- targets, so the fixture uses a clean account instead of switching the clock off.
insert into public.users (id,username,email,phone,email_verified,created_at,updated_at)
values ('00000000-0000-4000-9000-000000000006','ar_content_owner','ar_content_owner@example.invalid','+8801900000006',1,'2026-10-23T00:00:00.000Z','2026-10-23T00:00:00.000Z');
insert into public.item_posts (id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
select 'ar-content-'||kind,'00000000-0000-4000-9000-000000000006','LOST','Content fixture','Description','Electronics','OPEN','2026-10-22','2026-10-23T00:00:00.000Z','2026-10-23T00:00:00.000Z'
from unnest(array['hide','remove','publish','dismiss','superseded']) kind;
-- Ownership moves to the probation fixture account afterwards: the appeals below
-- are submitted by the affected author, but five system inserts in one statement
-- cannot all pass the amended public-interaction clock for a probation author.
update public.item_posts set user_id='00000000-0000-4000-9000-000000000001'
 where id like 'ar-content-%';
create temporary table ar_expected_content (post_id text,old_audit text,current_audit text,receipt_id text,discover boolean);
do $$ declare kind text; old_id text; current_id text; receipt text; begin
  foreach kind in array array['hide','remove','publish','dismiss','superseded'] loop
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000003',true);
    old_id := public.findback_apply_moderation('POST','ar-content-'||kind,'HIDE','HARASSMENT',null);
    current_id := old_id; receipt := null;
    if kind in ('publish','dismiss','superseded') then
      perform set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000001',true);
      receipt := public.findback_submit_appeal('MODERATION_ACTION',old_id,'Retained original appeal');
    end if;
    if kind<>'hide' then
      perform set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000003',true);
      current_id := public.findback_apply_moderation('POST','ar-content-'||kind,
        case kind when 'publish' then 'PUBLISH' when 'dismiss' then 'NO_ACTION' else 'REMOVE' end,'OTHER',null);
    end if;
    insert into ar_expected_content values ('ar-content-'||kind,old_id,current_id,receipt,kind in ('hide','remove','superseded'));
  end loop;
end $$;
grant select on ar_expected_content to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000001',true);
do $$ declare rows jsonb; receipts jsonb; begin
  rows := public.findback_my_appeal_subjects()->'items';
  receipts := public.findback_my_appeals()->'items';
  if (select count(*) from jsonb_array_elements(rows) r where r->>'subject_kind'='MODERATION_ACTION')<>3
     or exists(select 1 from jsonb_array_elements(rows) r where r->>'subject_kind'='MODERATION_ACTION' and not exists(
       select 1 from ar_expected_content e where e.discover and e.current_audit=r->>'subject_id' and e.post_id=r->>'target_id'
         and r->>'target_type'='POST' and r->>'action'=case when e.post_id='ar-content-hide' then 'HIDE' else 'REMOVE' end
         and r->>'open_appeal_id' is null)) then
    raise exception 'AR17 favorable/dismissal/superseded audit leaked or current own POST missing';
  end if;
  if exists(select 1 from ar_expected_content e where e.receipt_id is not null and not exists(
    select 1 from jsonb_array_elements(receipts) r where r->>'id'=e.receipt_id and r->>'subject_id'=e.old_audit)) then
    raise exception 'AR18 superseded receipt lost its original durable identity';
  end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000005',true);
select 'AR19 unrelated owner has no content discovery or receipts' as probe
where public.findback_my_appeal_subjects()->'items'='[]'::jsonb and public.findback_my_appeals()->'items'='[]'::jsonb;
reset role;
rollback;
