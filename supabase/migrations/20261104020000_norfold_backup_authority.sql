-- LOCAL milestone WIP: account-scoped Drive backup key authority.
-- The key is issued by the canonical server and gated by the same installation
-- admission as Chat: a revoked or rebound installation can no longer obtain it.
-- It is never placed in Drive beside the ciphertext; Drive holds only sealed
-- objects whose AAD includes the generation this RPC returns.
-- Applied migrations remain immutable; this file is not yet applied or published.
begin;

create table public.chat_backup_keys(
 user_id text primary key references public.users(id) on delete cascade,
 generation uuid not null default gen_random_uuid(),
 key_hex text not null check(key_hex ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 rotated_at timestamptz
);
alter table public.chat_backup_keys enable row level security;
revoke all on public.chat_backup_keys from public,anon,authenticated,service_role;

-- READ is idempotent: an account has exactly one active key per generation, so
-- two devices enrolling at once still agree. ROTATE replaces both generation and
-- key; because the generation is part of every object's AAD, older ciphertext
-- becomes unreadable by design and the client rebuilds under the new key.
create function public.findback_backup_key(p_action text,p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; s uuid; r public.chat_backup_keys%rowtype;
begin
 if p_args is null or jsonb_typeof(p_args)<>'object' or p_args<>'{}'::jsonb then
  raise exception 'Invalid backup action' using errcode='22023'; end if;
 -- Exclusive account lock: key creation/rotation is a write, and it orders
 -- against enrollment/rebind/revoke exactly like the device lane.
 perform public.findback_device_lock_internal(u,true);
 s:=public.findback_device_session_internal();
 perform public.findback_device_context_internal(u,s,null);
 if p_action='READ' then
  insert into public.chat_backup_keys(user_id,generation,key_hex)
  values(u,gen_random_uuid(),encode(extensions.gen_random_bytes(32),'hex'))
  on conflict(user_id) do update set user_id=excluded.user_id
  returning * into r;
 elsif p_action='ROTATE' then
  insert into public.chat_backup_keys(user_id,generation,key_hex)
  values(u,gen_random_uuid(),encode(extensions.gen_random_bytes(32),'hex'))
  on conflict(user_id) do update set generation=excluded.generation,key_hex=excluded.key_hex,
   created_at=clock_timestamp(),rotated_at=clock_timestamp()
  returning * into r;
 else
  raise exception 'Invalid backup action' using errcode='22023';
 end if;
 if r.user_id is null then raise exception 'Backup key unavailable' using errcode='42501'; end if;
 -- The projection is exactly what the client needs to seal/open objects.
 return jsonb_build_object('accountId',r.user_id,'generation',r.generation,'key',r.key_hex,
  'createdAt',floor(extract(epoch from r.created_at)*1000));
end $$;

revoke all on function public.findback_backup_key(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.findback_backup_key(text,jsonb) to authenticated;
commit;
