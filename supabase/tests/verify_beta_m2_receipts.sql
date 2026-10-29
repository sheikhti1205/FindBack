-- Real R4 member-owner receipt regression; synthetic accounts, rollback only.
-- Catches request disclosure, unilateral opt-in, stale consent/connection/block
-- authority, lost-response retries and cross-account/device observation.
begin;
create temp table m2_receipt_checks(name text primary key, passed boolean not null) on commit drop;
grant all on m2_receipt_checks to authenticated;
create function pg_temp.m2_check(p_name text, p_pass boolean) returns void
language sql as $$ insert into m2_receipt_checks values(p_name,coalesce(p_pass,false)) $$;
create function pg_temp.m2_exchange(p_uid text,p_device text,p_action text,p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',p_uid,true);
 return public.findback_chat_exchange(p_uid,p_device,p_action,p_args);
end $$;
create function pg_temp.m2_view(p_uid text,p_device text,p_conversation text,p_ids jsonb default '[]'::jsonb)
returns jsonb language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',p_uid,true);
 return public.findback_chat_receipt_view(p_uid,p_device,p_conversation,p_ids);
end $$;
create function pg_temp.m2_observe(p_uid text,p_device text,p_conversation text,p_context text,p_message text)
returns boolean language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',p_uid,true);
 return public.findback_chat_receipt_observe(p_uid,p_device,p_conversation,p_context,p_message);
end $$;
create function pg_temp.m2_epoch(p_uid text,p_device text,p_conversation text)
returns text language sql as $$
 select item->>'epoch' from jsonb_array_elements(pg_temp.m2_exchange(p_uid,p_device,'VIEWS')) item
 where item->>'conversationId'=p_conversation
$$;

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9920-000000000001','beta_m2_receipt_a','beta_m2_ra@example.invalid','+8801992000001',1,now(),now()),
 ('00000000-0000-4000-9920-000000000002','beta_m2_receipt_b','beta_m2_rb@example.invalid','+8801992000002',1,now(),now()),
 ('00000000-0000-4000-9920-000000000003','beta_m2_receipt_c','beta_m2_rc@example.invalid','+8801992000003',1,now(),now());

set local role authenticated;
do $$
declare
 a constant text:='00000000-0000-4000-9920-000000000001';
 b constant text:='00000000-0000-4000-9920-000000000002';
 c constant text:='00000000-0000-4000-9920-000000000003';
 a1 constant text:='00000000-0000-4000-9920-000000000011';
 a2 constant text:='00000000-0000-4000-9920-000000000012';
 b1 constant text:='00000000-0000-4000-9920-000000000021';
 c1 constant text:='00000000-0000-4000-9920-000000000031';
 request_message constant text:='00000000-0000-4000-9920-000000000101';
 connected_message constant text:='00000000-0000-4000-9920-000000000102';
 conversation text; context text; refreshed text; view jsonb; denied boolean;
begin
 perform pg_temp.m2_exchange(a,a1,'REGISTER','{"platform":"web"}');
 perform pg_temp.m2_exchange(a,a2,'REGISTER','{"platform":"android"}');
 perform pg_temp.m2_exchange(b,b1,'REGISTER','{"platform":"web"}');
 perform pg_temp.m2_exchange(c,c1,'REGISTER','{"platform":"web"}');
 conversation:=pg_temp.m2_exchange(a,a1,'CREATE',jsonb_build_object('otherId',b))#>>'{}';
 perform pg_temp.m2_exchange(a,a1,'RECEIPTS','{"enabled":true}');
 perform pg_temp.m2_exchange(b,b1,'RECEIPTS','{"enabled":true}');
 perform pg_temp.m2_exchange(a,a1,'SEND',jsonb_build_object('conversationId',conversation,
  'recipientId',b,'messageId',request_message,'body','Request-stage receipt fixture',
  'messageType','TEXT','expectedEpoch',pg_temp.m2_epoch(a,a1,conversation)));
 perform pg_temp.m2_check('REQUEST has no receipt context even with mutual opt-in',
  pg_temp.m2_view(b,b1,conversation)='{"context":null,"readIds":[]}'::jsonb);
 perform pg_temp.m2_check('REQUEST observation never acknowledges a read',
  not pg_temp.m2_observe(b,b1,conversation,repeat('0',64),request_message));

 perform pg_temp.m2_exchange(b,b1,'ACCEPT',jsonb_build_object('conversationId',conversation,
  'expectedEpoch',pg_temp.m2_epoch(b,b1,conversation)));
 context:=pg_temp.m2_view(a,a1,conversation)->>'context';
 perform pg_temp.m2_check('CONNECTED mutual opt-in supplies an opaque receipt context',
  context is not null and length(context)=64);
 perform pg_temp.m2_check('accepting does not retroactively expose request-message reads',
  not pg_temp.m2_observe(b,b1,conversation,context,request_message));
 perform pg_temp.m2_exchange(a,a1,'SEND',jsonb_build_object('conversationId',conversation,
  'recipientId',b,'messageId',connected_message,'body','Connected receipt fixture',
  'messageType','TEXT','expectedEpoch',pg_temp.m2_epoch(a,a1,conversation)));
 perform pg_temp.m2_check('sender cannot mark their own outgoing message read',
  not pg_temp.m2_observe(a,a1,conversation,context,connected_message));
 perform pg_temp.m2_check('recipient observation commits under current mutual consent',
  pg_temp.m2_observe(b,b1,conversation,context,connected_message));
 perform pg_temp.m2_check('lost observation reply is safely retryable',
  pg_temp.m2_observe(b,b1,conversation,context,connected_message));
 view:=pg_temp.m2_view(a,a2,conversation,jsonb_build_array(request_message,connected_message));
 perform pg_temp.m2_check('other sender device sees exactly the connected accepted read',
  view->'readIds'=jsonb_build_array(connected_message));

 perform pg_temp.m2_exchange(b,b1,'RECEIPTS','{"enabled":false}');
 perform pg_temp.m2_check('one disabled preference removes context and read IDs',
  pg_temp.m2_view(a,a1,conversation,jsonb_build_array(connected_message))='{"context":null,"readIds":[]}'::jsonb);
 perform pg_temp.m2_check('old context cannot write while peer consent is disabled',
  not pg_temp.m2_observe(b,b1,conversation,context,connected_message));
 perform pg_temp.m2_exchange(b,b1,'RECEIPTS','{"enabled":true}');
 refreshed:=pg_temp.m2_view(a,a1,conversation)->>'context';
 perform pg_temp.m2_check('reenabling consent rotates authority and forgets prior read disclosure',
  refreshed is not null and refreshed<>context
  and pg_temp.m2_view(a,a1,conversation,jsonb_build_array(connected_message))->'readIds'='[]'::jsonb);
 perform pg_temp.m2_check('old consent cannot acknowledge after reenable',
  not pg_temp.m2_observe(b,b1,conversation,context,connected_message));
 perform pg_temp.m2_check('new consent permits a deliberate new observation',
  pg_temp.m2_observe(b,b1,conversation,refreshed,connected_message));

 perform pg_temp.m2_check('nonparticipant sees no receipt authority or read IDs',
  pg_temp.m2_view(c,c1,conversation,jsonb_build_array(connected_message))='{"context":null,"readIds":[]}'::jsonb);
 perform pg_temp.m2_check('nonparticipant cannot acknowledge with a known context',
  not pg_temp.m2_observe(c,c1,conversation,refreshed,connected_message));
 denied:=false;
 begin
  perform set_config('request.jwt.claim.sub',c,true);
  perform public.findback_chat_receipt_view(a,a1,conversation,jsonb_build_array(connected_message));
 exception when insufficient_privilege then denied:=true; end;
 perform pg_temp.m2_check('spoofed account is denied',denied);
 denied:=false;
 begin
  perform set_config('request.jwt.claim.sub',a,true);
  perform public.findback_chat_receipt_observe(a,b1,conversation,refreshed,connected_message);
 exception when insufficient_privilege then denied:=true; end;
 perform pg_temp.m2_check('foreign device is denied',denied);

 perform pg_temp.m2_exchange(a,a1,'END',jsonb_build_object('conversationId',conversation));
 perform pg_temp.m2_check('END removes cached read disclosure',
  pg_temp.m2_view(a,a1,conversation,jsonb_build_array(connected_message))='{"context":null,"readIds":[]}'::jsonb);
 perform pg_temp.m2_check('END fences stale in-flight observation',
  not pg_temp.m2_observe(b,b1,conversation,refreshed,connected_message));
 perform pg_temp.m2_exchange(a,a1,'SEND',jsonb_build_object('conversationId',conversation,
  'recipientId',b,'messageId','00000000-0000-4000-9920-000000000103','body','New approach',
  'messageType','TEXT','expectedEpoch',pg_temp.m2_epoch(a,a1,conversation)));
 perform pg_temp.m2_exchange(b,b1,'ACCEPT',jsonb_build_object('conversationId',conversation,
  'expectedEpoch',pg_temp.m2_epoch(b,b1,conversation)));
 context:=pg_temp.m2_view(a,a1,conversation)->>'context';
 perform pg_temp.m2_check('reconnection rotates context and never discloses the old connection read',
  context is not null and context<>refreshed
  and not pg_temp.m2_observe(b,b1,conversation,context,connected_message));
 perform pg_temp.m2_exchange(a,a1,'BLOCK',jsonb_build_object('conversationId',conversation));
 perform pg_temp.m2_check('block removes context without revealing private block state',
  pg_temp.m2_view(b,b1,conversation,jsonb_build_array(connected_message))='{"context":null,"readIds":[]}'::jsonb);
 perform pg_temp.m2_check('block fences stale in-flight observation',
  not pg_temp.m2_observe(b,b1,conversation,context,connected_message));
end $$;
reset role;
select count(*) as assertions, bool_and(passed) as passed from m2_receipt_checks;
do $$
declare failed text;
begin
 select string_agg(name, '; ' order by name) into failed from m2_receipt_checks where not passed;
 if failed is not null then raise exception 'M2 receipt regressions: %',failed; end if;
 if (select count(*) from m2_receipt_checks)<>22 then raise exception 'M2 receipt assertion count mismatch'; end if;
 raise notice 'M2_RECEIPTS_PASS=22';
end $$;
rollback;
