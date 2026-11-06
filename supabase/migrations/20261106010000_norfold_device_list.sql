-- Account-owned device visibility must not depend on local Chat enrollment.
-- Enrollment/key possession and all mutation fences remain unchanged.
begin;

create or replace function public.findback_devices(p_action text,p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; s uuid; target text:=p_args->>'deviceId'; label text:=btrim(p_args->>'name');
 r jsonb; cur text; ctx jsonb;
begin
 perform public.findback_device_lock_internal(u,p_action<>'LIST'); s:=public.findback_device_session_internal();
 if p_args is null or jsonb_typeof(p_args)<>'object' then raise exception 'Invalid device action' using errcode='22023'; end if;
 if p_action='LIST' then
  if p_args<>'{}'::jsonb then raise exception 'Invalid device action' using errcode='22023'; end if;
  -- Admit an as-yet unenrolled session; never resurrect a removed/rebound one.
  -- This preserves account deletion, ended-session and revocation fences.
  ctx:=public.findback_device_context_internal(u,s,null,true);
  cur:=ctx->>'deviceId';
  select coalesce(jsonb_agg(jsonb_build_object('deviceId',device_id,'name',coalesce(device_name,'Device'),
   'platform',platform,'lastSeenAt',floor(extract(epoch from last_seen_at)*1000),
   'current',coalesce(device_id=cur,false)) order by last_seen_at desc),'[]'::jsonb) into r
   from public.chat_devices where user_id=u and revoked_at is null and public_key is not null;
  return r;
 elsif p_action in('RENAME','REVOKE') then
  perform public.findback_device_context_internal(u,s,null);
  if target is null or not exists(select 1 from public.chat_devices where user_id=u and device_id=target and revoked_at is null)
   then raise exception 'Device unavailable' using errcode='42501'; end if;
  if p_action='RENAME' then
   if (p_args-'deviceId'-'name')<>'{}'::jsonb or jsonb_typeof(p_args->'name')<>'string'
    or label is null or length(label) not between 1 and 64 or label ~ '[[:cntrl:]]' then raise exception 'Invalid device name' using errcode='22023'; end if;
   update public.chat_devices set device_name=label where user_id=u and device_id=target;
  else
   if (p_args-'deviceId')<>'{}'::jsonb then raise exception 'Invalid device action' using errcode='22023'; end if;
   update public.chat_devices set revoked_at=clock_timestamp(),push_token=null where user_id=u and device_id=target;
   update public.chat_device_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where user_id=u and device_id=target;
   update public.chat_device_challenges set consumed_at=coalesce(consumed_at,clock_timestamp()) where user_id=u and device_id=target;
   delete from public.device_tokens where user_id=u and installation_id=target;
  end if;
  return '{}'::jsonb;
 end if;
 raise exception 'Invalid device action' using errcode='22023';
end $$;

commit;
