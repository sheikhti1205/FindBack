-- Mailbox classification is authoritative and independent of caption/body.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9870-000000000001','type870_a','type870_a@example.invalid','+8801987000001',1,now(),now()),
 ('00000000-0000-4000-9870-000000000002','type870_b','type870_b@example.invalid','+8801987000002',1,now(),now());
insert into public.chat_conversations(id,user_a,user_b,state,initiated_by,receipt_connection_epoch) values
 ('type870-connected','00000000-0000-4000-9870-000000000001','00000000-0000-4000-9870-000000000002','CONNECTED','00000000-0000-4000-9870-000000000001','type870-epoch');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9870-000000000001',true);
select public.findback_register_chat_device('00000000-0000-4000-9870-000000000010','web');
select public.findback_send_chat_message('type870-connected','same caption','00000000-0000-4000-9870-000000000101','TEXT');
select public.findback_send_chat_message('type870-connected','same caption','00000000-0000-4000-9870-000000000102','MEDIA');
select public.findback_send_chat_message('type870-connected','','00000000-0000-4000-9870-000000000103','MEDIA');
do $$
declare v_rows jsonb;
begin
 select jsonb_object_agg(e#>>'{event,message,id}',e#>>'{event,message,messageType}') into v_rows
 from public.findback_fetch_chat_mailbox('00000000-0000-4000-9870-000000000010') e
 where e#>>'{event,message,id}' in ('00000000-0000-4000-9870-000000000101',
  '00000000-0000-4000-9870-000000000102','00000000-0000-4000-9870-000000000103');
 if v_rows->>'00000000-0000-4000-9870-000000000101' is distinct from 'TEXT'
  or v_rows->>'00000000-0000-4000-9870-000000000102' is distinct from 'MEDIA'
  or v_rows->>'00000000-0000-4000-9870-000000000103' is distinct from 'MEDIA' then
  raise exception 'mailbox lost authoritative message classification: %',v_rows;
 end if;
end $$;
select 'PASS mailbox carries authoritative TEXT/MEDIA classification' as result;
rollback;
