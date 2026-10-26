-- CF-CHAT-AUTH-031: execute as a test database owner after chat migrations.
-- Uses only synthetic records and rolls them back. Not a hosted acceptance gate.
\set ON_ERROR_STOP on
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9831-000000000001','chat031_a','chat031_a@example.invalid','+8801983100001',1,'2026-10-26T00:00:00Z','2026-10-26T00:00:00Z'),
 ('00000000-0000-4000-9831-000000000002','chat031_b','chat031_b@example.invalid','+8801983100002',1,'2026-10-26T00:00:00Z','2026-10-26T00:00:00Z'),
 ('00000000-0000-4000-9831-000000000003','chat031_c','chat031_c@example.invalid','+8801983100003',1,'2026-10-26T00:00:00Z','2026-10-26T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,initiated_by,updated_at) values
 ('chat031-pair','00000000-0000-4000-9831-000000000001','00000000-0000-4000-9831-000000000002','00000000-0000-4000-9831-000000000001','2026-10-26T00:00:00Z');
create temp table chat031_results(label text primary key, passed boolean not null, detail text);
grant select,insert on chat031_results to authenticated;
create function pg_temp.chat031_try_accept(p_id text) returns text language plpgsql as $$
begin
  perform public.findback_accept_conversation(p_id);
  return 'OK';
exception when others then return sqlstate || '|' || sqlerrm;
end;
$$;

insert into chat031_results values
 ('A01 authenticated execute granted',has_function_privilege('authenticated','public.findback_accept_conversation(text)','execute'),null),
 ('A02 anon execute denied',not has_function_privilege('anon','public.findback_accept_conversation(text)','execute'),null),
 ('A03 PUBLIC execute denied',not exists (
    select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid='public.findback_accept_conversation(text)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'
  ),null);

set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
insert into chat031_results select 'A04 unauthenticated denied', result like '28000|%', result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9831-000000000003',true);
insert into chat031_results select 'A05 outsider denied', result='42501|Conversation unavailable', result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
insert into chat031_results select 'A06 missing opaque', result='42501|Conversation unavailable', result
 from (select pg_temp.chat031_try_accept('chat031-does-not-exist') result) q;
insert into chat031_results select 'A07 null opaque', result='42501|Conversation unavailable', result
 from (select pg_temp.chat031_try_accept(null) result) q;
reset role;
insert into chat031_results select 'A08 outsider did not mutate',
 state='REQUEST' and updated_at='2026-10-26T00:00:00Z'::timestamptz,state
 from public.chat_conversations where id='chat031-pair';

-- Reset even on the old vulnerable implementation so each assertion is independent.
update public.chat_conversations set state='REQUEST',updated_at='2026-10-26T00:00:00Z' where id='chat031-pair';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9831-000000000001',true);
insert into chat031_results select 'A09 initiator denied', result like '42501|%', result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
reset role;
insert into chat031_results select 'A10 initiator did not mutate',state='REQUEST',state from public.chat_conversations where id='chat031-pair';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9831-000000000002',true);
insert into chat031_results select 'A11 recipient accepts',result='OK',result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
reset role;
insert into chat031_results select 'A12 accepted once',state='CONNECTED' and updated_at>'2026-10-26T00:00:00Z'::timestamptz,state
 from public.chat_conversations where id='chat031-pair';
create temp table chat031_accepted_at as select updated_at from public.chat_conversations where id='chat031-pair';
set local role authenticated;
insert into chat031_results select 'A13 connected retry rejected',result like 'P0001|%',result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
reset role;
insert into chat031_results select 'A14 retry leaves timestamp',
 c.updated_at=t.updated_at,null from public.chat_conversations c cross join chat031_accepted_at t where c.id='chat031-pair';

update public.chat_conversations set state='BLOCKED' where id='chat031-pair';
set local role authenticated;
insert into chat031_results select 'A15 blocked rejected',result like 'P0001|%',result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
reset role;
insert into chat031_results select 'A16 block retained',state='BLOCKED',state from public.chat_conversations where id='chat031-pair';
update public.chat_conversations set state='ENDED' where id='chat031-pair';
set local role authenticated;
insert into chat031_results select 'A17 ended rejected',result like 'P0001|%',result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
reset role;

-- Corrupt legacy data must not grant a third initiator an acceptance path.
update public.chat_conversations set state='REQUEST', initiated_by='00000000-0000-4000-9831-000000000003' where id='chat031-pair';
set local role authenticated;
insert into chat031_results select 'A18 invalid initiator denied',result='42501|Conversation unavailable',result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
reset role;
insert into chat031_results select 'A19 invalid row unchanged',state='REQUEST',state from public.chat_conversations where id='chat031-pair';

-- Pair order must not matter: A initiates as user_b and B accepts as user_a.
update public.chat_conversations set user_a='00000000-0000-4000-9831-000000000002',
 user_b='00000000-0000-4000-9831-000000000001', initiated_by='00000000-0000-4000-9831-000000000001',state='REQUEST'
 where id='chat031-pair';
set local role authenticated;
insert into chat031_results select 'A20 reversed pair recipient accepts',result='OK',result
 from (select pg_temp.chat031_try_accept('chat031-pair') result) q;
reset role;
insert into chat031_results select 'A21 reversed pair connected',state='CONNECTED',state from public.chat_conversations where id='chat031-pair';

table chat031_results;
do $$ declare failures text; n integer; begin
  select count(*),string_agg(label || ': ' || coalesce(detail,'null'), E'\n') filter(where not passed)
    into n,failures from chat031_results;
  if n<>21 then raise exception 'Expected 21 assertions, got %',n; end if;
  if failures is not null then raise exception 'Chat acceptance authorization failures:%',E'\n'||failures; end if;
  raise notice 'PASS 21 chat acceptance authorization assertions';
end $$;
rollback;
