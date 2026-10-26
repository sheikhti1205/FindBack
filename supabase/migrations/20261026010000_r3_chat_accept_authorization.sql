-- Repair the existing chat acceptance RPC without rewriting applied history.
-- Other R3 delivery/privacy integration is intentionally a separate migration.
begin;

create or replace function public.findback_accept_conversation(p_conv_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_conversation public.chat_conversations%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Filter membership before locking: outsiders neither mutate nor lock a pair.
  -- The row lock makes state validation and the transition one serialized act;
  -- a block/end committed while we wait must be re-read, not overwritten.
  select c.* into v_conversation
    from public.chat_conversations c
   where c.id = p_conv_id and v_uid in (c.user_a, c.user_b)
   for update;

  if not found
     or v_conversation.initiated_by is null
     or v_conversation.initiated_by not in (v_conversation.user_a, v_conversation.user_b)
     or public.findback_is_blocked_pair(v_conversation.user_a, v_conversation.user_b)
     or v_conversation.initiated_by = v_uid then
    raise exception 'Conversation unavailable' using errcode = '42501';
  end if;
  if v_conversation.state <> 'REQUEST' then
    raise exception 'Conversation is not in REQUEST state' using errcode = 'P0001';
  end if;

  update public.chat_conversations
     set state = 'CONNECTED', updated_at = clock_timestamp()
   where id = v_conversation.id;
end;
$$;
revoke all on function public.findback_accept_conversation(text) from public, anon;
grant execute on function public.findback_accept_conversation(text) to authenticated;

commit;
