-- M7-P bounded capability: viewer-private, synced notification mute.
-- Message delivery, receipt authority and relationship epochs are unchanged.
begin;
alter table public.chat_member_state add column muted boolean not null default false;

create function public.findback_chat_set_muted(
 p_account_id text,p_device_id text,p_conversation_id text,p_muted boolean
) returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
 if v_uid is null or p_account_id is distinct from v_uid
  or exists(select 1 from public.account_deletion_fences where user_id=v_uid) then
  raise exception 'Session unavailable' using errcode='42501'; end if;
 if p_muted is null then raise exception 'Preference required' using errcode='22023'; end if;
 if not exists(select 1 from public.chat_devices where user_id=v_uid and device_id=p_device_id) then
  raise exception 'Device unavailable' using errcode='42501'; end if;
 -- Same lock order as private visibility and relationship mutations.
 perform 1 from public.chat_conversations where id=p_conversation_id and v_uid in(user_a,user_b) for update;
 if not found or not exists(select 1 from public.chat_member_state where conversation_id=p_conversation_id and user_id=v_uid) then
  raise exception 'Conversation unavailable' using errcode='42501'; end if;
 update public.chat_member_state set muted=p_muted,revision=revision+1
  where conversation_id=p_conversation_id and user_id=v_uid and muted is distinct from p_muted;
 -- Existing member revision trigger wakes only this user's other installations.
 return p_muted;
end $$;
revoke all on function public.findback_chat_set_muted(text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.findback_chat_set_muted(text,text,text,boolean) to authenticated;

create or replace function public.findback_chat_views(p_after text default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; result jsonb;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 select coalesce(jsonb_agg(page.value order by page.id),'[]'::jsonb) into result from (
  select c.id,jsonb_build_object('conversationId',c.id,
   'peerId',case when c.user_a=v_uid then c.user_b else c.user_a end,
   'mode',v.mode,'request',v.request_direction,'requestEpoch',v.request_epoch,
   'ownHidden',v.hidden,'ownDeclined',v.declined,'ownMuted',v.muted,'revision',v.revision,
   'epoch',public.findback_chat_relationship_epoch(c),
   'ownBlocked',exists(select 1 from public.user_blocks b where b.blocker_user_id=v_uid
     and b.blocked_user_id=case when c.user_a=v_uid then c.user_b else c.user_a end)) as value
  from public.chat_member_state v join public.chat_conversations c on c.id=v.conversation_id
  where v.user_id=v_uid and v_uid in(c.user_a,c.user_b) and (p_after is null or c.id>p_after)
  order by c.id limit 100
 ) page;
 return result;
end $$;

-- Current R4 native behavior: CHAT_REQUEST can show a request nudge;
-- CHAT_CONNECTED is a silent data wake, not an ordinary notification. Preserve
-- the latter, mailbox/audience and realtime even while notifications are muted.
-- Keep the final pre-send eligibility check authoritative, including queued wakes.
create or replace function public.findback_chat_external_wake_delivery(
 p_wake_id text,p_device_id text,p_claim_token text
) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare w public.chat_external_wakes%rowtype; d public.chat_external_wake_devices%rowtype;
 c public.chat_conversations%rowtype; m public.chat_messages%rowtype; v_token text;
begin
 select * into d from public.chat_external_wake_devices where wake_id=p_wake_id and device_id=p_device_id;
 if not found or d.state<>'CLAIMED' or d.claim_token is distinct from p_claim_token
  or d.lease_until<=clock_timestamp() then return null; end if;
 select * into w from public.chat_external_wakes where id=p_wake_id and expires_at>clock_timestamp();
 if not found then return null; end if;
 select * into c from public.chat_conversations where id=w.conversation_id;
 select * into m from public.chat_messages where id=w.message_id and conversation_id=w.conversation_id;
 if c.id is null or m.id is null or m.unsent_at is not null or w.recipient_id not in(c.user_a,c.user_b)
  or m.sender_id not in(c.user_a,c.user_b) or m.sender_id=w.recipient_id
  or not exists(select 1 from public.chat_message_audience a where a.message_id=m.id and a.user_id=w.recipient_id)
  or public.findback_is_blocked_pair(c.user_a,c.user_b)
  or exists(select 1 from public.notification_preferences p where p.user_id=w.recipient_id and p.push_enabled=0)
  or (w.kind='CHAT_REQUEST' and (c.state<>'REQUEST' or c.request_epoch is distinct from w.request_epoch
    or not m.first_approach or not exists(select 1 from public.chat_member_state v
      where v.conversation_id=c.id and v.user_id=w.recipient_id and v.request_direction='INCOMING'
       and not v.hidden and not v.declined and not v.muted)))
  or (w.kind='CHAT_CONNECTED' and (c.state<>'CONNECTED'
    or c.receipt_connection_epoch is distinct from w.connection_epoch)) then return null; end if;
 select token into v_token from public.device_tokens where id=p_device_id and user_id=w.recipient_id;
 if v_token is null then return null; end if;
 return jsonb_build_object('wakeId',w.id,'recipientId',w.recipient_id,'conversationId',w.conversation_id,
  'kind',w.kind,'token',v_token);
end $$;
comment on column public.chat_member_state.muted is
 'This viewer notification preference only. Does not change peer state, message delivery, media or receipt authority.';
comment on function public.findback_chat_set_muted(text,text,text,boolean) is
 'Account/registered-installation fenced explicit own mute setter; idempotent, revision wakes only the viewer.';
commit;
