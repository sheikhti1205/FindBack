-- Disposable PostgreSQL behavior probe. No actual Storage or client is emulated.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9842-000000000001','delivery_a','delivery_a@example.invalid','+8801984200001',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9842-000000000002','delivery_b','delivery_b@example.invalid','+8801984200002',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z'),
 ('00000000-0000-4000-9842-000000000003','delivery_c','delivery_c@example.invalid','+8801984200003',1,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z');
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by) values
 ('delivery-conv','00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000002','REQUEST','00000000-0000-4000-9842-000000000001');
insert into public.chat_messages(id,conversation_id,sender_id,body) values
 ('delivery-message','delivery-conv','00000000-0000-4000-9842-000000000001','hello');
insert into public.chat_message_audience(message_id,user_id) values
 ('delivery-message','00000000-0000-4000-9842-000000000001'),('delivery-message','00000000-0000-4000-9842-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000001',true);
select public.findback_register_chat_device('00000000-0000-4000-9842-000000000011','web');
select public.findback_register_chat_device('00000000-0000-4000-9842-000000000012','web');
do $$ begin
 begin
  perform public.findback_reserve_chat_media('00000000-0000-4000-9842-000000000001','delivery-message','00000000-0000-4000-9842-000000000101');
  raise exception 'REQUEST accepted media';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000002',true);
select public.findback_register_chat_device('00000000-0000-4000-9842-000000000021','web');
reset role;
update public.chat_conversations set state='CONNECTED' where id='delivery-conv';
update public.chat_messages set receipt_connection_epoch=(select receipt_connection_epoch from public.chat_conversations where id='delivery-conv') where id='delivery-message';
-- Text is already acknowledged before attachment commit.
insert into public.chat_mailbox(device_id,message_id,conversation_id,acked_at)
select id,'delivery-message','delivery-conv',clock_timestamp() from public.chat_devices
 where user_id in('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000002');
select set_config('test.delivery.sequence',(select event_sequence::text from public.chat_messages where id='delivery-message'),true);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000001',true);
select public.findback_reserve_chat_media('00000000-0000-4000-9842-000000000001','delivery-message','00000000-0000-4000-9842-000000000101');
reset role;
select set_config('test.delivery.key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9842-000000000101'),true);
select set_config('test.delivery.gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9842-000000000101'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000101',current_setting('test.delivery.gen'),current_setting('test.delivery.key'),repeat('a',64),'image/jpeg',100,640,480);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000002',true);
do $$ declare x jsonb; begin
 x:=public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000021');
 if jsonb_array_length(x)<>1 or x->0->>'attachmentId'<>'00000000-0000-4000-9842-000000000101' then raise exception 'post-ACK delivery missing'; end if;
 if x::text ~* '(objectKey|bucket|generation)' then raise exception 'private metadata leaked'; end if;
 if x is distinct from public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000021') then raise exception 'fetch not idempotent'; end if;
 begin
  perform public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000011');
  raise exception 'cross-account fetch allowed';
  exception when insufficient_privilege then null; end;
 begin
  perform public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000011');
  raise exception 'foreign device fetch allowed';
 exception when insufficient_privilege then null; end;
 begin
  perform public.findback_ack_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000011','00000000-0000-4000-9842-000000000101');
  raise exception 'foreign account ACK allowed';
 exception when insufficient_privilege then null; end;
 begin
  perform public.findback_ack_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000011','00000000-0000-4000-9842-000000000101');
  raise exception 'foreign device ACK allowed';
 exception when insufficient_privilege then null; end;
 perform public.findback_ack_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000021','00000000-0000-4000-9842-000000000101');
 perform public.findback_ack_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000021','00000000-0000-4000-9842-000000000101');
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000021'))<>0 then raise exception 'ACK reappeared'; end if;
end $$;
select public.findback_register_chat_device('00000000-0000-4000-9842-000000000021','web');
select public.findback_register_chat_device('00000000-0000-4000-9842-000000000022','web');
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000021'))<>0 then raise exception 'reregistration resurrected ACK'; end if;
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000022'))<>1 then raise exception 'late device did not catch up'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000001',true);
select public.findback_block_user('00000000-0000-4000-9842-000000000002');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000002',true);
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000022'))<>0 then raise exception 'block did not suppress'; end if;
 begin
  perform public.findback_ack_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000022','00000000-0000-4000-9842-000000000101');
  raise exception 'blocked ACK allowed';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000001',true);
select public.findback_unblock_user('00000000-0000-4000-9842-000000000002');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000002',true);
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000022'))<>1 then raise exception 'unblock erased history'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000001',true);
select set_config('test.delivery.clear',public.findback_chat_exchange('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000012','CLEAR_FOR_ME',jsonb_build_object('conversationId','delivery-conv','throughSequence',current_setting('test.delivery.sequence')::bigint))#>>'{}',true);
do $$ begin
 if public.findback_chat_exchange('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000012','CLEAR_FOR_ME',jsonb_build_object('conversationId','delivery-conv','throughSequence',current_setting('test.delivery.sequence')::bigint))#>>'{}' <> current_setting('test.delivery.clear') then raise exception 'clear retry not idempotent'; end if;
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000012'))<>0 then raise exception 'clear did not suppress'; end if;
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.chat_state_events e join public.chat_state_audience a on a.event_id=e.id
  where e.id=current_setting('test.delivery.clear') and e.kind='CLEAR_FOR_ME' and e.through_sequence=current_setting('test.delivery.sequence')::bigint and a.user_id='00000000-0000-4000-9842-000000000001') then raise exception 'clear event/audience missing'; end if;
 if (select count(*) from public.chat_state_audience where event_id=current_setting('test.delivery.clear'))<>1 then raise exception 'clear audience not personal'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000002',true);
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000022'))<>1 then raise exception 'peer clear suppressed recipient'; end if;
end $$;
select public.findback_chat_exchange('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000022','DELETE_FOR_ME','{"conversationId":"delivery-conv","messageId":"delivery-message"}'::jsonb);
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000022'))<>0 then raise exception 'delete did not suppress'; end if;
 begin
  perform public.findback_ack_chat_media_delivery('00000000-0000-4000-9842-000000000002','00000000-0000-4000-9842-000000000022','00000000-0000-4000-9842-000000000101');
  raise exception 'suppressed ACK allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
delete from public.chat_state_events where id=current_setting('test.delivery.clear');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9842-000000000001',true);
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000012'))<>1 then raise exception 'author device missing'; end if;
end $$;
reset role;
update public.chat_media_attachments set expires_at=clock_timestamp()-interval '1 second' where id='00000000-0000-4000-9842-000000000101';
set local role authenticated;
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000012'))<>0 then raise exception 'expired delivery visible'; end if;
 begin
  perform public.findback_ack_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000012','00000000-0000-4000-9842-000000000101');
  raise exception 'expired ACK allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.chat_media_attachments set expires_at=clock_timestamp()+interval '1 day' where id='00000000-0000-4000-9842-000000000101';
set local role authenticated;
select public.findback_unsend_chat_message('delivery-message');
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000012'))<>0 then raise exception 'unsend did not suppress'; end if;
end $$;
reset role;
set local role anon;
do $$ begin
 begin
  perform public.findback_fetch_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000011');
  raise exception 'anonymous fetch allowed';
 exception when insufficient_privilege then null; end;
 begin
  perform public.findback_ack_chat_media_delivery('00000000-0000-4000-9842-000000000001','00000000-0000-4000-9842-000000000011','00000000-0000-4000-9842-000000000101');
  raise exception 'anonymous ACK allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS delivery behavioral checks' as result;
rollback;
