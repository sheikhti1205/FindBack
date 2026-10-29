-- M1 fix forward: genuine lifecycle transitions, not one lifetime STATUS row.
-- Preserve the canonical visibility/block/comment guards and all other dedupe.
-- No new notification type, recipient projection, grant or public writer.
begin;
create or replace function public.findback_insert_notification(
  p_user_id text,p_actor_id text,p_type text,p_post_id text,p_comment_id text,
  p_preview text,p_reaction_kind text default null
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_now text:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_user_id is null or p_user_id=p_actor_id then return; end if;
  if p_actor_id is null and p_type not in ('STATUS','MODERATION') then return; end if;
  if p_post_id is not null and not public.findback_can_read_post_for(p_post_id,p_user_id) then return; end if;
  if p_comment_id is not null and (not public.findback_can_read_comment_for(p_comment_id,p_user_id)
     or not exists(select 1 from public.comments c where c.id=p_comment_id and c.post_id=p_post_id)) then return; end if;
  if p_actor_id is not null and public.findback_is_blocked_pair(p_user_id,p_actor_id) then return; end if;
  -- STATUS is emitted only by the row trigger when status actually changes.
  -- RPC retries that leave status unchanged emit nothing. A later recovery or
  -- re-close must not be swallowed by a prior MATCHED/CLOSED notification.
  if p_comment_id is null and p_type<>'STATUS' and exists(
    select 1 from public.notifications n where n.user_id=p_user_id
      and n.actor_id is not distinct from p_actor_id and n.type=p_type
      and n.post_id is not distinct from p_post_id and n.comment_id is null and n.deleted_at is null
      and (p_type<>'REACTION' or n.reaction_kind is not distinct from p_reaction_kind)
  ) then return; end if;
  insert into public.notifications(id,user_id,actor_id,type,post_id,comment_id,preview,read,created_at,deleted_at,reaction_kind)
  values(gen_random_uuid()::text,p_user_id,p_actor_id,p_type,p_post_id,p_comment_id,
    left(nullif(p_preview,''),200),0,v_now,null,p_reaction_kind);
end $$;

create or replace function public.findback_notify_status()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status is distinct from old.status
     and new.status in ('MATCHED','RECOVERED','CLOSED') and new.user_id is not null then
    perform public.findback_insert_notification(new.user_id,null,'STATUS',new.id,null,
      case new.status
        when 'MATCHED' then 'Both owners confirmed a match. Record the handover after the item is returned.'
        when 'RECOVERED' then 'Recovery recorded. The item has been returned.'
        when 'CLOSED' then 'Your report is closed.'
      end);
  end if;
  return new;
end $$;
revoke all on function public.findback_insert_notification(text,text,text,text,text,text,text),
  public.findback_notify_status() from public,anon,authenticated;
commit;
