-- Independent attachment-ready receipts; text mailbox ACK cannot consume them.
begin;
create table public.chat_media_delivery_receipts (
 device_id text not null references public.chat_devices(id) on delete cascade,
 attachment_id text not null references public.chat_media_attachments(id) on delete cascade,
 acked_at timestamptz not null default clock_timestamp(),
 primary key(device_id,attachment_id)
);
alter table public.chat_media_delivery_receipts enable row level security;
revoke all on public.chat_media_delivery_receipts from public,anon,authenticated,service_role;

-- Discovery is derived from the immutable attached row and canonical audience;
-- no fanout race with device enrollment and ACK rows live until media deletion.
create function public.findback_fetch_chat_media_delivery(p_account_id text,p_device_id text)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_device text; result jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is distinct from v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 select id into v_device from public.chat_devices where user_id=v_uid and device_id=p_device_id;
 if not found then raise exception 'Device unavailable' using errcode='42501'; end if;
 select coalesce(jsonb_agg(page.payload order by page.created_at,page.id),'[]'::jsonb) into result from (
  select a.id,a.created_at,jsonb_build_object('version',1,'attachmentId',a.id,'messageId',a.message_id,
   'sha256',a.sha256,'mime',a.mime,'bytes',a.byte_size,'width',a.width,'height',a.height,'expiresAt',a.expires_at) payload
  from public.chat_media_attachments a
  join public.chat_message_audience u on u.message_id=a.message_id and u.user_id=v_uid
  where public.findback_chat_media_visible_internal(v_uid,a.id)
   and not exists(select 1 from public.chat_media_delivery_receipts r where r.device_id=v_device and r.attachment_id=a.id)
  order by a.created_at,a.id limit 100
 ) page;
 return result;
end $$;
revoke all on function public.findback_fetch_chat_media_delivery(text,text) from public,anon;
grant execute on function public.findback_fetch_chat_media_delivery(text,text) to authenticated;

-- The client must durably persist before calling ACK. The SQL boundary checks
-- the currently authorized actor, installation and attachment again under the
-- same conversation lock as block, End and erasure transitions.
create function public.findback_ack_chat_media_delivery(p_account_id text,p_device_id text,p_attachment_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_device text; v_conversation text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is distinct from v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 select id into v_device from public.chat_devices where user_id=v_uid and device_id=p_device_id;
 if not found then raise exception 'Device unavailable' using errcode='42501'; end if;
 select conversation_id into v_conversation from public.chat_media_attachments where id=p_attachment_id;
 perform 1 from public.chat_conversations where id=v_conversation for update;
 if not public.findback_chat_media_visible_internal(v_uid,p_attachment_id) then
  raise exception 'Media unavailable' using errcode='42501'; end if;
 insert into public.chat_media_delivery_receipts(device_id,attachment_id) values(v_device,p_attachment_id)
  on conflict(device_id,attachment_id) do nothing;
end $$;
revoke all on function public.findback_ack_chat_media_delivery(text,text,text) from public,anon;
grant execute on function public.findback_ack_chat_media_delivery(text,text,text) to authenticated;

create function public.findback_chat_media_wake_attached() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user text;
begin
 if old.state='PENDING' and new.state='ATTACHED' then
  for v_user in select u.user_id from public.chat_message_audience u
   where u.message_id=new.message_id and public.findback_chat_media_visible_internal(u.user_id,new.id)
  loop perform public.findback_chat_wake_internal(v_user); end loop;
 end if;
 return null;
end $$;
revoke all on function public.findback_chat_media_wake_attached() from public,anon,authenticated,service_role;
create trigger chat_media_wake_attached after update of state on public.chat_media_attachments
 for each row execute function public.findback_chat_media_wake_attached();
commit;
