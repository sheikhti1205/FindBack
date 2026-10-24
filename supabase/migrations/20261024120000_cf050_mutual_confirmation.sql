-- CF-050 refinement: mutual confirmation tracking and recovery handover
-- Extends 20261024060000_cf050_matching.sql
-- Both owners must confirm before MATCHED. RECOVERED only after mutual handover.
begin;

-- 1. Match confirmations tracking (per-owner)
create table if not exists public.match_confirmations (
  id            text primary key default gen_random_uuid()::text,
  match_id      text not null references public.report_matches(id) on delete cascade,
  owner_id      text not null references public.users(id) on delete cascade,
  confirmed_at  timestamptz not null default clock_timestamp(),
  -- Idempotency: one confirmation per owner per match
  unique (match_id, owner_id)
);

create index if not exists ix_match_confirmations_match on public.match_confirmations(match_id);
alter table public.match_confirmations enable row level security;
revoke all on table public.match_confirmations from public, anon, authenticated;

create policy match_confirmations_owner on public.match_confirmations
  for all to authenticated
  using (owner_id = auth.uid()::text)
  with check (owner_id = auth.uid()::text);

-- 2. Redefine confirm_match to require mutual confirmation
-- The previous signature returns void; PostgreSQL cannot replace its return type.
-- RESTRICT is intentional: unexpected dependencies abort this whole transaction.
drop function public.findback_confirm_match(text);
create or replace function public.findback_confirm_match(p_match_id text)
returns text  -- returns 'PARTIAL' or 'MATCHED'
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
  v_status text;
  v_confirmation_count integer;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select m.status, lp.user_id, fp.user_id, lp.status, fp.status
    into v_status, v_lost_owner, v_found_owner, v_lost_status, v_found_status
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

  -- Record this owner's confirmation (idempotent)
  insert into public.match_confirmations (match_id, owner_id)
  values (p_match_id, v_uid)
  on conflict (match_id, owner_id) do nothing;

  -- Check if both owners have confirmed
  select count(*) into v_confirmation_count
    from public.match_confirmations
    where match_id = p_match_id;

  if v_confirmation_count >= 2 then
    -- Both confirmed: set to MATCHED
    update public.report_matches
      set status = 'CONFIRMED', confirmed_at = clock_timestamp()
      where id = p_match_id;
    update public.item_posts set status = 'MATCHED'
      where id in (select lost_report_id from public.report_matches where id = p_match_id
                   union
                   select found_report_id from public.report_matches where id = p_match_id);
    return 'MATCHED';
  else
    return 'PARTIAL';
  end if;
end;
$$;
revoke all on function public.findback_confirm_match(text) from public, anon;
grant execute on function public.findback_confirm_match(text) to authenticated;

-- 3. handover_match RPC (mutual handover -> RECOVERED)
-- Both owners must call this after MATCHED. Only then do reports become RECOVERED.
create table if not exists public.match_handovers (
  id            text primary key default gen_random_uuid()::text,
  match_id      text not null references public.report_matches(id) on delete cascade,
  owner_id      text not null references public.users(id) on delete cascade,
  handed_over_at timestamptz not null default clock_timestamp(),
  unique (match_id, owner_id)
);

create index if not exists ix_match_handovers_match on public.match_handovers(match_id);
alter table public.match_handovers enable row level security;
revoke all on table public.match_handovers from public, anon, authenticated;

create policy match_handovers_owner on public.match_handovers
  for all to authenticated
  using (owner_id = auth.uid()::text)
  with check (owner_id = auth.uid()::text);

create or replace function public.findback_handover_match(p_match_id text)
returns text  -- returns 'PARTIAL' or 'RECOVERED'
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
  v_handover_count integer;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;

  select m.status, lp.user_id, fp.user_id
    into v_status, v_lost_owner, v_found_owner
    from public.report_matches m
    join public.item_posts lp on lp.id = m.lost_report_id
    join public.item_posts fp on fp.id = m.found_report_id
    where m.id = p_match_id;

  if v_status is null then raise exception 'Match not found' using errcode='P0001'; end if;
  if v_status <> 'CONFIRMED' then raise exception 'Match must be CONFIRMED before handover' using errcode='P0001'; end if;
  if v_uid <> v_lost_owner and v_uid <> v_found_owner then
    raise exception 'Only report owners can hand over matches' using errcode='42501';
  end if;

  -- Record this owner's handover (idempotent)
  insert into public.match_handovers (match_id, owner_id)
  values (p_match_id, v_uid)
  on conflict (match_id, owner_id) do nothing;

  -- Check if both owners have handed over
  select count(*) into v_handover_count
    from public.match_handovers
    where match_id = p_match_id;

  if v_handover_count >= 2 then
    -- Both handed over: set to RECOVERED (via status update on reports)
    update public.item_posts set status = 'RECOVERED'
      where id in (select lost_report_id from public.report_matches where id = p_match_id
                   union
                   select found_report_id from public.report_matches where id = p_match_id);
    return 'RECOVERED';
  else
    return 'PARTIAL';
  end if;
end;
$$;
revoke all on function public.findback_handover_match(text) from public, anon;
grant execute on function public.findback_handover_match(text) to authenticated;

commit;
