-- Synthetic disposable SQL engine contract for report context + static location.
-- Every write rolls back; no hosted identity or credential.
begin;
create function pg_temp.fixture_claim(p_user text,p_session text) returns void language plpgsql as $$ begin
 perform set_config('request.jwt.claim.sub',p_user,true);
 perform set_config('request.jwt.claims',jsonb_build_object('session_id',p_session)::text,true);
end $$;
grant execute on function pg_temp.fixture_claim(text,text) to authenticated;
-- Current-client admission; original payload/authority assertions stay intact.
create function pg_temp.ready_send(p_account text,p_device text,p_action text,p_args jsonb)
returns jsonb language plpgsql as $$ begin
 return public.findback_chat_exchange(p_account,p_device,p_action,p_args||jsonb_build_object('expectedHead',
  public.findback_chat_exchange(p_account,p_device,'HEAD',jsonb_build_object('conversationId',p_args->>'conversationId'))));
end $$;
grant execute on function pg_temp.ready_send(text,text,text,jsonb) to authenticated;
insert into public.users(id,username,email,phone,created_at,updated_at) values
 ('00000000-0000-4000-9800-000000000001','ctx_author','ctx_a@example.invalid','+100009800001',now(),now()),
 ('00000000-0000-4000-9800-000000000002','ctx_peer','ctx_b@example.invalid','+100009800002',now(),now()),
  ('00000000-0000-4000-9800-000000000003','ctx_outsider','ctx_c@example.invalid','+100009800003',now(),now());
insert into auth.users(id,email) select id::uuid,email from public.users where id like '00000000-0000-4000-9800-%';
insert into auth.sessions(id,user_id) values
 ('00000000-0000-4000-9800-000000000011','00000000-0000-4000-9800-000000000001'),
 ('00000000-0000-4000-9800-000000000021','00000000-0000-4000-9800-000000000002'),
 ('00000000-0000-4000-9800-000000000031','00000000-0000-4000-9800-000000000003');
-- Elevated fixture commit models separately tested Edge signature verification.
-- Exchange probes still execute as authenticated through production admission.
do $$ declare s record; c jsonb; begin
 for s in select id,user_id from auth.sessions where id::text like '00000000-0000-4000-9800-%' loop
  perform pg_temp.fixture_claim(s.user_id::text,s.id::text);
  c:=public.findback_device_enrollment_challenge(s.id::text,'04'||repeat('ab',64),'Context fixture','web');
  perform public.findback_device_enrollment_commit(s.user_id::text,s.id,(c->>'challengeId')::uuid);
 end loop;
end $$;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,latitude,longitude,
 location_label,created_at,updated_at)
values('00000000-0000-4000-9800-000000000101','00000000-0000-4000-9800-000000000001','FOUND',
 'Blue wallet','Found a blue wallet near the station','WALLET','OPEN','2026-10-30',23.8103,90.4125,
 'Near the station','2026-10-30T00:00:00Z','2026-10-30T00:00:00Z'),
 ('00000000-0000-4000-9800-000000000102','00000000-0000-4000-9800-000000000003','LOST',
 'Hidden report','Moderated away from ordinary readers','OTHER','OPEN','2026-10-30',null,null,null,
 '2026-10-30T00:00:00Z','2026-10-30T00:00:00Z');
update public.item_posts set moderation_visibility='HIDDEN' where id='00000000-0000-4000-9800-000000000102';

create function pg_temp.ctx_view(p_device text) returns jsonb language sql as $$
 select value from jsonb_array_elements(public.findback_chat_exchange(auth.uid()::text,p_device,'VIEWS','{}')) value
 where value->>'conversationId'=current_setting('ctx.conversation')
$$;
grant execute on function pg_temp.ctx_view(text) to authenticated;

set local role authenticated;
select pg_temp.fixture_claim('00000000-0000-4000-9800-000000000002','00000000-0000-4000-9800-000000000021');
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000021','REGISTER','{"platform":"android"}');
select pg_temp.fixture_claim('00000000-0000-4000-9800-000000000001','00000000-0000-4000-9800-000000000011');
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000011','REGISTER','{"platform":"web"}');
select set_config('ctx.conversation',public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000011',
 'CREATE','{"otherId":"00000000-0000-4000-9800-000000000002"}')#>>'{}',true);

-- Request-stage report context is the "Connect about this report" path.
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
 'messageId','00000000-0000-4000-9800-000000000201','body','Is this your wallet?','messageType','TEXT',
 'contextReportId','00000000-0000-4000-9800-000000000101',
 'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
do $$ declare v jsonb; begin
 select value into v from jsonb_array_elements(public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SYNC','{}')) value
  where value->'event'->'message'->>'id'='00000000-0000-4000-9800-000000000201';
 assert v->'event'->'message'->>'contextReportId'='00000000-0000-4000-9800-000000000101',
  'authorized mailbox carries the live report reference';
 assert v->'event'->'message'->>'messageType'='TEXT','report context stays a text message';
end $$;

-- A report the sender cannot read cannot be attached, and no id is echoed.
do $$ begin
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
   'messageId','00000000-0000-4000-9800-000000000202','body','Hidden context','messageType','TEXT',
   'contextReportId','00000000-0000-4000-9800-000000000102',
   'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
  raise exception 'unreadable report accepted';
 exception when insufficient_privilege then null; end;
end $$;

-- Request-stage location is refused before any coordinate is stored.
do $$ begin
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
   'messageId','00000000-0000-4000-9800-000000000203','body','','messageType','LOCATION',
   'location',jsonb_build_object('lat',23.81,'lng',90.41,'accuracy',25),
   'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
  raise exception 'request-stage location accepted';
 exception when insufficient_privilege then null; end;
end $$;

-- Connect, then the same explicit share is allowed with an empty caption.
select pg_temp.fixture_claim('00000000-0000-4000-9800-000000000002','00000000-0000-4000-9800-000000000021');
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000021','ACCEPT',jsonb_build_object(
 'conversationId',current_setting('ctx.conversation'),'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000021')->>'epoch'));
select pg_temp.fixture_claim('00000000-0000-4000-9800-000000000001','00000000-0000-4000-9800-000000000011');
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
 'messageId','00000000-0000-4000-9800-000000000204','body','','messageType','LOCATION',
 'location',jsonb_build_object('lat',23.8103,'lng',90.4125,'accuracy',25),
 'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
do $$ declare v jsonb; begin
 select value into v from jsonb_array_elements(public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SYNC','{}')) value
  where value->'event'->'message'->>'id'='00000000-0000-4000-9800-000000000204';
 assert v->'event'->'message'->>'messageType'='LOCATION','location keeps its own type';
 assert (v->'event'->'message'->'location'->>'lat')::double precision=23.8103,'latitude round-trips';
 assert (v->'event'->'message'->'location'->>'accuracy')::double precision=25,'accuracy round-trips';
 assert v->'event'->'message'->>'body'='','an empty caption still delivers';
end $$;

-- Bounded payload: out-of-range coordinates and a replayed id with new
-- coordinates are both refused.
-- A manually selected pin is not a device fix: no fabricated accuracy estimate.
select pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
 'messageId','00000000-0000-4000-9800-000000000208','body','','messageType','LOCATION',
 'location',jsonb_build_object('lat',23.81,'lng',90.413,'accuracy',null),
 'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
do $$ declare v jsonb; begin
 select value into v from jsonb_array_elements(public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SYNC','{}')) value
  where value->'event'->'message'->>'id'='00000000-0000-4000-9800-000000000208';
 assert v->'event'->'message'->'location'->'accuracy'='null'::jsonb,'manual pin retains unknown accuracy';
 assert (v->'event'->'message'->'location'->>'lng')::double precision=90.413,'manual approximate pin round-trips';
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
   'messageId','00000000-0000-4000-9800-000000000208','body','','messageType','LOCATION',
   'location',jsonb_build_object('lat',23.81,'lng',90.413,'accuracy',25),
   'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
  raise exception 'manual pin replay fabricated accuracy';
 exception when invalid_parameter_value then null; end;
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
   'messageId','00000000-0000-4000-9800-000000000209','body','','messageType','LOCATION',
   'location',jsonb_build_object('lat',23.81,'lng',90.413,'accuracy',0),
   'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
  raise exception 'zero device estimate accepted';
 exception when invalid_parameter_value then null; end;
end $$;
do $$ begin
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
   'messageId','00000000-0000-4000-9800-000000000205','body','','messageType','LOCATION',
   'location',jsonb_build_object('lat',91,'lng',90.41,'accuracy',25),
   'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
  raise exception 'out-of-range latitude accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
   'messageId','00000000-0000-4000-9800-000000000204','body','','messageType','LOCATION',
   'location',jsonb_build_object('lat',10,'lng',10,'accuracy',5),
   'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
  raise exception 'replay recast to another coordinate';
 exception when invalid_parameter_value then null; end;
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000011','SEND',jsonb_build_object(
   'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
   'messageId','00000000-0000-4000-9800-000000000206','body','caption','messageType','MEDIA',
   'contextReportId','00000000-0000-4000-9800-000000000101',
   'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000011')->>'epoch'));
  raise exception 'report context accepted on a media message';
 exception when invalid_parameter_value then null; end;
end $$;

-- The recipient resolves the same live id; a later-hidden report is no longer
-- readable, so the client renders "Report unavailable" instead of a snapshot.
select pg_temp.fixture_claim('00000000-0000-4000-9800-000000000002','00000000-0000-4000-9800-000000000021');
do $$ declare v jsonb; begin
 select value into v from jsonb_array_elements(public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000021','SYNC','{}')) value
  where value->'event'->'message'->>'id'='00000000-0000-4000-9800-000000000201';
 assert v->'event'->'message'->>'contextReportId'='00000000-0000-4000-9800-000000000101','recipient sees the same live id';
 assert public.findback_can_read_post('00000000-0000-4000-9800-000000000101'),'report is readable now';
end $$;
reset role;
update public.item_posts set moderation_visibility='HIDDEN' where id='00000000-0000-4000-9800-000000000101';
set local role authenticated;
do $$ begin
 assert not public.findback_can_read_post('00000000-0000-4000-9800-000000000101'),
  'a later-hidden report stops resolving for the recipient';
end $$;

-- Outsiders and closed callables stay closed.
select pg_temp.fixture_claim('00000000-0000-4000-9800-000000000003','00000000-0000-4000-9800-000000000031');
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9800-000000000031','REGISTER','{"platform":"web"}');
do $$ begin
 begin
  perform pg_temp.ready_send(auth.uid()::text,'00000000-0000-4000-9800-000000000031','SEND',jsonb_build_object(
   'conversationId',current_setting('ctx.conversation'),'recipientId','00000000-0000-4000-9800-000000000002',
   'messageId','00000000-0000-4000-9800-000000000207','body','not mine','messageType','TEXT',
   'expectedEpoch',pg_temp.ctx_view('00000000-0000-4000-9800-000000000031')->>'epoch'));
  raise exception 'nonparticipant send accepted';
 exception when insufficient_privilege then null; end;
 assert not has_function_privilege('authenticated','public.findback_chat_send_internal(text,text,text,text,text,jsonb)','execute'),
  'internal admission stays closed to clients';
end $$;
reset role;
select 'report context + static location SQL assertions passed' as result;
rollback;
