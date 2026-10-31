-- Synthetic disposable SQL engine contract. Every write rolls back.
begin;
insert into public.users(id,username,email,phone,created_at,updated_at)
select '00000000-0000-4000-9700-'||lpad(n::text,12,'0'),'mute_person_'||n,
 'mute_'||n||'@example.invalid','+100009700'||n,now(),now() from generate_series(1,3)n;
insert into public.device_tokens(id,user_id,token,platform,created_at,updated_at) values
 ('00000000-0000-4000-9700-000000000021','00000000-0000-4000-9700-000000000002','synthetic-mute-device','android',now(),now());
create function pg_temp.mute_view(p_device text) returns jsonb language sql as $$
 select value from jsonb_array_elements(public.findback_chat_exchange(auth.uid()::text,p_device,'VIEWS','{}')) value
 where value->>'conversationId'=current_setting('mute.conversation')
$$;
grant execute on function pg_temp.mute_view(text) to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000021','REGISTER','{"platform":"android"}');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000011','REGISTER','{"platform":"web"}');
select set_config('mute.conversation',public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000011','CREATE','{"otherId":"00000000-0000-4000-9700-000000000002"}')#>>'{}',true);
-- CREATE deliberately does not expose a member to the peer. First contact does.
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('mute.conversation'),'recipientId','00000000-0000-4000-9700-000000000002',
 'messageId','00000000-0000-4000-9700-000000000101','body','A queued request remains deliverable','messageType','TEXT',
 'expectedEpoch',pg_temp.mute_view('00000000-0000-4000-9700-000000000011')->>'epoch'));
select set_config('mute.a_revision',pg_temp.mute_view('00000000-0000-4000-9700-000000000011')->>'revision',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000021','REGISTER','{"platform":"android"}');
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000022','REGISTER','{"platform":"web"}');
do $$ declare v jsonb:=pg_temp.mute_view('00000000-0000-4000-9700-000000000021'); begin
 assert v->'ownMuted'='false'::jsonb,'new member exposes own mute default, not peer state';
 perform set_config('mute.revision',v->>'revision',true);perform set_config('mute.epoch',v->>'epoch',true);
 assert public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9700-000000000021',current_setting('mute.conversation'),true), 'setter confirms explicit mute';
 v:=pg_temp.mute_view('00000000-0000-4000-9700-000000000022');
 assert v->'ownMuted'='true'::jsonb and (v->>'revision')::bigint=current_setting('mute.revision')::bigint+1,'other own installation sees changed member revision';
 assert v->>'epoch'=current_setting('mute.epoch') and v->>'mode'='REQUEST','mute is not a relationship boundary';
 assert not(v?'peerMuted'),'no peer mute disclosure';
 perform public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9700-000000000021',current_setting('mute.conversation'),true);
 assert pg_temp.mute_view('00000000-0000-4000-9700-000000000022')->>'revision'=v->>'revision','idempotent mute does not create a new revision';
 begin
  perform public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9700-000000000099',current_setting('mute.conversation'),false);
  raise exception 'unknown device accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.findback_chat_set_muted('00000000-0000-4000-9700-000000000001','00000000-0000-4000-9700-000000000021',current_setting('mute.conversation'),false);
  raise exception 'foreign account accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9700-000000000021',current_setting('mute.conversation'),null);
  raise exception 'null mute accepted';
 exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000003',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000031','REGISTER','{"platform":"web"}');
do $$ begin
 begin
  perform public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9700-000000000031',current_setting('mute.conversation'),true);
  raise exception 'nonparticipant accepted';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$ declare v jsonb:=pg_temp.mute_view('00000000-0000-4000-9700-000000000011'); begin
 assert v->'ownMuted'='false'::jsonb and v->>'revision'=current_setting('mute.a_revision'),'peer stays unmuted without revision disclosure';
end $$;
-- Request delivery and audience are unaffected, but a queued request nudge is suppressed.
reset role;
do $$ declare claim record; begin
 assert exists(select 1 from public.chat_mailbox m join public.chat_devices d on d.id=m.device_id where m.message_id='00000000-0000-4000-9700-000000000101' and d.device_id='00000000-0000-4000-9700-000000000021'),'mute does not suppress mailbox delivery';
 assert exists(select 1 from public.chat_message_audience where message_id='00000000-0000-4000-9700-000000000101' and user_id='00000000-0000-4000-9700-000000000002'),'mute does not suppress audience';
 select * into claim from public.findback_claim_chat_external_wakes(1);
 assert claim.wake_id is not null,'nudge was queued before eligibility check';
 assert public.findback_chat_external_wake_delivery(claim.wake_id,claim.device_id,claim.claim_token) is null,'muted request nudge suppressed at final eligibility';
 perform set_config('mute.wake_id',claim.wake_id,true);perform set_config('mute.claim',claim.claim_token,true);
 assert not has_table_privilege('authenticated','public.chat_member_state','select'),'private member table stays closed';
 assert not has_function_privilege('anon','public.findback_chat_set_muted(text,text,text,boolean)','execute'),'anonymous setter is revoked';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
do $$ begin
 assert not public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9700-000000000022',current_setting('mute.conversation'),false),'unmute confirms false';
end $$;
reset role;
do $$ begin
 assert public.findback_chat_external_wake_delivery(current_setting('mute.wake_id'),'00000000-0000-4000-9700-000000000021',current_setting('mute.claim'))->>'kind'='CHAT_REQUEST','unmute restores eligible request nudge';
end $$;
set local role authenticated;
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000021','ACCEPT',jsonb_build_object('conversationId',current_setting('mute.conversation'),'expectedEpoch',pg_temp.mute_view('00000000-0000-4000-9700-000000000021')->>'epoch'));
select public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9700-000000000021',current_setting('mute.conversation'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000011','SEND',jsonb_build_object(
 'conversationId',current_setting('mute.conversation'),'recipientId','00000000-0000-4000-9700-000000000002',
 'messageId','00000000-0000-4000-9700-000000000102','body','Connected delivery still works','messageType','TEXT',
 'expectedEpoch',pg_temp.mute_view('00000000-0000-4000-9700-000000000011')->>'epoch'));
reset role;
do $$ declare claim record; begin
 select d.wake_id,d.device_id,d.claim_token into claim from public.findback_claim_chat_external_wakes(100) d
 join public.chat_external_wakes w on w.id=d.wake_id where w.message_id='00000000-0000-4000-9700-000000000102';
 assert claim.wake_id is not null,'connected wake still queued';
 assert public.findback_chat_external_wake_delivery(claim.wake_id,claim.device_id,claim.claim_token)->>'kind'='CHAT_CONNECTED','mute preserves connected silent data wake';
 assert exists(select 1 from public.chat_mailbox m join public.chat_devices d on d.id=m.device_id where m.message_id='00000000-0000-4000-9700-000000000102' and d.device_id='00000000-0000-4000-9700-000000000021'),'connected mailbox delivery preserved';
end $$;
-- Preference survives relationship changes; it is not relationship authority.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
select public.findback_chat_exchange(auth.uid()::text,'00000000-0000-4000-9700-000000000021','END',jsonb_build_object('conversationId',current_setting('mute.conversation')));
do $$ begin
 assert pg_temp.mute_view('00000000-0000-4000-9700-000000000022')->'ownMuted'='true'::jsonb,'own mute survives end without creating new preference owner';
end $$;
reset role;
insert into public.account_deletion_fences(user_id) values('00000000-0000-4000-9700-000000000002');
set local role authenticated;
do $$ begin
 begin
  perform public.findback_chat_set_muted(auth.uid()::text,'00000000-0000-4000-9700-000000000021',current_setting('mute.conversation'),false);
  raise exception 'deleting account accepted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'per-user mute SQL assertions passed' as result;
rollback;
