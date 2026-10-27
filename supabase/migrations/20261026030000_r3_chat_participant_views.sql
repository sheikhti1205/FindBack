-- Viewer-owned relationship projections. Never expose pair activity, private
-- counterpart choices, message bodies or mailbox counts through an inbox query.
begin;

alter table public.chat_conversations add column request_epoch text;
-- One account-owned privacy record; preference changes never bulk-accept pairs.
alter table public.chat_receipt_preferences add column open_messages boolean not null default false;
create table public.chat_participant_views (
 conversation_id text not null references public.chat_conversations(id) on delete cascade,
 user_id text not null references public.users(id) on delete cascade,
 mode text not null default 'REQUEST' check(mode in('REQUEST','CONNECTED')),
 request_direction text not null default 'NONE' check(request_direction in('NONE','INCOMING','OUTGOING')),
 request_epoch text,
 hidden boolean not null default false,
 declined boolean not null default false,
 revision bigint not null default 1 check(revision>0 and revision<=9007199254740991),
 primary key(conversation_id,user_id),
 check(mode<>'CONNECTED' or request_direction='NONE')
);
create index chat_participant_views_owner on public.chat_participant_views(user_id,conversation_id);
alter table public.chat_participant_views enable row level security;
revoke all on public.chat_participant_views from public,anon,authenticated;

-- Known legacy rows only. Shared pair membership alone is not evidence that a
-- pending request ever became visible to the recipient. No invented old epoch.
insert into public.chat_participant_views(conversation_id,user_id,mode,request_direction)
select c.id,u.id,case when c.state='CONNECTED' then 'CONNECTED' else 'REQUEST' end,
 case when c.state='REQUEST' and c.initiated_by is not null
   and exists(select 1 from public.chat_messages m where m.conversation_id=c.id)
  then case when c.initiated_by=u.id then 'OUTGOING' else 'INCOMING' end else 'NONE' end
from public.chat_conversations c join public.users u on u.id in(c.user_a,c.user_b)
where c.state in('REQUEST','CONNECTED','ENDED') and (
 c.state in('CONNECTED','ENDED') or c.initiated_by=u.id
 or exists(select 1 from public.chat_messages m where m.conversation_id=c.id and m.sender_id=u.id)
 or exists(select 1 from public.chat_mailbox b join public.chat_devices d on d.id=b.device_id
   where b.conversation_id=c.id and d.user_id=u.id));

update public.chat_conversations c set initiated_by=null,request_nudged=false
where state='REQUEST' and not exists(select 1 from public.chat_messages m where m.conversation_id=c.id);
update public.chat_conversations set state='REQUEST',initiated_by=null,request_nudged=false where state='ENDED';

-- Internal writes always run after the conversation row lock. On conflict, only
-- an actual authorized projection change increments this viewer's revision.
create function public.findback_chat_publish_view(p_id text,p_user text,p_mode text,p_direction text,p_epoch text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from public.chat_conversations where id=p_id and p_user in(user_a,user_b)) then
  raise exception 'Conversation unavailable' using errcode='42501';
 end if;
 insert into public.chat_participant_views(conversation_id,user_id,mode,request_direction,request_epoch)
 values(p_id,p_user,p_mode,p_direction,p_epoch)
 on conflict(conversation_id,user_id) do update set
  mode=excluded.mode,request_direction=excluded.request_direction,request_epoch=excluded.request_epoch,
  declined=case when chat_participant_views.request_epoch is distinct from excluded.request_epoch then false
   else chat_participant_views.declined end,
  revision=chat_participant_views.revision+1
 where (chat_participant_views.mode,chat_participant_views.request_direction,chat_participant_views.request_epoch)
  is distinct from (excluded.mode,excluded.request_direction,excluded.request_epoch);
end $$;
revoke all on function public.findback_chat_publish_view(text,text,text,text,text) from public,anon,authenticated;

create function public.findback_chat_views(p_after text default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; result jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select coalesce(jsonb_agg(page.value order by page.id),'[]'::jsonb) into result from (
  select c.id,jsonb_build_object('conversationId',c.id,
   'peerId',case when c.user_a=v_uid then c.user_b else c.user_a end,
   'mode',v.mode,'request',v.request_direction,'requestEpoch',v.request_epoch,
   'ownHidden',v.hidden,'ownDeclined',v.declined,'revision',v.revision,
   'ownBlocked',exists(select 1 from public.user_blocks b where b.blocker_user_id=v_uid
     and b.blocked_user_id=case when c.user_a=v_uid then c.user_b else c.user_a end)) as value
  from public.chat_participant_views v join public.chat_conversations c on c.id=v.conversation_id
  where v.user_id=v_uid and v_uid in(c.user_a,c.user_b) and (p_after is null or c.id>p_after)
  order by c.id limit 100
 ) page;
 return result;
end $$;
revoke all on function public.findback_chat_views(text) from public,anon,authenticated;

create function public.findback_chat_private_state(p_id text,p_action text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_id and v_uid in(user_a,user_b) for update;
 if not found or not exists(select 1 from public.chat_participant_views where conversation_id=p_id and user_id=v_uid) then
  raise exception 'Conversation unavailable' using errcode='42501';
 end if;
 if p_action not in('HIDE','UNHIDE','DECLINE') or p_action is null then
  raise exception 'Invalid chat operation' using errcode='22023';
 end if;
 update public.chat_participant_views set
  hidden=case when p_action='HIDE' then true when p_action='UNHIDE' then false else hidden end,
  declined=case when p_action='DECLINE' then true else declined end,revision=revision+1
 where conversation_id=p_id and user_id=v_uid and (
  (p_action='HIDE' and not hidden) or (p_action='UNHIDE' and hidden)
  or (p_action='DECLINE' and not declined and mode='REQUEST' and request_direction='INCOMING'));
end $$;
revoke all on function public.findback_chat_private_state(text,text) from public,anon,authenticated;

create or replace function public.findback_create_conversation(p_other_user text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_other_user is null or p_other_user=v_uid or not exists(select 1 from public.users where id=p_other_user) then
  raise exception 'Conversation unavailable' using errcode='42501';
 end if;
 insert into public.chat_conversations(user_a,user_b,initiated_by) values(v_uid,p_other_user,null)
  on conflict(least(user_a,user_b),greatest(user_a,user_b)) do nothing;
 select * into c from public.chat_conversations where
  (user_a=v_uid and user_b=p_other_user) or (user_b=v_uid and user_a=p_other_user) for update;
 -- CREATE does not reveal a new approach to the other account, even unblocked.
 if c.state not in('REQUEST','CONNECTED') then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 insert into public.chat_participant_views(conversation_id,user_id,mode)
 values(c.id,v_uid,case when c.state='CONNECTED' then 'CONNECTED' else 'REQUEST' end) on conflict do nothing;
 return c.id;
end $$;

create or replace function public.findback_send_chat_message(p_conversation_id text,p_body text,p_client_message_id text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype; m public.chat_messages%rowtype;
 v public.chat_participant_views%rowtype; v_digest text; v_epoch text; v_first boolean;
 v_blocked boolean; v_peer text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_body is null or btrim(p_body)='' or length(p_body)>100000 or p_client_message_id is null
  or p_client_message_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 then raise exception 'Invalid message' using errcode='22023'; end if;
 select * into c from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 v_digest:=encode(sha256(convert_to(p_body,'UTF8')),'hex');
 select * into m from public.chat_messages where id=p_client_message_id;
 if found then
  if m.sender_id=v_uid and m.conversation_id=c.id and m.payload_digest=v_digest then return m.id; end if;
  raise exception 'Message identity conflict' using errcode='22023';
 end if;
 if c.state not in('REQUEST','CONNECTED') then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state='REQUEST' and c.initiated_by is not null and c.initiated_by<>v_uid then
  raise exception 'Conversation unavailable' using errcode='42501';
 end if;
 v_peer:=case when c.user_a=v_uid then c.user_b else c.user_a end;
 v_blocked:=public.findback_is_blocked_pair(c.user_a,c.user_b);
 v_first:=false;
 if c.state='REQUEST' then
  select * into v from public.chat_participant_views where conversation_id=c.id and user_id=v_uid;
  v_epoch:=coalesce(case when v.request_direction='OUTGOING' then v.request_epoch end,c.request_epoch,gen_random_uuid()::text);
  v_first:=not v_blocked and not c.request_nudged;
  perform public.findback_chat_publish_view(c.id,v_uid,'REQUEST','OUTGOING',v_epoch);
  if not v_blocked then
   if exists(select 1 from public.chat_receipt_preferences where user_id=v_peer and open_messages) then
    -- Opt-in authorizes this actual contact only, never a bulk ACCEPT on toggle.
    update public.chat_conversations set state='CONNECTED',initiated_by=v_uid,request_epoch=v_epoch,
     request_nudged=true,updated_at=clock_timestamp() where id=c.id;
    perform public.findback_chat_publish_view(c.id,v_uid,'CONNECTED','NONE',null);
    perform public.findback_chat_publish_view(c.id,v_peer,'CONNECTED','NONE',null);
   else
    update public.chat_conversations set initiated_by=v_uid,request_epoch=v_epoch,request_nudged=true where id=c.id;
    perform public.findback_chat_publish_view(c.id,v_peer,'REQUEST','INCOMING',v_epoch);
   end if;
  end if;
 end if;
 insert into public.chat_messages(id,conversation_id,sender_id,body,payload_digest,first_approach)
 values(p_client_message_id,c.id,v_uid,p_body,v_digest,v_first);
 -- No shared activity is exposed by VIEWS. A withheld send changes only the
 -- author's private view/echo and never occupies the counterpart's request slot.
 perform public.findback_enqueue_chat_mailbox(p_client_message_id);
 return p_client_message_id;
end $$;

create or replace function public.findback_accept_conversation(p_conv_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_conv_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state<>'REQUEST' or c.initiated_by is null or c.initiated_by=v_uid
  or c.initiated_by not in(c.user_a,c.user_b) or not exists(select 1 from public.chat_participant_views
   where conversation_id=c.id and user_id=v_uid and request_direction='INCOMING') then
  raise exception 'Conversation unavailable' using errcode='42501';
 end if;
 -- Withhold contact without turning a hidden block into an ACCEPT error oracle.
 if public.findback_is_blocked_pair(c.user_a,c.user_b) then return; end if;
 update public.chat_conversations set state='CONNECTED',updated_at=clock_timestamp() where id=c.id;
 perform public.findback_chat_publish_view(c.id,c.user_a,'CONNECTED','NONE',null);
 perform public.findback_chat_publish_view(c.id,c.user_b,'CONNECTED','NONE',null);
 update public.chat_participant_views set hidden=false,declined=false,revision=revision+1
 where conversation_id=c.id and user_id=v_uid and (hidden or declined);
end $$;

create or replace function public.findback_end_conversation(p_conv_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; c public.chat_conversations%rowtype;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select * into c from public.chat_conversations where id=p_conv_id and v_uid in(user_a,user_b) for update;
 if not found then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if c.state<>'CONNECTED' then raise exception 'Conversation is not CONNECTED' using errcode='P0001'; end if;
 update public.chat_conversations set state='REQUEST',initiated_by=null,request_epoch=null,request_nudged=false,
  ended_at=clock_timestamp(),ended_by=v_uid,updated_at=clock_timestamp() where id=c.id;
 perform public.findback_chat_publish_view(c.id,c.user_a,'REQUEST','NONE',null);
 perform public.findback_chat_publish_view(c.id,c.user_b,'REQUEST','NONE',null);
end $$;

-- The before-trigger from request_delivery serializes block/unblock against the
-- same pair lock. Only the blocker's own visible revision changes afterward.
create function public.findback_chat_own_block_view() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor text; v_peer text; c public.chat_conversations%rowtype;
begin
 if TG_OP='DELETE' then v_actor:=OLD.blocker_user_id; v_peer:=OLD.blocked_user_id;
 else v_actor:=NEW.blocker_user_id; v_peer:=NEW.blocked_user_id; end if;
 for c in select * from public.chat_conversations where
  (user_a=v_actor and user_b=v_peer) or (user_b=v_actor and user_a=v_peer) loop
  update public.chat_participant_views set revision=revision+1 where conversation_id=c.id and user_id=v_actor;
 end loop;
 return null;
end $$;
revoke all on function public.findback_chat_own_block_view() from public,anon,authenticated;
create trigger chat_own_block_view after insert or delete on public.user_blocks
 for each row execute function public.findback_chat_own_block_view();

create or replace function public.findback_chat_exchange(p_account_id text,p_device_id text,p_action text,p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_result jsonb; v_other text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if p_account_id is null or p_account_id<>v_uid then raise exception 'Session changed' using errcode='42501'; end if;
 case p_action
 when 'REGISTER' then return to_jsonb(public.findback_register_chat_device(p_device_id,p_args->>'platform'));
 when 'VIEWS' then return public.findback_chat_views(p_args->>'afterId');
 when 'PRIVATE' then perform public.findback_chat_private_state(p_args->>'conversationId',p_args->>'operation');
 when 'CREATE' then return to_jsonb(public.findback_create_conversation(p_args->>'otherId'));
 when 'ACCEPT' then perform public.findback_accept_conversation(p_args->>'conversationId');
 when 'END' then perform public.findback_end_conversation(p_args->>'conversationId');
 when 'BLOCK' then perform public.findback_block_conversation(p_args->>'conversationId');
 when 'RECEIPTS' then perform public.findback_set_chat_receipts((p_args->>'enabled')::boolean);
 when 'PREFERENCES' then
  select jsonb_build_object(
   'readReceipts',coalesce((select enabled from public.chat_receipt_preferences where user_id=v_uid),false),
   'openMessages',coalesce((select open_messages from public.chat_receipt_preferences where user_id=v_uid),false)) into v_result;
  return v_result;
 when 'CONTACT_MODE' then
  if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then
   raise exception 'Preference required' using errcode='22023';
  end if;
  insert into public.chat_receipt_preferences(user_id,open_messages) values(v_uid,(p_args->>'enabled')::boolean)
   on conflict(user_id) do update set open_messages=excluded.open_messages;
 when 'READ' then perform public.findback_mark_chat_read(p_args->>'messageId');
 when 'SEND' then
  if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
   raise exception 'Device unavailable' using errcode='42501';
  end if;
  select case when user_a=v_uid then user_b else user_a end into v_other from public.chat_conversations
   where id=p_args->>'conversationId' and v_uid in(user_a,user_b) for update;
  if not found or (p_args->>'recipientId') is distinct from v_other then
   raise exception 'Conversation unavailable' using errcode='42501';
  end if;
  return to_jsonb(public.findback_send_chat_message(p_args->>'conversationId',p_args->>'body',p_args->>'messageId'));
 when 'SYNC' then
  select coalesce(jsonb_agg(e),'[]'::jsonb) into v_result from public.findback_fetch_chat_mailbox(p_device_id) e;
  return v_result;
 when 'ACK' then perform public.findback_ack_chat_message(p_args->>'mailboxId',p_device_id);
 else raise exception 'Invalid chat operation' using errcode='22023';
 end case;
 return 'null'::jsonb;
end $$;
-- CREATE OR REPLACE retains the prior restrictive grants. Reassert the public
-- surface explicitly; internal publisher/queries/private mutation stay revoked.
revoke all on function public.findback_chat_exchange(text,text,text,jsonb) from public,anon;
grant execute on function public.findback_chat_exchange(text,text,text,jsonb) to authenticated;
commit;
