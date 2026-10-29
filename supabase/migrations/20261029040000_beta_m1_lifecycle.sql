-- M1 fix-forward. Applied admission/occupancy bytes remain unchanged.
-- RED: verify_beta_m1_lifecycle.sql reproduces eleven named violations on
-- 20261029030000. This is not the complete M1 deletion/client acceptance.
begin;

create or replace function public.findback_change_post_status_client(p_post_id text, p_status text)
returns boolean language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_status is null or p_status not in ('OPEN','MATCHED','RECOVERED','CLOSED') then
    raise exception 'Invalid status' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  -- Take the same report lock that proposal/confirmation/recovery acquire,
  -- BEFORE inspecting relationships. A check followed by an unlocked UPDATE
  -- could overwrite a confirmation that committed during that gap.
  perform 1 from public.item_posts where id=p_post_id and user_id=v_uid for update;
  if not found then raise exception 'Post not found or you do not own it' using errcode='42501'; end if;
  if exists(select 1 from public.successful_returns r
             where r.lost_post_id=p_post_id or r.found_post_id=p_post_id) then
    raise exception 'This report is already recorded as recovered, so its status cannot be changed here' using errcode='P0001';
  end if;
  if p_status='RECOVERED' then
    raise exception 'Use Mark recovered on the report to record a recovery' using errcode='P0001';
  end if;
  if p_status='MATCHED' then
    raise exception 'Use a confirmed match to mark this report as matched' using errcode='P0001';
  end if;
  if public.findback_post_is_match_linked(p_post_id) then
    raise exception 'This report is part of a match, so its status cannot be changed here' using errcode='P0001';
  end if;
  update public.item_posts set status=p_status,updated_at=v_now where id=p_post_id and user_id=v_uid;
  return true;
end $$;

create or replace function public.findback_cancel_match(p_match_id text)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  v_uid text := auth.uid()::text;
  v_lost text; v_found text;
  v_match record;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  -- Authenticate participation before looking at status or acquiring locks.
  -- Missing, foreign and unavailable relationships answer identically.
  select m.lost_report_id,m.found_report_id into v_lost,v_found
    from public.report_matches m
    join public.item_posts lp on lp.id=m.lost_report_id
    join public.item_posts fp on fp.id=m.found_report_id
   where m.id=p_match_id and v_uid in (lp.user_id,fp.user_id);
  if not found then raise exception 'Match unavailable' using errcode='P0002'; end if;
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  perform 1 from public.item_posts where id in (v_lost,v_found) order by id for update;
  perform 1 from public.report_matches where id=p_match_id for update;
  select m.status,lp.user_id as lost_owner,fp.user_id as found_owner,
         lp.status as lost_status,fp.status as found_status,
         m.lost_report_id,m.found_report_id into v_match
    from public.report_matches m
    join public.item_posts lp on lp.id=m.lost_report_id
    join public.item_posts fp on fp.id=m.found_report_id
   where m.id=p_match_id and v_uid in (lp.user_id,fp.user_id);
  if not found then raise exception 'Match unavailable' using errcode='P0002'; end if;
  if v_match.lost_report_id<>v_lost or v_match.found_report_id<>v_found then
    raise exception 'Match changed; try again' using errcode='40001';
  end if;
  if v_match.status='CANCELLED' then return; end if;
  if v_match.status='CONFIRMED' then
    if exists(select 1 from public.successful_returns r
               where r.lost_post_id in (v_lost,v_found) or r.found_post_id in (v_lost,v_found)) then
      raise exception 'A completed recovery cannot be undone here' using errcode='P0001';
    end if;
    -- Never turn an operator's CLOSED/RECOVERED drift back into OPEN.
    if v_match.lost_status<>'MATCHED' or v_match.found_status<>'MATCHED' then
      raise exception 'MATCH_STATUS_CONFLICT' using errcode='P0001';
    end if;
    update public.item_posts set status='OPEN',updated_at=v_now where id in (v_lost,v_found);
  elsif v_match.status<>'PENDING' then
    raise exception 'MATCH_STATUS_CONFLICT' using errcode='P0001';
  end if;
  update public.report_matches set status='CANCELLED',cancelled_at=clock_timestamp(),
    cancelled_by=v_uid,cancel_reason='USER_CANCELLED' where id=p_match_id;
  -- Canonical internal audit, not a publicly readable participant-identity log.
  -- The durable confirmation/handover rows remain; retries append nothing.
  perform public.findback_write_audit('MATCH_CANCELLED','REPORT_MATCH',p_match_id,
    case when v_match.status='CONFIRMED' then 'Wrong match before recovery' else 'Proposal cancelled' end,
    jsonb_build_object('status',v_match.status),jsonb_build_object('status','CANCELLED'));
end $$;

create or replace function public.findback_handover_match(p_match_id text)
returns text language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare
  v_uid text := auth.uid()::text;
  v_lost text; v_found text;
  v_match record;
  v_count integer;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  select m.lost_report_id,m.found_report_id into v_lost,v_found
    from public.report_matches m
    join public.item_posts lp on lp.id=m.lost_report_id
    join public.item_posts fp on fp.id=m.found_report_id
   where m.id=p_match_id and v_uid in (lp.user_id,fp.user_id);
  if not found then raise exception 'Match unavailable' using errcode='P0002'; end if;
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  perform 1 from public.item_posts where id in (v_lost,v_found) order by id for update;
  perform 1 from public.report_matches where id=p_match_id for update;
  select m.status,m.lost_report_id,m.found_report_id,
         lp.user_id as lost_owner,fp.user_id as found_owner,
         lp.type as lost_type,fp.type as found_type,
         lp.status as lost_status,fp.status as found_status,
         lp.moderation_visibility as lost_visibility,fp.moderation_visibility as found_visibility
    into v_match from public.report_matches m
    join public.item_posts lp on lp.id=m.lost_report_id
    join public.item_posts fp on fp.id=m.found_report_id
   where m.id=p_match_id and v_uid in (lp.user_id,fp.user_id);
  if not found then raise exception 'Match unavailable' using errcode='P0002'; end if;
  if v_match.lost_report_id<>v_lost or v_match.found_report_id<>v_found then
    raise exception 'Match changed; try again' using errcode='40001';
  end if;
  if v_match.status<>'CONFIRMED' or v_match.lost_type<>'LOST' or v_match.found_type<>'FOUND'
     or v_match.lost_owner=v_match.found_owner
      or v_match.lost_visibility<>'PUBLISHED'
      or v_match.found_visibility<>'PUBLISHED'
     or exists(select 1 from public.user_blocks b
               where (b.blocker_user_id=v_match.lost_owner and b.blocked_user_id=v_match.found_owner)
                  or (b.blocker_user_id=v_match.found_owner and b.blocked_user_id=v_match.lost_owner))
     or coalesce(public.findback_active_sanction_kind(v_match.lost_owner),'') in ('SUSPENDED','BANNED')
     or coalesce(public.findback_active_sanction_kind(v_match.found_owner),'') in ('SUSPENDED','BANNED')
     or exists(select 1 from public.account_deletion_fences f where f.user_id in (v_match.lost_owner,v_match.found_owner)) then
    raise exception 'Match unavailable' using errcode='P0002';
  end if;
  select count(distinct c.owner_id) into v_count from public.match_confirmations c
   where c.match_id=p_match_id and c.owner_id in (v_match.lost_owner,v_match.found_owner);
  if v_count<>2 then raise exception 'Match unavailable' using errcode='P0002'; end if;
  if exists(select 1 from public.successful_returns r where r.lost_post_id=v_lost and r.found_post_id=v_found) then
    if v_match.lost_status='RECOVERED' and v_match.found_status='RECOVERED' then return 'RECOVERED'; end if;
    raise exception 'MATCH_STATUS_CONFLICT' using errcode='P0001';
  end if;
  if v_match.lost_status<>'MATCHED' or v_match.found_status<>'MATCHED'
     or (select count(*) from public.report_match_occupancy where match_id=p_match_id and report_id in (v_lost,v_found))<>2 then
    raise exception 'MATCH_STATUS_CONFLICT' using errcode='P0001';
  end if;
  insert into public.match_handovers(match_id,match_id_original,owner_id,owner_id_original)
    values(p_match_id,p_match_id,v_uid,v_uid) on conflict(match_id,owner_id) do nothing;
  -- Old/foreign/deleted participants never substitute for either CURRENT owner.
  select count(distinct h.owner_id) into v_count from public.match_handovers h
   where h.match_id=p_match_id and h.owner_id in (v_match.lost_owner,v_match.found_owner);
  if v_count<2 then return 'PARTIAL'; end if;
  begin
    insert into public.successful_returns(id,lost_post_id,found_post_id,lost_owner_user_id,helper_user_id,
                                          external_helper,recovered_at,confirmed_by,created_at)
    values(gen_random_uuid()::text,v_lost,v_found,v_match.lost_owner,v_match.found_owner,false,v_now,v_uid,v_now);
  exception when unique_violation then
    raise exception 'This lost report already has a recorded recovery' using errcode='23505';
  end;
  update public.item_posts set status='RECOVERED',updated_at=v_now where id in (v_lost,v_found);
  return 'RECOVERED';
end $$;

revoke all on function public.findback_cancel_match(text),public.findback_handover_match(text),
  public.findback_change_post_status_client(text,text) from public,anon;
grant execute on function public.findback_cancel_match(text),public.findback_handover_match(text),
  public.findback_change_post_status_client(text,text) to authenticated;
comment on function public.findback_cancel_match(text) is
  'Participant cancellation. Pending cancels; confirmed wrong-match correction reopens only a valid MATCHED pair before recovery, atomically audits and retains history. Cancelled retry is a no-op. Foreign/missing refusal parity.';
comment on function public.findback_handover_match(text) is
  'Current eligible participant handover with privacy-safe refusal and exactly two current-owner acknowledgements. Records one durable recovery; committed retry is idempotent.';
comment on function public.findback_change_post_status_client(text,text) is
  'Locked owner close/reopen only. MATCHED and RECOVERED belong to relationship writers; confirmed and recovered report lifecycle is protected.';
commit;
