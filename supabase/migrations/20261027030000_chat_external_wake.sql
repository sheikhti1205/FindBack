-- Private, bounded, per-device external wake queue. No message content.
begin;
create table public.chat_external_wakes (
 id text primary key default gen_random_uuid()::text,
 message_id text not null references public.chat_messages(id) on delete cascade,
 conversation_id text not null references public.chat_conversations(id) on delete cascade,
 recipient_id text not null references public.users(id) on delete cascade,
 kind text not null check(kind in ('CHAT_REQUEST','CHAT_CONNECTED')),
 request_epoch text,
 connection_epoch text,
 disposition text not null default 'PENDING' check(disposition in ('PENDING','NO_DEVICES')),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '24 hours',
 unique(message_id,recipient_id)
);
create table public.chat_external_wake_devices (
 wake_id text not null references public.chat_external_wakes(id) on delete cascade,
 device_id text not null references public.device_tokens(id) on delete cascade,
 state text not null default 'PENDING' check(state in ('PENDING','CLAIMED','SENT','SUPPRESSED','INVALID','EXHAUSTED')),
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default clock_timestamp(),
 claim_token text,
 lease_until timestamptz,
 primary key(wake_id,device_id)
);
create index chat_external_wake_due on public.chat_external_wake_devices(next_attempt_at) where state in ('PENDING','CLAIMED');
alter table public.chat_external_wakes enable row level security;
alter table public.chat_external_wake_devices enable row level security;
revoke all on public.chat_external_wakes,public.chat_external_wake_devices from public,anon,authenticated;

-- Audience insertion occurs after the canonical sender decides block/delivery.
-- Initial OPEN contact is already CONNECTED here and gets a silent data wake;
-- request follow-ups never create an external event.
create function public.findback_enqueue_chat_external_wake() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare m public.chat_messages%rowtype; c public.chat_conversations%rowtype; v_id text; v_kind text; n integer;
begin
 select * into m from public.chat_messages where id=new.message_id;
 if not found or new.user_id=m.sender_id then return null; end if;
 select * into c from public.chat_conversations where id=m.conversation_id;
 if not found or new.user_id not in(c.user_a,c.user_b) or public.findback_is_blocked_pair(c.user_a,c.user_b) then return null; end if;
 if c.state='REQUEST' and m.first_approach then v_kind:='CHAT_REQUEST';
 elsif c.state='CONNECTED' then v_kind:='CHAT_CONNECTED';
 else return null; end if;
 insert into public.chat_external_wakes(message_id,conversation_id,recipient_id,kind,request_epoch,connection_epoch)
 values(m.id,c.id,new.user_id,v_kind,c.request_epoch,c.receipt_connection_epoch)
 on conflict(message_id,recipient_id) do nothing returning id into v_id;
 if v_id is null then return null; end if;
 insert into public.chat_external_wake_devices(wake_id,device_id)
 select v_id,d.id from public.device_tokens d where d.user_id=new.user_id;
 get diagnostics n=row_count;
 if n=0 then update public.chat_external_wakes set disposition='NO_DEVICES' where id=v_id; end if;
 return null;
end $$;
revoke all on function public.findback_enqueue_chat_external_wake() from public,anon,authenticated;
create trigger chat_external_wake_audience after insert on public.chat_message_audience
 for each row execute function public.findback_enqueue_chat_external_wake();

-- Each device has an independent lease. Expired leases can be retried; FCM
-- cannot guarantee exactly-once after a network timeout or worker death.
create function public.findback_claim_chat_external_wakes(p_limit integer default 100)
returns table(wake_id text,device_id text,claim_token text)
language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
 delete from public.chat_external_wakes where expires_at<clock_timestamp();
 update public.chat_external_wake_devices set state='EXHAUSTED',claim_token=null,lease_until=null
  where state='CLAIMED' and attempts>=5 and lease_until<clock_timestamp();
 return query with due as (
  select d.wake_id,d.device_id from public.chat_external_wake_devices d
  join public.chat_external_wakes w on w.id=d.wake_id
  where w.expires_at>clock_timestamp() and d.attempts<5 and
   ((d.state='PENDING' and d.next_attempt_at<=clock_timestamp()) or (d.state='CLAIMED' and d.lease_until<clock_timestamp()))
  order by w.created_at,d.device_id limit least(greatest(coalesce(p_limit,100),1),100) for update of d skip locked
 ), claimed as (
  update public.chat_external_wake_devices d set state='CLAIMED',claim_token=gen_random_uuid()::text,
   lease_until=clock_timestamp()+interval '2 minutes',attempts=d.attempts+1
  from due where d.wake_id=due.wake_id and d.device_id=due.device_id
  returning d.wake_id,d.device_id,d.claim_token
 ) select claimed.wake_id,claimed.device_id,claimed.claim_token from claimed;
end $$;

-- Return only current eligible routing/token data to the service caller. A
-- false result is terminal suppression; SQL errors are NOT permission.
create function public.findback_chat_external_wake_delivery(p_wake_id text,p_device_id text,p_claim_token text)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare w public.chat_external_wakes%rowtype; d public.chat_external_wake_devices%rowtype;
 c public.chat_conversations%rowtype; m public.chat_messages%rowtype; v_token text;
begin
 select * into d from public.chat_external_wake_devices where wake_id=p_wake_id and device_id=p_device_id;
 if not found or d.state<>'CLAIMED' or d.claim_token is distinct from p_claim_token or d.lease_until<=clock_timestamp() then return null; end if;
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
    or not m.first_approach or not exists(select 1 from public.chat_participant_views v
      where v.conversation_id=c.id and v.user_id=w.recipient_id and v.request_direction='INCOMING' and not v.hidden and not v.declined)))
  or (w.kind='CHAT_CONNECTED' and (c.state<>'CONNECTED' or c.receipt_connection_epoch is distinct from w.connection_epoch)) then return null; end if;
 select token into v_token from public.device_tokens where id=p_device_id and user_id=w.recipient_id;
 if v_token is null then return null; end if;
 return jsonb_build_object('wakeId',w.id,'recipientId',w.recipient_id,'conversationId',w.conversation_id,'kind',w.kind,'token',v_token);
end $$;

create function public.findback_finish_chat_external_wake(p_wake_id text,p_device_id text,p_claim_token text,p_result text)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare n integer;
begin
 if p_result is null or p_result not in ('SENT','SUPPRESSED','INVALID','RETRY') then raise exception 'Invalid disposition' using errcode='22023'; end if;
 update public.chat_external_wake_devices d set
  state=case when p_result='RETRY' and d.attempts>=5 then 'EXHAUSTED' when p_result='RETRY' then 'PENDING' else p_result end,
  next_attempt_at=case when p_result='RETRY' then clock_timestamp()+make_interval(secs=>least(3600,30*(2^greatest(d.attempts-1,0))::integer)) else d.next_attempt_at end,
  claim_token=null,lease_until=null
 where d.wake_id=p_wake_id and d.device_id=p_device_id and d.state='CLAIMED'
  and d.claim_token=p_claim_token and d.lease_until>clock_timestamp();
 get diagnostics n=row_count; return n=1;
end $$;
revoke all on function public.findback_claim_chat_external_wakes(integer),public.findback_chat_external_wake_delivery(text,text,text),public.findback_finish_chat_external_wake(text,text,text,text) from public,anon,authenticated;
grant execute on function public.findback_claim_chat_external_wakes(integer),public.findback_chat_external_wake_delivery(text,text,text),public.findback_finish_chat_external_wake(text,text,text,text) to service_role;
commit;
