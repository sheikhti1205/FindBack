-- Coherent synthetic request -> accept -> send -> mailbox -> ACK flow.
-- Execute on a disposable test database after current chat migrations.
\set ON_ERROR_STOP on
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9832-000000000001','chat032_a','chat032_a@example.invalid','+8801983200001',1,'2026-10-26T00:00:00Z','2026-10-26T00:00:00Z'),
 ('00000000-0000-4000-9832-000000000002','chat032_b','chat032_b@example.invalid','+8801983200002',1,'2026-10-26T00:00:00Z','2026-10-26T00:00:00Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9832-000000000002',true);
select public.findback_register_chat_device('00000000-0000-4000-9832-000000000012','web');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9832-000000000001',true);
select public.findback_register_chat_device('00000000-0000-4000-9832-000000000011','web');
select public.findback_create_conversation('00000000-0000-4000-9832-000000000002') as conv \gset
select set_config('chat032.conv',:'conv',true);
-- Internal SEND must not be callable directly, even by a participant. Only the
-- exchange binds the captured account, registered installation and counterpart.
do $$ begin
 begin
  perform public.findback_send_chat_message(current_setting('chat032.conv'),'Direct bypass','00000000-0000-4000-9832-000000000026');
  raise exception 'authenticated executed internal SEND directly';
 exception when insufficient_privilege then
  if sqlerrm not like 'permission denied for function %' then raise; end if;
 end;
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9832-000000000001','00000000-0000-4000-9832-000000000099','SEND',
   jsonb_build_object('conversationId',current_setting('chat032.conv'),'recipientId','00000000-0000-4000-9832-000000000002','body','Unregistered device','messageId','00000000-0000-4000-9832-000000000027'));
  raise exception 'unregistered installation sent through exchange';
 exception when insufficient_privilege then
  if sqlerrm <> 'Device unavailable' then raise; end if;
 end;
 raise notice 'PASS direct internal SEND denied; unregistered exchange SEND denied';
end $$;
select public.findback_chat_exchange('00000000-0000-4000-9832-000000000001','00000000-0000-4000-9832-000000000011','SEND',
 jsonb_build_object('conversationId',:'conv','recipientId','00000000-0000-4000-9832-000000000002','body','First explanation','messageId','00000000-0000-4000-9832-000000000021'));
do $$ begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9832-000000000002','00000000-0000-4000-9832-000000000011','SYNC','{}');
  raise exception 'account-switch guard missing';
 exception when insufficient_privilege then null; end;
 if jsonb_array_length(public.findback_chat_exchange('00000000-0000-4000-9832-000000000001','00000000-0000-4000-9832-000000000011','SYNC','{}'))<>1 then
  raise exception 'sender durable echo missing';
 end if;
end $$;
select public.findback_chat_exchange('00000000-0000-4000-9832-000000000001','00000000-0000-4000-9832-000000000011','SEND',
 jsonb_build_object('conversationId',:'conv','recipientId','00000000-0000-4000-9832-000000000002','body','Follow-up explanation','messageId','00000000-0000-4000-9832-000000000022'));
do $$ begin
 begin
  perform public.findback_chat_exchange('00000000-0000-4000-9832-000000000001','00000000-0000-4000-9832-000000000011','SEND',
   jsonb_build_object('conversationId',current_setting('chat032.conv'),'recipientId','00000000-0000-4000-9832-000000000001','body','Wrong counterpart','messageId','00000000-0000-4000-9832-000000000025'));
  raise exception 'wrong-counterpart message sent';
 exception when insufficient_privilege then null; end;
end $$;
-- Same client identity retries are idempotent, not additional messages/wakes.
select public.findback_chat_exchange('00000000-0000-4000-9832-000000000001','00000000-0000-4000-9832-000000000011','SEND',
 jsonb_build_object('conversationId',:'conv','recipientId','00000000-0000-4000-9832-000000000002','body','First explanation','messageId','00000000-0000-4000-9832-000000000021'));
reset role;
do $$ begin
 if (select count(*) from public.chat_messages where conversation_id=current_setting('chat032.conv'))<>2 then raise exception 'send retry duplicated messages'; end if;
 if (select count(*) from public.chat_mailbox where conversation_id=current_setting('chat032.conv'))<>4 then raise exception 'sender echo / recipient fanout missing'; end if;
 if (select count(*) from public.chat_messages where conversation_id=current_setting('chat032.conv') and first_approach)<>1 then raise exception 'request nudge must be first only'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9832-000000000002',true);
do $$ begin
 begin
   perform public.findback_chat_exchange('00000000-0000-4000-9832-000000000002','00000000-0000-4000-9832-000000000012','SEND',
    jsonb_build_object('conversationId',current_setting('chat032.conv'),'recipientId','00000000-0000-4000-9832-000000000001','body','Cannot reply before accepting','messageId','00000000-0000-4000-9832-000000000023'));
  raise exception 'recipient sent during REQUEST';
 exception when insufficient_privilege then null; end;
 perform public.findback_mark_chat_read('00000000-0000-4000-9832-000000000021');
end $$;
reset role;
do $$ begin
 if exists(select 1 from public.chat_messages where conversation_id=current_setting('chat032.conv') and read_at is not null) then raise exception 'request receipt written'; end if;
end $$;
set local role authenticated;
select public.findback_accept_conversation(:'conv');
select public.findback_set_chat_receipts(true);
select public.findback_mark_chat_read('00000000-0000-4000-9832-000000000021');
reset role;
do $$ begin
 if exists(select 1 from public.chat_messages where conversation_id=current_setting('chat032.conv') and read_at is not null) then raise exception 'one-sided receipt consent leaked'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9832-000000000001',true);
select public.findback_set_chat_receipts(true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9832-000000000002',true);
select public.findback_mark_chat_read('00000000-0000-4000-9832-000000000021');
-- Block must use the canonical directional block owner, not alter relationship.
select public.findback_block_conversation(:'conv');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9832-000000000001',true);
select public.findback_chat_exchange('00000000-0000-4000-9832-000000000001','00000000-0000-4000-9832-000000000011','SEND',
 jsonb_build_object('conversationId',:'conv','recipientId','00000000-0000-4000-9832-000000000002','body','Opaque withheld send','messageId','00000000-0000-4000-9832-000000000024'));
reset role;
do $$ begin
 if (select state from public.chat_conversations where id=current_setting('chat032.conv'))<>'CONNECTED' then raise exception 'block replaced relationship mode'; end if;
 if not exists(select 1 from public.chat_messages where id='00000000-0000-4000-9832-000000000021' and read_at is not null) then raise exception 'mutual accepted read missing'; end if;
 if exists(select 1 from public.chat_mailbox m join public.chat_devices d on d.id=m.device_id where m.message_id='00000000-0000-4000-9832-000000000024' and d.user_id='00000000-0000-4000-9832-000000000002') then raise exception 'blocked recipient received delivery'; end if;
 if not exists(select 1 from public.user_blocks where blocker_user_id='00000000-0000-4000-9832-000000000002' and blocked_user_id='00000000-0000-4000-9832-000000000001') then raise exception 'canonical block missing'; end if;
end $$;
set local role authenticated;
select public.findback_end_conversation(:'conv');
reset role;
do $$ begin
 if not exists(select 1 from public.chat_conversations where id=current_setting('chat032.conv') and state='REQUEST' and initiated_by is null) then raise exception 'End did not reset approach ownership'; end if;
end $$;
-- Cleanup must discard ACKed payload, not keep delivered server history forever.
set local role authenticated;
select env as envelope from public.findback_fetch_chat_mailbox('00000000-0000-4000-9832-000000000011') env limit 1 \gset
select set_config('chat032.mailbox',(:'envelope')::jsonb->>'mailboxId',true);
select public.findback_ack_chat_message(current_setting('chat032.mailbox'),'00000000-0000-4000-9832-000000000012');
reset role;
do $$ begin
 if exists(select 1 from public.chat_mailbox where id=current_setting('chat032.mailbox') and acked_at is not null) then raise exception 'wrong-device ACK accepted'; end if;
end $$;
set local role authenticated;
select public.findback_ack_chat_message(current_setting('chat032.mailbox'),'00000000-0000-4000-9832-000000000011');
reset role;
do $$ begin
 if not exists(select 1 from public.chat_mailbox where id=current_setting('chat032.mailbox') and acked_at is not null) then raise exception 'own-device ACK missing'; end if;
end $$;
update public.chat_mailbox set acked_at=clock_timestamp() where conversation_id=:'conv';
select public.findback_cleanup_chat_mailbox();
do $$ begin
 if exists(select 1 from public.chat_mailbox where conversation_id=current_setting('chat032.conv')) then raise exception 'ACKed envelopes retained'; end if;
 raise notice 'PASS request/accept/retry/consent/block/end/delivery/retention flow';
end $$;
rollback;
