-- Bounded participant history over the canonical relationship owner. No new
-- public report/profile reader, no consumer table grants, no retained-id output.
begin;
create function public.findback_my_matches(
  p_post_id text default null,
  p_before_at timestamptz default null,
  p_before_id text default null,
  p_limit integer default 20
)
returns table(
  match_id text,
  state text,
  cancel_reason text,
  proposed_at timestamptz,
  my_report_id text,
  my_report_type text,
  my_title text,
  peer_report_id text,
  peer_report_type text,
  peer_title text,
  peer_available boolean,
  proposed_by_me boolean,
  my_confirmed boolean,
  my_handover boolean,
  return_id text
)
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
  if v_uid is null or not exists(select 1 from public.users u where u.id=v_uid)
     or exists(select 1 from public.account_deletion_fences f where f.user_id=v_uid) then
    raise exception 'Not authenticated' using errcode='28000';
  end if;
  if (p_before_at is null)<>(p_before_id is null) then
    raise exception 'Invalid match cursor' using errcode='22023';
  end if;
  return query
  with mine as (
    select m.*,
      case when m.lost_owner_user_id=v_uid then m.lost_report_id else m.found_report_id end as my_id,
      case when m.lost_owner_user_id=v_uid then m.lost_report_id_original else m.found_report_id_original end as my_original,
      case when m.lost_owner_user_id=v_uid then m.found_report_id else m.lost_report_id end as peer_id,
      case when m.lost_owner_user_id=v_uid then m.found_owner_user_id else m.lost_owner_user_id end as peer_owner
    from public.report_matches m
    where v_uid in (m.lost_owner_user_id,m.found_owner_user_id)
      and (p_before_at is null or (m.proposed_at,m.id)<(p_before_at,p_before_id))
  ), page as (
    select m.* from mine m where p_post_id is null or m.my_original=p_post_id
      order by m.proposed_at desc,m.id desc limit least(greatest(coalesce(p_limit,20),1),50)
  )
  select m.id,
    case when r.id is not null then 'RECOVERED' else m.status end,
    m.cancel_reason,m.proposed_at,
    own.id,own.type,own.title,
    case when allowed.visible then peer.id else null end,
    case when allowed.visible then peer.type else null end,
    case when allowed.visible then peer.title else null end,
    allowed.visible,
    coalesce(m.proposed_by=v_uid,false),
    exists(select 1 from public.match_confirmations c where c.match_id=m.id and c.owner_id=v_uid),
    exists(select 1 from public.match_handovers h where h.match_id=m.id and h.owner_id=v_uid),
    r.id
  from page m
  left join public.item_posts own on own.id=m.my_id and own.user_id=v_uid
  left join public.item_posts peer on peer.id=m.peer_id
  cross join lateral (
    select coalesce(peer.id is not null and m.peer_owner is not null
      and exists(select 1 from public.users u where u.id=m.peer_owner)
      and public.findback_can_read_post_for(peer.id,v_uid)
      and not public.findback_is_blocked_pair(v_uid,m.peer_owner)
      and not exists(select 1 from public.account_deletion_fences f where f.user_id=m.peer_owner),false) as visible
  ) allowed
  left join lateral (
    select sr.id from public.successful_returns sr
    where m.status='CONFIRMED'
      and sr.lost_post_id_original=m.lost_report_id_original
      and sr.found_post_id_original=m.found_report_id_original
    order by sr.id limit 1
  ) r on true
  order by m.proposed_at desc,m.id desc;
end $$;
revoke all on function public.findback_my_matches(text,timestamptz,text,integer) from public,anon;
grant execute on function public.findback_my_matches(text,timestamptz,text,integer) to authenticated;
comment on function public.findback_my_matches(text,timestamptz,text,integer) is
  'Participant-only bounded match history with timestamp/id cursor and own-report filter. Hidden, blocked, deleting and missing peers render unavailable without peer ids/content or retained identifiers. Own terminal history survives report/account removal.';
commit;
