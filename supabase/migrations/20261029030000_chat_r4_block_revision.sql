-- ---------------------------------------------------------------------------
-- R4-B1: a block boundary changes the relationship epoch for BOTH members, so
-- BOTH member revisions must move with it.
--
-- `findback_chat_views` publishes `epoch = findback_chat_relationship_epoch(c)`
-- in every member projection. The block trigger regenerates
-- `receipt_block_epoch`, so the peer's projection contents change. Only
-- `findback_chat_own_block_view` bumped a revision, and only for the actor, so
-- the peer could receive a new epoch under an unchanged revision. The client
-- cache treats "same revision, different contents" as a conflict
-- (`Conversation revision conflict`) and would then refuse that projection on
-- every later sync — a permanent, unrecoverable cache divergence for the
-- blocked member.
--
-- The fix belongs where the epoch actually changes: bump both members in the
-- same statement that rotates the boundary, inside the same transaction, so a
-- reader can never observe a new epoch against a stale revision.
-- ---------------------------------------------------------------------------
create or replace function public.findback_receipt_block_transition() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare a text; b text;
begin
 if tg_op='DELETE' then a:=old.blocker_user_id; b:=old.blocked_user_id;
 else a:=new.blocker_user_id; b:=new.blocked_user_id; end if;
 with rotated as (
  update public.chat_conversations set receipt_block_epoch=gen_random_uuid()::text
   where (user_a=a and user_b=b) or (user_a=b and user_b=a)
  returning id
 )
 update public.chat_member_state s set revision=s.revision+1
  where s.conversation_id in (select id from rotated) and s.user_id in (a,b);
 return null;
end $$;
revoke all on function public.findback_receipt_block_transition() from public,anon,authenticated;
