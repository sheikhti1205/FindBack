-- A receiver's MEDIA parent becomes deliverable only with authorized bytes.
-- Keep pending mailbox rows for retention/retry; the sender's echo is unchanged.
begin;

create or replace function public.findback_fetch_chat_mailbox(p_device_id text)
returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 return query select jsonb_build_object('accountId',v_uid,'deviceId',p_device_id,'mailboxId',b.id,
  'event',jsonb_build_object('kind','TEXT','eventId',m.id,'sequence',m.event_sequence,'message',
   jsonb_build_object('id',m.id,'conversationId',c.id,'authorId',m.sender_id,
    'recipientId',case when c.user_a=m.sender_id then c.user_b else c.user_a end,
    'body',m.body,'messageType',m.message_type)
    || case when m.context_report_id is null then '{}'::jsonb
       else jsonb_build_object('contextReportId',m.context_report_id) end
    || case when m.message_type='LOCATION' then jsonb_build_object('location',
        jsonb_build_object('lat',m.location_lat,'lng',m.location_lng,'accuracy',m.location_accuracy_m))
       else '{}'::jsonb end))
 from public.chat_mailbox b join public.chat_devices d on d.id=b.device_id
 join public.chat_messages m on m.id=b.message_id join public.chat_conversations c on c.id=b.conversation_id
 where d.user_id=v_uid and d.device_id=p_device_id and b.acked_at is null and b.expires_at>clock_timestamp()
  and m.unsent_at is null and (m.body<>'' or m.message_type in ('MEDIA','LOCATION'))
  and (m.sender_id=v_uid or not public.findback_is_blocked_pair(c.user_a,c.user_b))
  and (m.sender_id=v_uid or m.message_type<>'MEDIA' or exists(
   select 1 from public.chat_media_attachments a where a.message_id=m.id
    and public.findback_chat_media_visible_internal(v_uid,a.id)))
 order by m.event_sequence limit 100;
end $$;

-- One owner for external-wake admission, shared by initial audience and actual
-- attachment commit. A content-free early hint must not consume the only wake.
create function public.findback_chat_enqueue_external_wake_internal(p_message_id text,p_recipient text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare m public.chat_messages%rowtype; c public.chat_conversations%rowtype; v_id text; v_kind text; n integer;
begin
 select * into m from public.chat_messages where id=p_message_id;
 if not found or p_recipient=m.sender_id or m.unsent_at is not null then return; end if;
 select * into c from public.chat_conversations where id=m.conversation_id;
 if not found or p_recipient not in(c.user_a,c.user_b)
  or not exists(select 1 from public.chat_message_audience where message_id=m.id and user_id=p_recipient)
  or public.findback_is_blocked_pair(c.user_a,c.user_b) then return; end if;
 if m.message_type='MEDIA' and not exists(select 1 from public.chat_media_attachments a
  where a.message_id=m.id and public.findback_chat_media_visible_internal(p_recipient,a.id)) then return; end if;
 if c.state='REQUEST' and m.first_approach then v_kind:='CHAT_REQUEST';
 elsif c.state='CONNECTED' then v_kind:='CHAT_CONNECTED';
 else return; end if;
 insert into public.chat_external_wakes(message_id,conversation_id,recipient_id,kind,request_epoch,connection_epoch)
 values(m.id,c.id,p_recipient,v_kind,c.request_epoch,c.receipt_connection_epoch)
 on conflict(message_id,recipient_id) do nothing returning id into v_id;
 if v_id is null then return; end if;
 insert into public.chat_external_wake_devices(wake_id,device_id)
 select v_id,d.id from public.device_tokens d where d.user_id=p_recipient;
 get diagnostics n=row_count;
 if n=0 then update public.chat_external_wakes set disposition='NO_DEVICES' where id=v_id; end if;
end $$;
revoke all on function public.findback_chat_enqueue_external_wake_internal(text,text) from public,anon,authenticated,service_role;

create or replace function public.findback_enqueue_chat_external_wake() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
 perform public.findback_chat_enqueue_external_wake_internal(new.message_id,new.user_id);
 return null;
end $$;

create or replace function public.findback_chat_media_wake_attached() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_user text;
begin
 if old.state='PENDING' and new.state='ATTACHED' then
  -- Includes installations enrolled while the upload was in progress. Existing
  -- mailbox identities/ACKs are not replaced and duplicate commits do not fire.
  perform public.findback_enqueue_chat_mailbox(new.message_id);
  for v_user in select u.user_id from public.chat_message_audience u
   where u.message_id=new.message_id and public.findback_chat_media_visible_internal(u.user_id,new.id)
  loop
   perform public.findback_chat_enqueue_external_wake_internal(new.message_id,v_user);
   perform public.findback_chat_wake_internal(v_user);
  end loop;
 end if;
 return null;
end $$;

-- These existing functions remain internal, not new client RPCs.
revoke all on function public.findback_fetch_chat_mailbox(text),
 public.findback_enqueue_chat_external_wake(),public.findback_chat_media_wake_attached()
 from public,anon,authenticated,service_role;
commit;
