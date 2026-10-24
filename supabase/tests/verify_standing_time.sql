-- F3 clock-wrapper and normalization contracts; runtime day-wait is a separate gate.
begin;

select 'all six standing/time entry points are volatile' as probe
where (select count(*) from pg_proc
  where oid in ('public.findback_active_sanction_kind(text)'::regprocedure,
    'public.findback_reputation_tier(text)'::regprocedure,
    'public.findback_post_limit_for(text)'::regprocedure,
    'public.findback_post_limit()'::regprocedure,
    'public.findback_standing(text)'::regprocedure,
    'public.findback_enforce_interaction_limit()'::regprocedure)
  and provolatile='v')=6;

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
values('00000000-0000-4000-9601-000000000001','standing_contract','standing_contract@example.invalid','+8801961000001',1,'2026-10-24T00:00:00Z','2026-10-24T00:00:00Z');
insert into public.account_sanctions(id,user_id,kind,starts_at,reason_code,created_at)
values('standing-contract-sanction','00000000-0000-4000-9601-000000000001','RESTRICTED','2020-01-01T00:00:00Z','OTHER','2020-01-01T00:00:00Z');
select 'internal padded input cannot bypass restricted standing' as probe
where (select limit_per_day from public.findback_post_limit_for('  00000000-0000-4000-9601-000000000001  '))=0;
do $$
declare value text;
begin
  foreach value in array array[null::text,'','   '] loop
    begin
      perform public.findback_post_limit_for(value);
      raise exception 'blank standing input succeeded' using errcode='XX000';
    exception when invalid_parameter_value then null;
    end;
  end loop;
end $$;

select 'only caller-scoped wrappers are executable by authenticated' as probe
where has_function_privilege('authenticated','public.findback_standing(text)','execute')
  and has_function_privilege('authenticated','public.findback_post_limit()','execute')
  and not has_function_privilege('authenticated','public.findback_post_limit_for(text)','execute')
  and not has_function_privilege('authenticated','public.findback_active_sanction_kind(text)','execute')
  and not has_function_privilege('authenticated','public.findback_enforce_interaction_limit()','execute');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9601-000000000001',true);
select 'self standing remains restricted' as probe where public.findback_standing()='RESTRICTED';
select 'self limit remains zero' as probe where (select limit_per_day from public.findback_post_limit())=0;
do $$
begin
  perform public.findback_standing('00000000-0000-4000-9601-000000000002');
  raise exception 'foreign standing succeeded' using errcode='XX000';
exception when insufficient_privilege then null;
end $$;
reset role;
rollback;
