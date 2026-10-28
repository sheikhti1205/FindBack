-- Scheduler registration must be inert without pg_cron/pg_net/Vault, idempotent,
-- secret-free and unreachable for anon/authenticated/service_role.
begin;
do $$ begin
 if public.findback_schedule_chat_media_workers()<>'unavailable' then
  raise exception 'Scheduler reported success without its extensions'; end if;
 if public.findback_schedule_chat_media_workers()<>'unavailable' then
  raise exception 'Scheduler re-run was not idempotent'; end if;
 -- This disposable cluster has no pg_cron, so registration must have been a
 -- no-op rather than a partially applied schedule.
 if to_regclass('cron.job') is not null then
  raise exception 'Scheduler created a cron schema without the extension'; end if;
 -- The registered request must carry no body: both workers reject any non-null
 -- body with 400, so a '{}' body would make every scheduled run fail forever.
 if (select prosrc from pg_proc where proname='findback_schedule_chat_media_workers'
  and pronamespace='public'::regnamespace) not like '%body:=null::jsonb%' then
  raise exception 'Scheduler does not send a null request body'; end if;
 if (select prosrc from pg_proc where proname='findback_schedule_chat_media_workers'
  and pronamespace='public'::regnamespace) like '%body:=''{}''%' then
  raise exception 'Scheduler still sends an empty-object request body'; end if;
end $$;
set local role authenticated;
do $$ begin
 begin
  perform public.findback_schedule_chat_media_workers();
  raise exception 'Authenticated caller could register scheduled work';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
 begin
  perform public.findback_schedule_chat_media_workers();
  raise exception 'Anonymous caller could register scheduled work';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ begin
 begin
  perform public.findback_schedule_chat_media_workers();
  raise exception 'Service role could register scheduled work';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS chat media scheduler is inert, idempotent and internal-only' as result;
rollback;
