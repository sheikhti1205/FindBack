-- Real canonical RPC/SQL paths on disposable PG; synthetic actors/metadata only.
-- No actual Storage bytes, OAuth or live two-account acceptance is claimed.
begin;
create function pg_temp.photo_exchange(p_action text,p_args jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select public.findback_chat_exchange(auth.uid()::text,current_setting('photo.device'),p_action,p_args)
$$;
create function pg_temp.photo_mailbox(p_ids text[]) returns void language plpgsql as $$
declare ids text[];
begin
 select coalesce(array_agg(e#>>'{event,message,id}' order by e#>>'{event,message,id}'),'{}'::text[])
 into ids from jsonb_array_elements(pg_temp.photo_exchange('SYNC')) e;
 if ids is distinct from p_ids then raise exception 'photo publication mailbox: expected %, got %',p_ids,ids; end if;
end $$;
grant execute on function pg_temp.photo_exchange(text,jsonb),pg_temp.photo_mailbox(text[]) to authenticated;

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9933-000000000001','photo_pub_a','photo_pub_a@example.invalid','+8801993300001',1,now(),now()),
 ('00000000-0000-4000-9933-000000000002','photo_pub_b','photo_pub_b@example.invalid','+8801993300002',1,now(),now());
insert into public.chat_conversations(id,user_a,user_b,state,receipt_connection_epoch) values
 ('00000000-0000-4000-9933-000000000099','00000000-0000-4000-9933-000000000001','00000000-0000-4000-9933-000000000002','CONNECTED','photo-publication-connection');
insert into public.chat_member_state(conversation_id,user_id,mode) values
 ('00000000-0000-4000-9933-000000000099','00000000-0000-4000-9933-000000000001','CONNECTED'),
 ('00000000-0000-4000-9933-000000000099','00000000-0000-4000-9933-000000000002','CONNECTED');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9933-000000000002',true);
select set_config('photo.device','00000000-0000-4000-9933-000000000021',true);
select pg_temp.photo_exchange('REGISTER','{"platform":"web"}');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9933-000000000001',true);
select set_config('photo.device','00000000-0000-4000-9933-000000000011',true);
select pg_temp.photo_exchange('REGISTER','{"platform":"web"}');
select set_config('photo.epoch',(select e->>'epoch' from jsonb_array_elements(pg_temp.photo_exchange('VIEWS')) e where e->>'conversationId'='00000000-0000-4000-9933-000000000099'),true);
select pg_temp.photo_exchange('SEND',jsonb_build_object('conversationId','00000000-0000-4000-9933-000000000099','recipientId','00000000-0000-4000-9933-000000000002','messageId','00000000-0000-4000-9933-000000000101','body','photo caption','messageType','MEDIA','expectedEpoch',current_setting('photo.epoch')));
select pg_temp.photo_mailbox(array['00000000-0000-4000-9933-000000000101']);
-- Own ACK may precede upload; cleanup must retain the caption for the peer.
select pg_temp.photo_exchange('ACK',jsonb_build_object('mailboxId',pg_temp.photo_exchange('SYNC')#>>'{0,mailboxId}'));
reset role;
select public.findback_cleanup_chat_mailbox();
do $$ begin
 if (select body from public.chat_messages where id='00000000-0000-4000-9933-000000000101')<>'photo caption' then raise exception 'pending peer photo caption erased'; end if;
 if exists(select 1 from public.chat_external_wakes where message_id='00000000-0000-4000-9933-000000000101') then raise exception 'photo external wake consumed before commit'; end if;
 if has_function_privilege('authenticated','public.findback_chat_enqueue_external_wake_internal(text,text)','execute')
  or has_function_privilege('service_role','public.findback_chat_enqueue_external_wake_internal(text,text)','execute')
  or has_function_privilege('anon','public.findback_chat_enqueue_external_wake_internal(text,text)','execute') then raise exception 'private enqueue helper exposed'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9933-000000000002',true);
select set_config('photo.device','00000000-0000-4000-9933-000000000021',true);
select pg_temp.photo_mailbox('{}');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9933-000000000001',true);
select public.findback_reserve_chat_media(auth.uid()::text,'00000000-0000-4000-9933-000000000101','00000000-0000-4000-9933-000000000201');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9933-000000000002',true);
select pg_temp.photo_mailbox('{}');
do $$ begin
 if jsonb_array_length(public.findback_fetch_chat_media_delivery(auth.uid()::text,current_setting('photo.device')))<>0 then raise exception 'PENDING attachment exposed'; end if;
end $$;
-- Another own device enrolls during upload, before the commit fanout.
select set_config('photo.device','00000000-0000-4000-9933-000000000022',true);
select pg_temp.photo_exchange('REGISTER','{"platform":"web"}');
select pg_temp.photo_mailbox('{}');
reset role;
select set_config('photo.gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9933-000000000201'),true);
select set_config('photo.key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9933-000000000201'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9933-000000000001','00000000-0000-4000-9933-000000000201',current_setting('photo.gen'),current_setting('photo.key'),repeat('a',64),'image/jpeg',100,64,64);
select public.findback_commit_chat_media('00000000-0000-4000-9933-000000000001','00000000-0000-4000-9933-000000000201',current_setting('photo.gen'),current_setting('photo.key'),repeat('a',64),'image/jpeg',100,64,64);
reset role;
do $$ begin
 if (select count(*) from public.chat_external_wakes where message_id='00000000-0000-4000-9933-000000000101')<>1 then raise exception 'committed photo wake missing or duplicated'; end if;
end $$;
set local role authenticated;
select pg_temp.photo_mailbox(array['00000000-0000-4000-9933-000000000101']);
select set_config('photo.device','00000000-0000-4000-9933-000000000021',true);
select pg_temp.photo_mailbox(array['00000000-0000-4000-9933-000000000101']);
do $$ declare rows jsonb; begin
 rows:=pg_temp.photo_exchange('SYNC');
 if rows#>>'{0,event,message,messageType}'<>'MEDIA' or rows#>>'{0,event,message,body}'<>'photo caption' then raise exception 'committed parent lost type/caption'; end if;
 rows:=public.findback_fetch_chat_media_delivery(auth.uid()::text,current_setting('photo.device'));
 if jsonb_array_length(rows)<>1 or rows#>>'{0,attachmentId}'<>'00000000-0000-4000-9933-000000000201' then raise exception 'committed attachment missing'; end if;
end $$;
-- Even legacy queued parents are filtered when the actual attachment expires.
reset role;
update public.chat_media_attachments set expires_at=clock_timestamp()-interval '1 second' where id='00000000-0000-4000-9933-000000000201';
set local role authenticated;
select pg_temp.photo_mailbox('{}');
reset role;
update public.chat_media_attachments set expires_at=clock_timestamp()+interval '1 day' where id='00000000-0000-4000-9933-000000000201';
set local role authenticated;
select pg_temp.photo_exchange('DELETE_FOR_ME','{"conversationId":"00000000-0000-4000-9933-000000000099","messageId":"00000000-0000-4000-9933-000000000101"}');
select pg_temp.photo_mailbox('{}');
-- Reverse direction uses the same publication boundary, no special author path.
select pg_temp.photo_exchange('SEND',jsonb_build_object('conversationId','00000000-0000-4000-9933-000000000099','recipientId','00000000-0000-4000-9933-000000000001','messageId','00000000-0000-4000-9933-000000000102','body','','messageType','MEDIA','expectedEpoch',current_setting('photo.epoch')));
select public.findback_reserve_chat_media(auth.uid()::text,'00000000-0000-4000-9933-000000000102','00000000-0000-4000-9933-000000000202');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9933-000000000001',true);
select set_config('photo.device','00000000-0000-4000-9933-000000000011',true);
-- The author's old photo is now durable/ACKed locally; its second echo is ignored here.
do $$ declare rows jsonb; begin
 rows:=pg_temp.photo_exchange('SYNC');
 if exists(select 1 from jsonb_array_elements(rows) e where e#>>'{event,message,id}'='00000000-0000-4000-9933-000000000102') then raise exception 'reverse pending photo ghost'; end if;
end $$;
reset role;
select set_config('photo.gen',(select generation from public.chat_media_attachments where id='00000000-0000-4000-9933-000000000202'),true);
select set_config('photo.key',(select object_key from public.chat_media_attachments where id='00000000-0000-4000-9933-000000000202'),true);
set local role service_role;
select public.findback_commit_chat_media('00000000-0000-4000-9933-000000000002','00000000-0000-4000-9933-000000000202',current_setting('photo.gen'),current_setting('photo.key'),repeat('b',64),'image/png',120,32,32);
reset role;
set local role authenticated;
do $$ declare rows jsonb; begin
 rows:=pg_temp.photo_exchange('SYNC');
 if not exists(select 1 from jsonb_array_elements(rows) e where e#>>'{event,message,id}'='00000000-0000-4000-9933-000000000102') then raise exception 'reverse committed photo missing'; end if;
end $$;
reset role;
select 'PASS photo publication/commit/retry/expiry/erase/both directions/private helper' as result;
rollback;
