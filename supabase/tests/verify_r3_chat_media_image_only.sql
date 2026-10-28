-- Image-only chat messages: send contract, authorization parity and delivery.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9860-000000000001','media860_a','media860_a@example.invalid','+8801986000001',1,now(),now()),
 ('00000000-0000-4000-9860-000000000002','media860_b','media860_b@example.invalid','+8801986000002',1,now(),now()),
 ('00000000-0000-4000-9860-000000000003','media860_c','media860_c@example.invalid','+8801986000003',1,now(),now());
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('media860-connected','00000000-0000-4000-9860-000000000001','00000000-0000-4000-9860-000000000002','CONNECTED','00000000-0000-4000-9860-000000000001','media860-epoch'),
 ('media860-request','00000000-0000-4000-9860-000000000001','00000000-0000-4000-9860-000000000003','REQUEST',null,null);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
select public.findback_register_chat_device('00000000-0000-4000-9860-000000000010','web');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000002',true);
select public.findback_register_chat_device('00000000-0000-4000-9860-000000000011','web');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
do $$
declare v_id text; v_result jsonb; v_mailbox text; v_epoch text; v_first boolean;
begin
 -- TEXT keeps its exact behaviour: a blank body is still refused.
 begin
  perform public.findback_send_chat_message('media860-connected','  ','00000000-0000-4000-9860-000000000101','TEXT');
  raise exception 'blank TEXT accepted';
 exception when invalid_parameter_value then null; end;
 -- An image-only message needs no caption.
 v_id:=public.findback_send_chat_message('media860-connected','','00000000-0000-4000-9860-000000000102','MEDIA');
 if not exists(select 1 from public.chat_messages where id=v_id and message_type='MEDIA' and body='') then raise exception 'empty MEDIA not stored'; end if;
 -- A request-stage message stays text-only.
 begin
  perform public.findback_send_chat_message('media860-request','','00000000-0000-4000-9860-000000000103','MEDIA');
  raise exception 'request MEDIA accepted';
 exception when insufficient_privilege then null; end;
 -- A caption is allowed and stored verbatim.
 v_id:=public.findback_send_chat_message('media860-connected','caption','00000000-0000-4000-9860-000000000104','MEDIA');
 if not exists(select 1 from public.chat_messages where id=v_id and message_type='MEDIA' and body='caption') then raise exception 'caption not stored'; end if;
 select receipt_connection_epoch,first_approach into v_epoch,v_first from public.chat_messages where id=v_id;
 if v_epoch is distinct from 'media860-epoch' or v_first is not false then raise exception 'MEDIA provenance not captured'; end if;
 -- Replay is idempotent and writes nothing, including provenance.
 if public.findback_send_chat_message('media860-connected','caption','00000000-0000-4000-9860-000000000104','MEDIA')<>v_id then raise exception 'replay identity changed'; end if;
 if not exists(select 1 from public.chat_messages where id=v_id and message_type='MEDIA' and body='caption'
  and receipt_connection_epoch is not distinct from v_epoch and first_approach is not distinct from v_first) then
  raise exception 'replay changed provenance'; end if;
 -- The type is part of the message identity: a TEXT id must not be acknowledged
 -- as a MEDIA send, or the client would render the wrong thing.
 begin
  perform public.findback_send_chat_message('media860-connected','caption','00000000-0000-4000-9860-000000000104','TEXT');
  raise exception 'cross-type replay accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.findback_send_chat_message('media860-connected','changed','00000000-0000-4000-9860-000000000104','MEDIA');
  raise exception 'changed replay accepted';
 exception when invalid_parameter_value then null; end;
 if not exists(select 1 from public.chat_messages where id=v_id and message_type='MEDIA' and body='caption') then raise exception 'replay changed data'; end if;
 begin
  perform public.findback_send_chat_message('media860-connected','x','00000000-0000-4000-9860-000000000105','UNKNOWN');
  raise exception 'unknown type accepted';
 exception when invalid_parameter_value then null; end;
 -- The three-argument call still resolves for an old client.
 v_id:=public.findback_send_chat_message('media860-connected','legacy','00000000-0000-4000-9860-000000000106');
 if not exists(select 1 from public.chat_messages where id=v_id and message_type='TEXT' and body='legacy') then raise exception 'legacy send failed'; end if;
 -- A legitimate TEXT replay still works, and the reverse cross-type direction
 -- is refused too: a MEDIA send must not be acknowledged for a TEXT id.
 if public.findback_send_chat_message('media860-connected','legacy','00000000-0000-4000-9860-000000000106')<>v_id then raise exception 'TEXT replay identity changed'; end if;
 begin
  perform public.findback_send_chat_message('media860-connected','legacy','00000000-0000-4000-9860-000000000106','MEDIA');
  raise exception 'TEXT id replayed as MEDIA';
 exception when invalid_parameter_value then null; end;
 -- An omitted body is the same message as an empty one.
 v_id:=public.findback_send_chat_message('media860-connected',null,'00000000-0000-4000-9860-000000000109','MEDIA');
 if not exists(select 1 from public.chat_messages where id=v_id and message_type='MEDIA' and body='') then raise exception 'null body MEDIA not stored as empty'; end if;
 -- The exchange passes the type through and defaults to TEXT when absent.
 v_result:=public.findback_chat_exchange('00000000-0000-4000-9860-000000000001','00000000-0000-4000-9860-000000000010','SEND',
  '{"conversationId":"media860-connected","recipientId":"00000000-0000-4000-9860-000000000002","messageId":"00000000-0000-4000-9860-000000000107","body":"","messageType":"MEDIA"}'::jsonb);
 if not exists(select 1 from public.chat_messages where id=v_result#>>'{}' and message_type='MEDIA' and body='') then raise exception 'exchange MEDIA failed'; end if;
 v_result:=public.findback_chat_exchange('00000000-0000-4000-9860-000000000001','00000000-0000-4000-9860-000000000010','SEND',
  '{"conversationId":"media860-connected","recipientId":"00000000-0000-4000-9860-000000000002","messageId":"00000000-0000-4000-9860-000000000108","body":"old client"}'::jsonb);
 if not exists(select 1 from public.chat_messages where id=v_result#>>'{}' and message_type='TEXT' and body='old client') then raise exception 'exchange default failed'; end if;
 -- MEDIA must not widen the participant boundary.
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000003',true);
 begin
  perform public.findback_send_chat_message('media860-connected','','00000000-0000-4000-9860-000000000110','MEDIA');
  raise exception 'non-participant MEDIA accepted';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
 -- Simulate a purged TEXT body while its mailbox row still exists.
 update public.chat_messages set body='' where id='00000000-0000-4000-9860-000000000106';
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000002',true);
 select e->>'mailboxId' into v_mailbox from public.findback_fetch_chat_mailbox('00000000-0000-4000-9860-000000000011') e
  where e#>>'{event,message,id}'='00000000-0000-4000-9860-000000000102'
   and e#>>'{event,message,body}'='' and e#>>'{event,kind}'='TEXT';
 if v_mailbox is null then raise exception 'peer did not receive image-only envelope'; end if;
 if exists(select 1 from public.findback_fetch_chat_mailbox('00000000-0000-4000-9860-000000000011') e
  where e#>>'{event,message,id}'='00000000-0000-4000-9860-000000000106') then
  raise exception 'purged TEXT returned'; end if;
 perform public.findback_ack_chat_message(v_mailbox,'00000000-0000-4000-9860-000000000011');
 perform public.findback_cleanup_chat_mailbox();
 if not exists(select 1 from public.chat_messages where id='00000000-0000-4000-9860-000000000102' and message_type='MEDIA' and body='') then
  raise exception 'cleanup corrupted MEDIA'; end if;
 -- A blocked pair gains no delivery through MEDIA, and unblocking must not
 -- release a row that was withheld at send time.
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
 perform public.findback_block_conversation('media860-connected');
 perform public.findback_send_chat_message('media860-connected','','00000000-0000-4000-9860-000000000111','MEDIA');
 -- The author's own echo must exist, or the peer assertion below would pass
 -- because nothing was enqueued for anyone.
 if not exists(select 1 from public.findback_fetch_chat_mailbox('00000000-0000-4000-9860-000000000010') e
  where e#>>'{event,message,id}'='00000000-0000-4000-9860-000000000111') then
  raise exception 'blocked send produced no author echo'; end if;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000002',true);
 if exists(select 1 from public.findback_fetch_chat_mailbox('00000000-0000-4000-9860-000000000011') e
  where e#>>'{event,message,id}'='00000000-0000-4000-9860-000000000111') then
  raise exception 'blocked peer received MEDIA'; end if;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
 perform public.findback_unblock_user('00000000-0000-4000-9860-000000000002');
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000002',true);
 if exists(select 1 from public.findback_fetch_chat_mailbox('00000000-0000-4000-9860-000000000011') e
  where e#>>'{event,message,id}'='00000000-0000-4000-9860-000000000111') then
  raise exception 'unblock released a withheld MEDIA row'; end if;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
 perform public.findback_send_chat_message('media860-connected','','00000000-0000-4000-9860-000000000112','MEDIA');
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000002',true);
 if not exists(select 1 from public.findback_fetch_chat_mailbox('00000000-0000-4000-9860-000000000011') e
  where e#>>'{event,message,id}'='00000000-0000-4000-9860-000000000112') then
  raise exception 'post-unblock MEDIA not delivered'; end if;
 -- Leaving CONNECTED refuses a NEW media send but still answers an idempotent
 -- replay: a client that lost the response must not be told its stored message
 -- failed.
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-9860-000000000001',true);
 perform public.findback_end_conversation('media860-connected');
 if public.findback_send_chat_message('media860-connected','caption','00000000-0000-4000-9860-000000000104','MEDIA')
  <> '00000000-0000-4000-9860-000000000104' then
  raise exception 'replay after END did not return the stored message'; end if;
 begin
  perform public.findback_send_chat_message('media860-connected','','00000000-0000-4000-9860-000000000113','MEDIA');
  raise exception 'MEDIA send accepted after END';
 exception when insufficient_privilege then null; end;
end $$;
select 'PASS image-only chat send contract, authorization parity and delivery' as result;
rollback;
