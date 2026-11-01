-- Privileged email authority is an OFFER, never a signup side effect.
-- This is a forward contract change, not the authorized population reset.
begin;

alter table public.bootstrap_admins
 add column claimed_by text references public.users(id) on delete set null,
 add column claimed_at text;

drop trigger if exists on_role_invitation_auth_user_created on auth.users;
drop trigger if exists on_role_invitation_auth_user_confirmed on auth.users;
drop trigger if exists on_role_invitation_profile_created on public.users;

-- Old internal callers must not reintroduce implicit acceptance. Keep its
-- signature because historical functions refer to it; it confers no authority.
create or replace function public.findback_attach_pending_role(p_user_id text, p_email text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin return; end;
$$;
revoke all on function public.findback_attach_pending_role(text,text) from public,anon,authenticated,service_role;

create function public.findback_my_role_offer()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
 v_uid text:=auth.uid()::text;
 v_email text;
 v_offer jsonb;
begin
 if v_uid is null then return null; end if;
 -- Auth, not editable profile/JWT metadata, proves the email's ownership.
 -- A profile row is the server's normal setup completion boundary.
 select lower(btrim(a.email)) into v_email
 from auth.users a join public.users u on u.id=a.id::text
 where a.id::text=v_uid and a.email_confirmed_at is not null
  and a.deleted_at is null and (a.banned_until is null or a.banned_until<=now())
  and not coalesce(a.is_anonymous,false) and nullif(btrim(u.username),'') is not null
  and lower(btrim(u.email))=lower(btrim(a.email))
  and not exists(select 1 from public.account_deletion_fences f where f.user_id=v_uid);
 if v_email is null then return null; end if;

 if exists(select 1 from public.bootstrap_admins b where lower(btrim(b.email))=v_email and b.claimed_at is null)
  and not exists(select 1 from public.user_roles where role='ADMIN') then
  return jsonb_build_object('token','bootstrap:'||v_uid,'role','ADMIN','capabilities',to_jsonb(public.findback_capability_vocabulary()));
 end if;
 select jsonb_build_object(
   'token',r.id::text||':'||md5(jsonb_build_array(r.role,r.capabilities,r.invited_at)::text),
   'role',r.role,'capabilities',to_jsonb(r.capabilities)) into v_offer
 from public.role_invitations r
 where lower(btrim(r.email))=v_email and r.accepted_at is null and r.revoked_at is null
 order by r.invited_at,r.id limit 1;
 return v_offer;
end;
$$;
revoke all on function public.findback_my_role_offer() from public,anon;
grant execute on function public.findback_my_role_offer() to authenticated;

create function public.findback_accept_role_offer(p_token text)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
 v_uid text:=auth.uid()::text;
 v_offer jsonb;
 v_role text;
 v_caps text[];
 v_by text;
 v_cap text;
 v_now text:=to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_inv_id uuid;
 v_previous text;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 perform pg_advisory_xact_lock(20261022143000);
 -- Keep confirmed identity and completed setup stable until acceptance commits.
 perform 1 from auth.users a join public.users u on u.id=a.id::text
  where a.id::text=v_uid for share of a,u;
 -- Read again under the SAME lock as every role/offer/deletion mutation.
 v_offer:=public.findback_my_role_offer();
 if p_token is null or v_offer is null or p_token is distinct from v_offer->>'token' then
  raise exception 'This role offer is no longer available. Refresh and try again.' using errcode='42501';
 end if;
 v_role:=v_offer->>'role';
 select coalesce(array_agg(distinct c),'{}'::text[]) into v_caps from jsonb_array_elements_text(v_offer->'capabilities') c;
 foreach v_cap in array v_caps loop
  if v_cap is null or v_cap<>all(public.findback_capability_vocabulary())
   or (v_role='MODERATOR' and v_cap=any(public.findback_admin_capabilities())) then
   raise exception 'This role offer is not valid.' using errcode='42501';
  end if;
 end loop;
 if p_token='bootstrap:'||v_uid then
  v_by:=v_uid;
  update public.bootstrap_admins b set claimed_by=v_uid,claimed_at=v_now
   where lower(btrim(b.email))=(select lower(btrim(a.email)) from auth.users a where a.id::text=v_uid)
    and b.claimed_at is null;
 else
  v_inv_id:=split_part(p_token,':',1)::uuid;
  select invited_by into v_by from public.role_invitations where id=v_inv_id for update;
  update public.role_invitations set accepted_at=v_now where id=v_inv_id;
 end if;
 select role into v_previous from public.user_roles where user_id=v_uid limit 1;
 if v_role<>'ADMIN' and exists(select 1 from public.user_roles where user_id=v_uid and role='ADMIN')
  and (select count(*) from public.user_roles where role='ADMIN')<=1 then
  raise exception 'The last admin cannot be demoted' using errcode='42501';
 end if;
 -- The existing last-admin and deletion-pending table guards remain final truth.
 delete from public.user_roles where user_id=v_uid and role<>v_role;
 delete from public.user_role_capabilities where user_id=v_uid;
 insert into public.user_roles(user_id,role,granted_by,granted_at) values(v_uid,v_role,v_by,v_now)
  on conflict(user_id,role) do nothing;
 foreach v_cap in array v_caps loop
  insert into public.user_role_capabilities(user_id,capability,granted_by,granted_at) values(v_uid,v_cap,v_by,v_now);
 end loop;
 -- Bootstrap supersedes old pending invitations for the same confirmed account.
 if p_token='bootstrap:'||v_uid then
  update public.role_invitations r set revoked_at=v_now where r.accepted_at is null and r.revoked_at is null
   and lower(btrim(r.email))=(select lower(btrim(a.email)) from auth.users a where a.id::text=v_uid);
 end if;
 perform public.findback_write_audit('ROLE_OFFER_ACCEPTED','user_roles',v_uid,
  'Role explicitly accepted after verified account setup',
  jsonb_build_object('role',v_previous,'accepted',false),jsonb_build_object('role',v_role,'accepted',true,'invitation_id',v_inv_id));
 return true;
end;
$$;
revoke all on function public.findback_accept_role_offer(text) from public,anon;
grant execute on function public.findback_accept_role_offer(text) to authenticated;

-- Existing explicit bootstrap button is still safe, but cannot bypass Auth,
-- normal setup, consumed authority or the common atomic acceptance boundary.
create or replace function public.findback_bootstrap_admin()
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin return public.findback_accept_role_offer('bootstrap:'||auth.uid()::text); end;
$$;
revoke all on function public.findback_bootstrap_admin() from public,anon;
grant execute on function public.findback_bootstrap_admin() to authenticated;

create or replace function public.findback_bootstrap_claim_status()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
 v_can boolean:=coalesce(public.findback_my_role_offer()->>'token'='bootstrap:'||auth.uid()::text,false);
 v_has boolean:=exists(select 1 from public.user_roles where role='ADMIN');
begin
 return jsonb_build_object('can_claim',v_can,'reason',case when v_can then null
  when v_has then 'An admin already exists'
  else 'No administrator offer is available for this account.' end,
  'already_admin',public.findback_has_role('ADMIN'),'has_admin',v_has);
end;
$$;
revoke all on function public.findback_bootstrap_claim_status() from public,anon;
grant execute on function public.findback_bootstrap_claim_status() to authenticated;

-- New authority/replacement is always proposed, even for an existing account.
-- Revocation and capability management of an accepted role remain separate RPCs.
create or replace function public.findback_role_grant(p_email text,p_role text,p_capabilities text[] default '{}')
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
 v_uid text:=auth.uid()::text;
 v_email text:=lower(btrim(coalesce(p_email,'')));
 v_cap text;
 v_now text:=to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 perform pg_advisory_xact_lock(20261022143000);
 if not public.findback_can('roles_manage') then raise exception 'Only an admin may assign roles' using errcode='42501'; end if;
 if v_email='' or v_email!~'^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'A valid email address is required' using errcode='22023'; end if;
 if p_role is null or p_role not in ('ADMIN','MODERATOR') then raise exception 'Unknown role' using errcode='22023'; end if;
 foreach v_cap in array coalesce(p_capabilities,'{}') loop
  if v_cap is null or v_cap<>all(public.findback_capability_vocabulary()) then raise exception 'Unknown capability' using errcode='22023'; end if;
  if p_role='MODERATOR' and v_cap=any(public.findback_admin_capabilities()) then raise exception 'Capability is admin-only and cannot be granted to a moderator' using errcode='22023'; end if;
 end loop;
 if exists(select 1 from public.role_invitations where lower(btrim(email))=v_email and accepted_at is null and revoked_at is null) then
  raise exception 'An invitation already exists for that address' using errcode='22023';
 end if;
 insert into public.role_invitations(email,role,capabilities,invited_by,invited_at)
  values(v_email,p_role,coalesce(p_capabilities,'{}'),v_uid,v_now);
 perform public.findback_write_audit('ROLE_INVITED','role_invitations',v_email,
  'Role offered pending explicit acceptance',null,jsonb_build_object('role',p_role,'accepted',false));
 return jsonb_build_object('kind','invitation','email',v_email,'role',p_role);
end;
$$;
revoke all on function public.findback_role_grant(text,text,text[]) from public,anon;
grant execute on function public.findback_role_grant(text,text,text[]) to authenticated;

comment on function public.findback_my_role_offer() is 'Caller-only confirmed-Auth/profile role offer. Read-only; no implicit assignment or email enumeration.';
comment on function public.findback_accept_role_offer(text) is 'Explicit current-offer acceptance. Shared role lock, Auth identity and setup recheck, one-time consumption, server authority and audit.';
comment on function public.findback_attach_pending_role(text,text) is 'Retired automatic attachment boundary: inert. Offers require explicit acceptance.';
comment on function public.findback_bootstrap_admin() is 'Legacy explicit bootstrap button delegates to current-offer acceptance; no silent or repeat claim.';
comment on function public.findback_role_grant(text,text,text[]) is 'Admin-only pending role offer, including existing accounts. No assignment until explicit acceptance.';

notify pgrst,'reload schema';
commit;
