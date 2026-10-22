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
select 'R3 confirmation consumes invitation with its latest narrowed set' as probe
where (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d102')=array['content_hide']
and exists(select 1 from public.role_invitations where email='invite-probe@example.invalid' and accepted_at is not null)
and exists(select 1 from public.admin_audit_log where action='INVITATION_ACCEPTED' and target_id='00000000-0000-4000-8000-00000000d102' and previous_state->>'invited_by'='00000000-0000-4000-8000-00000000d101');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select public.findback_role_grant('direct-probe@example.invalid','MODERATOR',array['content_hide']);
reset role;
select set_config('request.jwt.claim.sub','',true);
update auth.users set email_confirmed_at=now() where id='00000000-0000-4000-8000-00000000d103';
select 'R4 newer direct grant survives confirmation; stale invitation revoked and audited' as probe
where (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d103')=array['content_hide']
and exists(select 1 from public.role_invitations where email='direct-probe@example.invalid' and revoked_at is not null and accepted_at is null)
and exists(select 1 from public.admin_audit_log where action='INVITATION_REVOKED' and target_id='direct-probe@example.invalid');

insert into auth.users(id,email,email_confirmed_at)
values('00000000-0000-4000-8000-00000000d104','social-probe@example.invalid',now());
select 'R5 already-confirmed auth insertion consumes invitation' as probe
where exists(select 1 from public.user_roles where user_id='00000000-0000-4000-8000-00000000d104' and role='MODERATOR')
and exists(select 1 from public.role_invitations where email='social-probe@example.invalid' and accepted_at is not null);

savepoint regrant_case;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select public.findback_role_grant('invite-probe@example.invalid','MODERATOR',array['reports_review']);
reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R7 regrant of an existing moderator audits the role and capability set it replaced' as probe
where (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d102')=array['reports_review']
and exists(
  select 1 from public.admin_audit_log
   where action='ROLE_GRANTED'
     and target_id='00000000-0000-4000-8000-00000000d102'
     and previous_state->>'role'='MODERATOR'
     and (select array_agg(value order by value) from jsonb_array_elements_text(previous_state->'capabilities'))=array['content_hide']
     and (select array_agg(value order by value) from jsonb_array_elements_text(new_state->'capabilities'))=array['reports_review']
);
release savepoint regrant_case;

savepoint demotion_case;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000d105','role_demote_probe','demote-probe@example.invalid','+8801710000105',1,'2020-01-01','2020-01-01');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000d101',true);
select public.findback_role_grant('demote-probe@example.invalid','ADMIN',array[]::text[]);
select public.findback_role_grant('demote-probe@example.invalid','MODERATOR',array['content_hide']);
reset role;
select set_config('request.jwt.claim.sub','',true);
select 'R8 an admin demotion really replaces the role set and audits the ADMIN state it removed' as probe
where (select array_agg(role order by role) from public.user_roles where user_id='00000000-0000-4000-8000-00000000d105')=array['MODERATOR']
and (select array_agg(capability order by capability) from public.user_role_capabilities where user_id='00000000-0000-4000-8000-00000000d105')=array['content_hide']
and exists(
  select 1 from public.admin_audit_log
   where action='ROLE_GRANTED'
     and target_id='00000000-0000-4000-8000-00000000d105'
     and previous_state->>'role'='ADMIN'
     and new_state->>'role'='MODERATOR'
);
release savepoint demotion_case;
rollback;
