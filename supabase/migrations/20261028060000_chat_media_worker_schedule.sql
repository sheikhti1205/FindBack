-- Scheduler ownership for the two private media workers. Registration is
-- idempotent, automatic and secret-free: the cron command references Vault
-- secret names, never their values, and nothing is registered unless pg_cron,
-- pg_net and both Vault entries already exist. It is not an operator opt-in --
-- when the prerequisites are present the jobs are registered by this migration.
-- Running this on a plain PostgreSQL cluster returns 'unavailable' and changes
-- nothing.
begin;
create function public.findback_schedule_chat_media_workers()
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_url text; v_has_secret boolean;
begin
 if to_regclass('cron.job') is null
  or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
  or to_regclass('vault.decrypted_secrets') is null then
  return 'unavailable';
 end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where name=$1'
  into v_url using 'chat_media_worker_url';
 if coalesce(v_url,'')='' then return 'unconfigured'; end if;
 -- Only an https origin is accepted; the function paths are fixed here so a
 -- mistyped Vault entry cannot point the scheduler at another route.
 if v_url !~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' then return 'invalid-url'; end if;
 execute 'select true from vault.decrypted_secrets where name=$1'
  into v_has_secret using 'chat_media_worker_secret';
 if v_has_secret is not true then return 'unconfigured'; end if;
 -- Unscheduling by name is the only supported re-run path: a schedule change
 -- must not accumulate duplicate jobs or silently keep an old cadence.
 delete from cron.job where jobname in('findback_chat_evidence_copy','findback_chat_media_cleanup');
 perform cron.schedule('findback_chat_evidence_copy','* * * * *', format($job$
  select net.http_post(url:=%L,
   headers:=jsonb_build_object('apikey',(select decrypted_secret from vault.decrypted_secrets
    where name='chat_media_worker_secret'),'content-type','application/json'),
   body:=null::jsonb,timeout_milliseconds:=100000)
  $job$, (select decrypted_secret from vault.decrypted_secrets where name='chat_media_worker_url')
   ||'/functions/v1/copy-chat-evidence'));
 perform cron.schedule('findback_chat_media_cleanup','*/10 * * * *', format($job$
  select net.http_post(url:=%L,
   headers:=jsonb_build_object('apikey',(select decrypted_secret from vault.decrypted_secrets
    where name='chat_media_worker_secret'),'content-type','application/json'),
   body:=null::jsonb,timeout_milliseconds:=100000)
  $job$, (select decrypted_secret from vault.decrypted_secrets where name='chat_media_worker_url')
   ||'/functions/v1/cleanup-chat-media'));
 return 'scheduled';
end $$;
revoke all on function public.findback_schedule_chat_media_workers() from public,anon,authenticated,service_role;

-- Best-effort registration during migration; a hosted project without the
-- extensions or Vault entries stays unscheduled and reports it on re-run.
do $$ begin
 raise notice 'chat media worker scheduling: %',public.findback_schedule_chat_media_workers();
end $$;
commit;
