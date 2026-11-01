-- Disposable local PostgreSQL only. Role/RLS mutations and auth trigger paths.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000d101','role_admin_probe','role-admin@example.invalid','+8801710000101',1,'2020-01-01','2020-01-01');
insert into public.user_roles(user_id,role,granted_by,granted_at)
values('00000000-0000-4000-8000-00000000d101','ADMIN',null,'2020-01-01');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select public.findback_role_grant('invite-probe@example.invalid','MODERATOR',array['reports_review','content_hide']);
select public.findback_role_grant('direct-probe@example.invalid','MODERATOR',array['reports_review','content_hide']);
select public.findback_role_grant('social-probe@example.invalid','MODERATOR',array['reports_review']);
reset role;
select set_config('request.jwt.claim.sub','',true);
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000d102','invite-probe@example.invalid'),
 ('00000000-0000-4000-8000-00000000d103','direct-probe@example.invalid');
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000d102','role_invite_probe','invite-probe@example.invalid','+8801710000102',0,'2020-01-01','2020-01-01'),
 ('00000000-0000-4000-8000-00000000d103','role_direct_probe','direct-probe@example.invalid','+8801710000103',0,'2020-01-01','2020-01-01'),
 ('00000000-0000-4000-8000-00000000d104','role_social_probe','social-probe@example.invalid','+8801710000104',0,'2020-01-01','2020-01-01');
select 'R1 unconfirmed auth/profile insert leaves invitations live and roles absent' as probe
where (select count(*) from public.role_invitations where email in ('invite-probe@example.invalid','direct-probe@example.invalid') and accepted_at is null and revoked_at is null)=2
and not exists(select 1 from public.user_roles where user_id in ('00000000-0000-4000-8000-00000000d102','00000000-0000-4000-8000-00000000d103'));

savepoint capabilities_case;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select 'R2 roleless account still configures its live invitation' as probe
where public.findback_role_set_capabilities('invite-probe@example.invalid',array['content_hide'])->>'kind'='invitation';
release savepoint capabilities_case;

reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R6 invitation narrowing audits the REAL prior capability set' as probe
where exists(
  select 1 from public.admin_audit_log
   where action='INVITATION_CAPABILITIES_CHANGED'
     and target_id='invite-probe@example.invalid'
     and (select array_agg(value order by value) from jsonb_array_elements_text(previous_state->'capabilities'))=array['content_hide','reports_review']
     and (select array_agg(value order by value) from jsonb_array_elements_text(new_state->'capabilities'))=array['content_hide']
);

reset role;
select set_config('request.jwt.claim.sub','',true);
update auth.users set email_confirmed_at=now() where id='00000000-0000-4000-8000-00000000d102';
select 'R3a confirmation alone leaves invitation and authority untouched' as probe
where not exists(select 1 from public.user_roles where user_id='00000000-0000-4000-8000-00000000d102')
and exists(select 1 from public.role_invitations where email='invite-probe@example.invalid' and accepted_at is null and revoked_at is null);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d102',true);
select public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R3 explicit acceptance consumes invitation with its latest narrowed set' as probe
where (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d102')=array['content_hide']
and exists(select 1 from public.role_invitations where email='invite-probe@example.invalid' and accepted_at is not null)
and exists(select 1 from public.admin_audit_log where action='ROLE_OFFER_ACCEPTED' and target_id='00000000-0000-4000-8000-00000000d102' and new_state->>'accepted'='true'
 and new_state->>'invitation_id'=(select id::text from public.role_invitations where email='invite-probe@example.invalid' and accepted_at is not null));

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select public.findback_role_set_capabilities('direct-probe@example.invalid',array['content_hide']);
reset role;
select set_config('request.jwt.claim.sub','',true);
update auth.users set email_confirmed_at=now() where id='00000000-0000-4000-8000-00000000d103';
select 'R4a changed pending offer remains unassigned after confirmation' as probe
where not exists(select 1 from public.user_roles where user_id='00000000-0000-4000-8000-00000000d103')
and exists(select 1 from public.role_invitations where email='direct-probe@example.invalid' and accepted_at is null and revoked_at is null and capabilities=array['content_hide']);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d103',true);
select public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R4 explicit acceptance uses the latest offer, not the old capability set' as probe
where (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d103')=array['content_hide']
and exists(select 1 from public.role_invitations where email='direct-probe@example.invalid' and revoked_at is null and accepted_at is not null)
and exists(select 1 from public.admin_audit_log where action='ROLE_OFFER_ACCEPTED' and target_id='00000000-0000-4000-8000-00000000d103');

insert into auth.users(id,email,email_confirmed_at)
values('00000000-0000-4000-8000-00000000d104','social-probe@example.invalid',now());
select 'R5a already-confirmed auth insertion does not consume invitation' as probe
where not exists(select 1 from public.user_roles where user_id='00000000-0000-4000-8000-00000000d104')
and exists(select 1 from public.role_invitations where email='social-probe@example.invalid' and accepted_at is null and revoked_at is null);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d104',true);
select public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R5 confirmed social account can explicitly accept its invitation' as probe
where exists(select 1 from public.user_roles where user_id='00000000-0000-4000-8000-00000000d104' and role='MODERATOR')
and exists(select 1 from public.role_invitations where email='social-probe@example.invalid' and accepted_at is not null);

savepoint regrant_case;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select public.findback_role_grant('invite-probe@example.invalid','MODERATOR',array['reports_review']);
reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R7a replacement offer leaves accepted moderator powers intact until consent' as probe
where (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d102')=array['content_hide']
and exists(select 1 from public.role_invitations where email='invite-probe@example.invalid' and accepted_at is null and revoked_at is null and capabilities=array['reports_review']);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d102',true);
select public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R7 explicit replacement acceptance updates powers and audits the prior role' as probe
where (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d102')=array['reports_review']
and exists(
  select 1 from public.admin_audit_log
   where action='ROLE_OFFER_ACCEPTED'
     and target_id='00000000-0000-4000-8000-00000000d102'
     and previous_state->>'role'='MODERATOR'
     and new_state->>'role'='MODERATOR' and new_state->>'accepted'='true'
);
release savepoint regrant_case;

savepoint demotion_case;
insert into auth.users(id,email,email_confirmed_at)
values('00000000-0000-4000-8000-00000000d105','demote-probe@example.invalid',now());
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000d105','role_demote_probe','demote-probe@example.invalid','+8801710000105',1,'2020-01-01','2020-01-01');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select public.findback_role_grant('demote-probe@example.invalid','ADMIN',array[]::text[]);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d105',true);
select public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select public.findback_role_grant('demote-probe@example.invalid','MODERATOR',array['content_hide']);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d105',true);
select 'R8a demotion proposal leaves existing admin authority intact' as probe where public.findback_has_role('ADMIN');
select public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R8 accepted non-last-admin demotion replaces powers and audits removed ADMIN state' as probe
where (select array_agg(role order by role) from public.user_roles where user_id='00000000-0000-4000-8000-00000000d105')=array['MODERATOR']
and (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d105')=array['content_hide']
and exists(
  select 1 from public.admin_audit_log
   where action='ROLE_OFFER_ACCEPTED'
     and target_id='00000000-0000-4000-8000-00000000d105'
     and previous_state->>'role'='ADMIN'
     and new_state->>'role'='MODERATOR'
);
release savepoint demotion_case;
rollback;
