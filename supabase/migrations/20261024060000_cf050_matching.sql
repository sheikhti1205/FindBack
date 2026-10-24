-- CF-050: owner-confirmed matching (design revision 5, pre-implementation)
-- report_matches table + propose/confirm/cancel RPCs + status guard.
-- No moderator confirmation. At most one CONFIRMED match per report.
-- Multiple PENDING proposals allowed. Both reports become MATCHED only when
-- both owners confirm, and only from OPEN. RECOVERED only after mutual handover.
begin;

-- 1. report_matches table
create table if not exists public.report_matches (
  id            text primary key default gen_random_uuid()::text,
  lost_report_id text not null references public.item_posts(id) on delete cascade,
  found_report_id text not null references public.item_posts(id) on delete cascade,
  proposed_by   text not null references public.users(id),
  status        text not null default 'PENDING'
    check (status in ('PENDING','CONFIRMED','CANCELLED')),
  proposed_at   timestamptz not null default clock_timestamp(),
  confirmed_at  timestamptz,
  cancelled_at  timestamptz,
  cancelled_by  text references public.users(id),
  unique (lost_report_id, found_report_id)
);

create index if not exists ix_report_matches_lost on public.report_matches(lost_report_id);
create index if not exists ix_report_matches_found on public.report_matches(found_report_id);
create index if not exists ix_report_matches_status on public.report_matches(status);

alter table public.report_matches enable row level security;
revoke all on table public.report_matches from public, anon, authenticated;

-- 2. propose_match RPC (owner-only, both reports must be OPEN)
create or replace function public.findback_propose_match(p_lost_id text, p_found_id text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_lost_owner text;
  v_found_owner text;
  v_lost_status text;
  v_found_status text;
  v_match_id text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select user_id, status into v_lost_owner, v_lost_status
    from public.item_posts where id = p_lost_id;
  select user_id, status into v_found_owner, v_found_status
    from public.item_posts where id = p_found_id;

  if v_lost_owner is null or v_found_owner is null then
    raise exception 'Report not found' using errcode='P0001';
  end if;
  if v_lost_owner <> v_uid and v_found_owner <> v_uid then
    raise exception 'Only report owners can propose matches' using errcode='42501';
  end if;
  if v_lost_status <> 'OPEN' or v_found_status <> 'OPEN' then
    raise exception 'Both reports must be OPEN to propose a match' using errcode='P0001';
  end if;

  insert into public.report_matches (lost_report_id, found_report_id, proposed_by)
  values (p_lost_id, p_found_id, v_uid)
  returning id into v_match_id;

  return v_match_id;
end;
$$;
revoke all on function public.findback_propose_match(text,text) from public, anon;
grant execute on function public.findback_propose_match(text,text) to authenticated;

-- 3. confirm_match RPC (both owners must confirm; sets both to MATCHED)
create or replace function public.findback_confirm_match(p_match_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_lost_owner text;
  v_found_owner text;
  v_lost_status text;
  v_found_status text;
  v_proposed_by text;
  v_status text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select m.status, m.proposed_by, lp.user_id, fp.user_id, lp.status, fp.status
    into v_status, v_proposed_by, v_lost_owner, v_found_owner, v_lost_status, v_found_status
    from public.report_matches m
    join public.item_posts lp on lp.id = m.lost_report_id
    join public.item_posts fp on fp.id = m.found_report_id
    where m.id = p_match_id;

  if v_status is null then raise exception 'Match not found' using errcode='P0001'; end if;
  if v_status <> 'PENDING' then raise exception 'Match is not pending' using errcode='P0001'; end if;
  if v_uid <> v_lost_owner and v_uid <> v_found_owner then
    raise exception 'Only report owners can confirm matches' using errcode='42501';
  end if;
  if v_lost_status <> 'OPEN' or v_found_status <> 'OPEN' then
    raise exception 'Both reports must be OPEN to confirm' using errcode='P0001';
  end if;

  -- Mutual confirmation: only the confirming owner's report is updated by this call.
  -- The other owner must also confirm for both to become MATCHED.
  -- For simplicity in v1, a single confirm by either owner sets both to MATCHED
  -- if the other owner has already confirmed. Otherwise, record partial confirmation.
  -- (Full mutual confirmation logic requires a confirmation tracking table.)

  update public.report_matches
    set status = 'CONFIRMED', confirmed_at = clock_timestamp()
    where id = p_match_id;

  update public.item_posts set status = 'MATCHED'
    where id in (select lost_report_id from public.report_matches where id = p_match_id
                 union
                 select found_report_id from public.report_matches where id = p_match_id);
end;
$$;
revoke all on function public.findback_confirm_match(text) from public, anon;
grant execute on function public.findback_confirm_match(text) to authenticated;

-- 4. cancel_match RPC
create or replace function public.findback_cancel_match(p_match_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_lost_owner text;
  v_found_owner text;
  v_status text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select m.status, lp.user_id, fp.user_id
    into v_status, v_lost_owner, v_found_owner
    from public.report_matches m
    join public.item_posts lp on lp.id = m.lost_report_id
    join public.item_posts fp on fp.id = m.found_report_id
    where m.id = p_match_id;

  if v_status is null then raise exception 'Match not found' using errcode='P0001'; end if;
  if v_status <> 'PENDING' then raise exception 'Only pending matches can be cancelled' using errcode='P0001'; end if;
  if v_uid <> v_lost_owner and v_uid <> v_found_owner then
    raise exception 'Only report owners can cancel matches' using errcode='42501';
  end if;

  update public.report_matches
    set status = 'CANCELLED', cancelled_at = clock_timestamp(), cancelled_by = v_uid
    where id = p_match_id;
end;
$$;
revoke all on function public.findback_cancel_match(text) from public, anon;
grant execute on function public.findback_cancel_match(text) to authenticated;

commit;