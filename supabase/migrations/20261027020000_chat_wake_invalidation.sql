-- Content-free realtime hints only. Ordinary scoped sync remains authoritative.
begin;
create function public.findback_chat_wake_internal(p_user text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
 if p_user is not null then
  perform realtime.send(jsonb_build_object('invalidate',true),'chat:invalidate','notification:'||p_user,true);
 end if;
end $$;
revoke all on function public.findback_chat_wake_internal(text) from public,anon,authenticated;

-- Inserted after actual message audience determination, not before SEND.
-- A withheld blocked recipient has no audience row and gets no message wake.
create function public.findback_chat_wake_message_audience() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform public.findback_chat_wake_internal(new.user_id);
 return null;
end $$;
revoke all on function public.findback_chat_wake_message_audience() from public,anon,authenticated;
create trigger chat_wake_message_audience after insert on public.chat_message_audience
 for each row execute function public.findback_chat_wake_message_audience();

-- Erasure audiences are already server-derived: personal changes wake only
-- the owner; unsend wakes the original audience. ACKs do not produce hints.
create function public.findback_chat_wake_state_audience() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform public.findback_chat_wake_internal(new.user_id);
 return null;
end $$;
revoke all on function public.findback_chat_wake_state_audience() from public,anon,authenticated;
create trigger chat_wake_state_audience after insert on public.chat_state_audience
 for each row execute function public.findback_chat_wake_state_audience();

-- Projection changes remain viewer-owned, including hide and decline.
create function public.findback_chat_wake_view() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_op='INSERT' or new is distinct from old then
  perform public.findback_chat_wake_internal(new.user_id);
 end if;
 return null;
end $$;
revoke all on function public.findback_chat_wake_view() from public,anon,authenticated;
create trigger chat_wake_view after insert or update on public.chat_participant_views
 for each row execute function public.findback_chat_wake_view();

-- Only an actual progress transition wakes the other participant. Re-observing
-- an unchanged boundary must not cause a refresh/observation echo loop.
create function public.findback_chat_wake_read_progress() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_peer text;
begin
 if tg_op='UPDATE' and new.context is not distinct from old.context
   and new.through_sequence is not distinct from old.through_sequence then return null; end if;
 select case when c.user_a=new.reader_id then c.user_b else c.user_a end into v_peer
  from public.chat_conversations c where c.id=new.conversation_id and new.reader_id in(c.user_a,c.user_b);
 perform public.findback_chat_wake_internal(v_peer);
 return null;
end $$;
revoke all on function public.findback_chat_wake_read_progress() from public,anon,authenticated;
create trigger chat_wake_read_progress after insert or update on public.chat_read_progress
 for each row execute function public.findback_chat_wake_read_progress();

-- Consent changes invalidate own devices and currently connected unblocked
-- peers without sending an individual preference value or a conversation ID.
create function public.findback_chat_wake_receipt_preference() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_peer text;
begin
 if tg_op='UPDATE' and new.enabled is not distinct from old.enabled then return null; end if;
 if tg_op='INSERT' and not new.enabled then return null; end if;
 perform public.findback_chat_wake_internal(new.user_id);
 for v_peer in select distinct case when c.user_a=new.user_id then c.user_b else c.user_a end
  from public.chat_conversations c where new.user_id in(c.user_a,c.user_b) and c.state='CONNECTED'
   and not public.findback_is_blocked_pair(c.user_a,c.user_b) loop
  perform public.findback_chat_wake_internal(v_peer);
 end loop;
 return null;
end $$;
revoke all on function public.findback_chat_wake_receipt_preference() from public,anon,authenticated;
create trigger chat_wake_receipt_preference after insert or update of enabled on public.chat_receipt_preferences
 for each row execute function public.findback_chat_wake_receipt_preference();

-- The pre-existing pair fence serializes block changes with relationship
-- changes. Both sides receive the same opaque hint, never the negative action.
create function public.findback_chat_wake_block_boundary() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare a text; b text;
begin
 if tg_op='DELETE' then a:=old.blocker_user_id; b:=old.blocked_user_id;
 else a:=new.blocker_user_id; b:=new.blocked_user_id; end if;
 if exists(select 1 from public.chat_conversations c where
   (c.user_a=a and c.user_b=b) or (c.user_a=b and c.user_b=a)) then
  perform public.findback_chat_wake_internal(a);
  perform public.findback_chat_wake_internal(b);
 end if;
 return null;
end $$;
revoke all on function public.findback_chat_wake_block_boundary() from public,anon,authenticated;
create trigger chat_wake_block_boundary after insert or delete on public.user_blocks
 for each row execute function public.findback_chat_wake_block_boundary();
commit;
