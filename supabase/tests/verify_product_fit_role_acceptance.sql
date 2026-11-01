-- Synthetic disposable local full-chain fixture; never creates real accounts.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('00000000-0000-4000-8000-00000000f801','admin@role.invalid',now()),
 ('00000000-0000-4000-8000-00000000f802','mod@role.invalid',now()),
 ('00000000-0000-4000-8000-00000000f803','ordinary@role.invalid',now()),
 ('00000000-0000-4000-8000-00000000f804','incomplete@role.invalid',now()),
 ('00000000-0000-4000-8000-00000000f805','unconfirmed@role.invalid',null);
insert into public.role_invitations(email,role,capabilities,invited_at) values
 ('mod@role.invalid','MODERATOR',array['reports_review'],'2026-11-01'),
 ('unconfirmed@role.invalid','ADMIN','{}','2026-11-01'),
 ('incomplete@role.invalid','ADMIN','{}','2026-11-01');
insert into public.bootstrap_admins(email,created_at) values ('admin@role.invalid','2026-11-01');
insert into public.users(id,username,email,email_verified,phone,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000f801','offer_admin','admin@role.invalid',1,'+1555f801','2026-11-01','2026-11-01'),
 ('00000000-0000-4000-8000-00000000f802','offer_mod','mod@role.invalid',1,'+1555f802','2026-11-01','2026-11-01'),
 ('00000000-0000-4000-8000-00000000f803','offer_ordinary','ordinary@role.invalid',1,'+1555f803','2026-11-01','2026-11-01'),
 ('00000000-0000-4000-8000-00000000f805','offer_unconfirmed','unconfirmed@role.invalid',1,'+1555f805','2026-11-01','2026-11-01');
select 'R1 confirmed signup/profile never assigns a role or consumes an invitation' as probe where
 not exists(select 1 from public.user_roles where user_id like '%f80_')
 and not exists(select 1 from public.role_invitations where email like '%@role.invalid' and accepted_at is not null);
select 'R2 private RPC/table ACLs' as probe where
 not has_function_privilege('anon','public.findback_my_role_offer()','EXECUTE')
 and not has_function_privilege('anon','public.findback_accept_role_offer(text)','EXECUTE')
 and not has_table_privilege('authenticated','public.bootstrap_admins','SELECT')
 and not has_table_privilege('authenticated','public.role_invitations','UPDATE');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f803',true);
select 'R3 ordinary account has no offer or privilege' as probe where
 public.findback_my_role_offer() is null and not public.findback_can('roles_manage');
do $$begin perform public.findback_accept_role_offer('bootstrap');raise exception 'ordinary account acquired admin';
 exception when insufficient_privilege then null;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f805',true);
select 'R4 authoritative Auth confirmation required even if profile says verified' as probe where public.findback_my_role_offer() is null;
do $$begin perform public.findback_bootstrap_admin();raise exception 'unconfirmed legacy bootstrap bypass';
 exception when insufficient_privilege then null;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f804',true);
select 'R5 normal profile setup precedes offer discovery' as probe where public.findback_my_role_offer() is null;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f801',true);
select 'R6 discovery names Admin but never grants' as probe where
 public.findback_my_role_offer()->>'role'='ADMIN' and not public.findback_has_role('ADMIN');
savepoint legacy_bootstrap;
select 'R6a legacy explicit bootstrap delegates to common acceptance' as probe where public.findback_bootstrap_admin();
select 'R6b legacy explicit bootstrap consumes authority and creates server role' as probe where
 public.findback_has_role('ADMIN') and not (public.findback_bootstrap_claim_status()->>'can_claim')::boolean;
rollback to savepoint legacy_bootstrap;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f802',true);
do $$begin perform public.findback_accept_role_offer('bootstrap:00000000-0000-4000-8000-00000000f801');raise exception 'another account bootstrap token accepted';
 exception when insufficient_privilege then null;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f801',true);
select 'R7 explicit bootstrap acceptance creates server-authoritative admin' as probe where
 public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
select 'R8 accepted bootstrap not offered again; server role and capabilities read live' as probe where
 public.findback_my_role_offer() is null and public.findback_has_role('ADMIN') and public.findback_can('roles_manage');
do $$begin perform public.findback_accept_role_offer('bootstrap');raise exception 'bootstrap replay accepted';
 exception when insufficient_privilege then null;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f802',true);
select 'R9 moderator offer reveals only safe self fields; discovery never grants' as probe where
 (select array_agg(k order by k)=array['capabilities','role','token']::text[] from jsonb_object_keys(public.findback_my_role_offer()) k)
 and public.findback_my_role_offer()->>'role'='MODERATOR' and not public.findback_has_role('MODERATOR');
select 'R10 explicit moderator acceptance creates only offered powers' as probe where
 public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
select 'R11 moderator cannot exercise admin powers or replay' as probe where
 public.findback_has_role('MODERATOR') and public.findback_can('reports_review') and not public.findback_can('roles_manage')
 and public.findback_my_role_offer() is null;
do $$begin perform public.findback_role_grant('ordinary@role.invalid','ADMIN','{}');raise exception 'moderator created admin offer';
 exception when insufficient_privilege then null;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f801',true);
select 'R12 admin grant to existing account is an offer, never a direct role' as probe where
 public.findback_role_grant('ordinary@role.invalid','MODERATOR',array['reports_review'])->>'kind'='invitation';
reset role;
select 'R13 existing ordinary account remains unprivileged pending acceptance' as probe where
 not exists(select 1 from public.user_roles where user_id='00000000-0000-4000-8000-00000000f803');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f803',true);
do $$declare token text;begin
 token:=public.findback_my_role_offer()->>'token';
 -- Current offer may change after a user sees it; test mutation done separately below.
 perform set_config('findback.test_offer_token',token,true);
end$$;
reset role;
update auth.users set email_confirmed_at=null where id='00000000-0000-4000-8000-00000000f803';
set local role authenticated;
select 'R13a confirmation withdrawn after discovery removes offer' as probe where public.findback_my_role_offer() is null;
do $$begin perform public.findback_accept_role_offer(current_setting('findback.test_offer_token'));raise exception 'stale identity confirmation accepted';
 exception when insufficient_privilege then null;end$$;
reset role;
update auth.users set email_confirmed_at=now() where id='00000000-0000-4000-8000-00000000f803';
update public.role_invitations set capabilities=array['reports_review','feedback_read'] where email='ordinary@role.invalid' and accepted_at is null;
set local role authenticated;
do $$begin perform public.findback_accept_role_offer(current_setting('findback.test_offer_token'));raise exception 'changed offer accepted with stale token';
 exception when insufficient_privilege then null;end$$;
select 'R14 stale token denied without assignment; new offer can be explicitly accepted' as probe where
 not public.findback_has_role('MODERATOR') and public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');
select 'R15 changed offer capabilities accepted only after new consent' as probe where public.findback_can('feedback_read');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f801',true);
do $$begin perform public.findback_role_revoke('ordinary@role.invalid');end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f803',true);
select 'R16 immediate revoke invalidates capabilities' as probe where not public.findback_can('feedback_read');
reset role;
update public.users set email='incomplete@role.invalid' where id='00000000-0000-4000-8000-00000000f803';
set local role authenticated;
select 'R17 profile-email spoof cannot acquire an Auth-email offer' as probe where public.findback_my_role_offer() is null;
reset role;
update public.users set email='ordinary@role.invalid' where id='00000000-0000-4000-8000-00000000f803';
select 'R18 bootstrap marked claimed; no old auto-consume triggers remain' as probe where
 (select claimed_at is not null and claimed_by='00000000-0000-4000-8000-00000000f801' from public.bootstrap_admins where email='admin@role.invalid')
 and not exists(select 1 from pg_trigger where tgname in ('on_role_invitation_auth_user_created','on_role_invitation_auth_user_confirmed','on_role_invitation_profile_created'));
-- A live offer still cannot cross an account-deletion fence.
insert into public.account_deletion_fences(user_id) values('00000000-0000-4000-8000-00000000f804');
insert into public.users(id,username,email,email_verified,phone,created_at,updated_at) values
 ('00000000-0000-4000-8000-00000000f804','offer_incomplete','incomplete@role.invalid',1,'+1555f804','2026-11-01','2026-11-01');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f804',true);
select 'R19 deleting account cannot discover its live offer' as probe where public.findback_my_role_offer() is null;
do $$begin perform public.findback_accept_role_offer(null);raise exception 'null token accepted';
 exception when insufficient_privilege then null;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000f801',true);
do $$begin perform public.findback_role_grant('admin@role.invalid','MODERATOR',array['reports_review']);end$$;
do $$begin perform set_config('findback.test_revoked_token',public.findback_my_role_offer()->>'token',true);end$$;
do $$begin perform public.findback_accept_role_offer(public.findback_my_role_offer()->>'token');raise exception 'last admin demoted';
 exception when insufficient_privilege then null;end$$;
select 'R20 last-admin refusal rolls back offer consumption and authority changes' as probe where
 public.findback_has_role('ADMIN') and public.findback_my_role_offer()->>'role'='MODERATOR';
do $$begin perform public.findback_role_revoke('admin@role.invalid');raise exception 'last admin revoked';
 exception when insufficient_privilege then null;end$$;
reset role;
-- Revoke pending proposal directly as maintenance fixture, not production API.
update public.role_invitations set revoked_at='2026-11-02' where email='admin@role.invalid' and accepted_at is null;
set local role authenticated;
select 'R21 revoked offer is no longer discoverable or acceptable' as probe where public.findback_my_role_offer() is null;
do $$begin perform public.findback_accept_role_offer(current_setting('findback.test_revoked_token'));raise exception 'revoked invitation token accepted';
 exception when insufficient_privilege then null;end$$;
do $$begin perform public.findback_accept_role_offer('bootstrap:00000000-0000-4000-8000-00000000f801');raise exception 'claimed bootstrap replay';
 exception when insufficient_privilege then null;end$$;
reset role;
select 'R22 accepted roles correspond to consumed offers; no ordinary privilege' as probe where
 (select count(*)=2 from public.user_roles where user_id like '%f80_')
 and not exists(select 1 from public.user_roles where user_id in ('00000000-0000-4000-8000-00000000f803','00000000-0000-4000-8000-00000000f804','00000000-0000-4000-8000-00000000f805'));
rollback;
