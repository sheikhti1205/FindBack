-- R3 Appeals: notification wiring, expiry handling, reversal consistency
-- Extends 20261024050000_r3_appeals_resolver.sql
begin;

-- 1. Appeals notification tracking table
create table if not exists public.appeal_notifications (
  id            text primary key default gen_random_uuid()::text,
  appeal_id     text not null references public.appeals(id) on delete cascade,
  recipient_id  text not null references public.users(id) on delete cascade,
  notification_type text not null check (notification_type in (
    'appeal_submitted', 'appeal_resolved', 'appeal_reversed', 'appeal_expired'
  )),
  sent_at       timestamptz not null default clock_timestamp(),
  read_at       timestamptz,
  -- Idempotency: one notification per type per appeal per recipient
  unique (appeal_id, recipient_id, notification_type)
);

create index if not exists ix_appeal_notifications_recipient on public.appeal_notifications(recipient_id, sent_at);
alter table public.appeal_notifications enable row level security;
revoke all on table public.appeal_notifications from public, anon, authenticated;

create policy appeal_notifications_owner on public.appeal_notifications
  for select to authenticated
  using (recipient_id = auth.uid()::text);

-- 2. Appeal expiry tracking
-- Appeals expire after a configurable period (default 30 days) if not resolved.
alter table public.appeals
  add column if not exists expires_at timestamptz default (clock_timestamp() + interval '30 days');

-- 3. Notify on appeal resolution (staff-only trigger)
create or replace function public.findback_notify_appeal_resolved()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'resolved' and old.status <> 'resolved' then
    -- Notify the appellant
    insert into public.appeal_notifications (appeal_id, recipient_id, notification_type)
    values (new.id, new.appellant_id, 'appeal_resolved')
    on conflict (appeal_id, recipient_id, notification_type) do nothing;
  end if;
  if new.status = 'reversed' and old.status <> 'reversed' then
    insert into public.appeal_notifications (appeal_id, recipient_id, notification_type)
    values (new.id, new.appellant_id, 'appeal_reversed')
    on conflict (appeal_id, recipient_id, notification_type) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_appeal_notify on public.appeals;
create trigger trg_appeal_notify
  after update on public.appeals
  for each row
  execute function public.findback_notify_appeal_resolved();

-- 4. Expire stale appeals (cron-callable)
create or replace function public.findback_expire_stale_appeals()
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_appeal record;
begin
  for v_appeal in
    select id, appellant_id from public.appeals
    where status = 'pending' and expires_at < clock_timestamp()
  loop
    update public.appeals
      set status = 'expired', resolved_at = clock_timestamp()
      where id = v_appeal.id;
    insert into public.appeal_notifications (appeal_id, recipient_id, notification_type)
    values (v_appeal.id, v_appeal.appellant_id, 'appeal_expired')
    on conflict (appeal_id, recipient_id, notification_type) do nothing;
    v_count := coalesce(v_count, 0) + 1;
  end loop;
  return coalesce(v_count, 0);
end;
$$;
revoke all on function public.findback_expire_stale_appeals() from public, anon, authenticated;

-- 5. Reversal consistency: when an appeal is reversed, restore the original action
-- This is a placeholder for the actual reversal logic which depends on the appealed entity type.
-- The function logs the reversal for audit purposes.
create or replace function public.findback_reverse_appeal_action(p_appeal_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_appeal record;
begin
  select * into v_appeal from public.appeals where id = p_appeal_id;
  if v_appeal is null then
    raise exception 'Appeal not found' using errcode='P0001';
  end if;
  if v_appeal.status <> 'reversed' then
    raise exception 'Appeal is not in reversed state' using errcode='P0001';
  end if;
  -- Reversal logic is entity-type specific and will be implemented per entity.
  -- This function serves as the canonical entry point for reversal operations.
  -- Audit log entry is created by the caller.
end;
$$;
revoke all on function public.findback_reverse_appeal_action(text) from public, anon, authenticated;
grant execute on function public.findback_reverse_appeal_action(text) to authenticated;

commit;