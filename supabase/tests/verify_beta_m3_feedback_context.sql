-- Non-secret synthetic token-like metadata, not credentials or owner data.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
values('00000000-0000-4000-9600-000000000001','m3context','m3context@example.invalid','+8801960000001',1,'2026-10-29T00:00:00Z','2026-10-29T00:00:00Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9600-000000000001',true);
select set_config('m3c.clean',public.findback_submit_feedback('OTHER','Synthetic metadata check',true,'0.9.0-beta.1','android','feedback','large screen'),true);
select set_config('m3c.dirty',public.findback_submit_feedback('BUG','Synthetic unsafe context check',true,'Bearer fixture-only','fixture-token','auth?code=fixture','fixture-device-id'),true);
select set_config('m3c.optout',public.findback_submit_feedback('USABILITY','Synthetic opt-out check',false,'Bearer fixture-only','fixture-token','auth?code=fixture','fixture-device-id'),true);
reset role;
do $$ begin
 if (select technical_context->>'app_version' from public.feedback where id=current_setting('m3c.clean'))<>'0.9.0-beta.1'
  or (select technical_context->>'device_class' from public.feedback where id=current_setting('m3c.clean'))<>'large screen' then
  raise exception 'M3 CONTEXT FAILED: valid opt-in scalars lost';
 end if;
 if (select technical_context from public.feedback where id=current_setting('m3c.dirty')) is distinct from
  (select jsonb_build_object('captured_at',created_at) from public.feedback where id=current_setting('m3c.dirty')) then
  raise exception 'M3 CONTEXT FAILED: arbitrary metadata entered support context';
 end if;
 if (select technical_context from public.feedback where id=current_setting('m3c.optout')) is not null then
  raise exception 'M3 CONTEXT FAILED: opt-out stored context';
 end if;
end $$;
select 'M3 optional support metadata sanitized to known scalars' as probe;
rollback;
