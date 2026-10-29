-- A committed deletion fence makes both participants ineligible for new
-- admission/acceptance while external storage/auth deletion work is pending.
-- Keep cancellation available. Applied admission logic remains a private delegate.
begin;
create or replace function public.findback_propose_match(p_lost_id text,p_found_id text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_lost text:=nullif(btrim(coalesce(p_lost_id,'')),'');
        v_found text:=nullif(btrim(coalesce(p_found_id,'')),'');
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if v_lost is null or v_found is null or v_lost=v_found then
    raise exception 'Invalid match pair' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  perform 1 from public.item_posts where id in (v_lost,v_found) order by id for update;
  -- Readable moderation history is not eligibility for a new relationship.
  if exists(select 1 from public.item_posts where id in (v_lost,v_found)
            and moderation_visibility<>'PUBLISHED') then
    raise exception 'Match unavailable' using errcode='P0002';
  end if;
  if exists(select 1 from public.item_posts p join public.account_deletion_fences f on f.user_id=p.user_id
              where p.id in (v_lost,v_found)) then
    raise exception 'Match unavailable' using errcode='P0002';
  end if;
  return public.findback_propose_match_admission(v_lost,v_found);
end $$;

alter function public.findback_confirm_match(text) rename to findback_confirm_match_admission;
revoke all on function public.findback_confirm_match_admission(text) from public,anon,authenticated,service_role;
create function public.findback_confirm_match(p_match_id text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_lost text; v_found text;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  select lost_report_id,found_report_id into v_lost,v_found from public.report_matches where id=p_match_id;
  if v_lost is null or v_found is null then raise exception 'Match unavailable' using errcode='P0002'; end if;
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  perform 1 from public.item_posts where id in (v_lost,v_found) order by id for update;
  if exists(select 1 from public.item_posts where id in (v_lost,v_found)
            and moderation_visibility<>'PUBLISHED') then
    raise exception 'Match unavailable' using errcode='P0002';
  end if;
  if exists(select 1 from public.item_posts p join public.account_deletion_fences f on f.user_id=p.user_id
             where p.id in (v_lost,v_found)) then
    raise exception 'Match unavailable' using errcode='P0002';
  end if;
  return public.findback_confirm_match_admission(p_match_id);
end $$;
revoke all on function public.findback_propose_match(text,text),public.findback_confirm_match(text) from public,anon;
grant execute on function public.findback_propose_match(text,text),public.findback_confirm_match(text) to authenticated;
comment on function public.findback_confirm_match(text) is
  'Current-owner admission with locked deletion-fence eligibility. Delegates unchanged canonical consent/occupancy/rollback checks; no additional consumer grant to the private delegate.';
commit;
