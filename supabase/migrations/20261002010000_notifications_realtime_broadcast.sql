-- FindBack — private inbox Realtime signal.
--
-- When a notification row is inserted the badge/inbox should update without
-- waiting for the next focus poll. Broadcast a SIGNAL ONLY on the recipient's
-- private topic `notification:<user_id>`: the payload deliberately carries no
-- report data (no preview, no actor, no post) because the receive policy on
-- `realtime.messages` is authenticated-wide (see 20260914210000). The client
-- refetches its own inbox through the auth-scoped RPC, so a snooper on the
-- topic learns nothing beyond "a row was inserted".
--
-- Same conventions as 20260914210000_realtime_broadcast.sql: SECURITY DEFINER,
-- revoked from public/anon/authenticated, private channel (true).

create or replace function public.findback_broadcast_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform realtime.send(
    jsonb_build_object('op', 'insert'),
    'notification:added',
    'notification:' || new.user_id,
    true
  );
  return new;
end;
$$;

revoke all on function public.findback_broadcast_notification() from public, anon, authenticated;

drop trigger if exists trg_findback_broadcast_notification on public.notifications;
create trigger trg_findback_broadcast_notification
  after insert on public.notifications
  for each row execute function public.findback_broadcast_notification();
