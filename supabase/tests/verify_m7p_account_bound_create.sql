-- Statement-level binding closes the SDK's second session-read race. Synthetic
-- loopback roles only; both wrappers retain canonical validation/RLS ownership.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) values
 ('00000000-0000-4000-9901-000000000001','bound_a','bound_a@example.invalid','+100009910001',1,now(),now()),
 ('00000000-0000-4000-9901-000000000002','bound_b','bound_b@example.invalid','+100009910002',1,now(),now());
set local role authenticated;
-- Simulate A's check having succeeded, but B owning the dispatch credential.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9901-000000000002',true);
do $$ declare expected text; begin
 foreach expected in array array['00000000-0000-4000-9901-000000000001',null,''] loop
  begin
   perform public.findback_create_post_client_bound(expected,'LOST','Stale report','A draft must not become B content','Electronics','2026-10-30');
   raise exception 'single create admitted a mismatched or absent account';
  exception when insufficient_privilege then null; end;
  begin
   perform public.findback_create_post_client_multi_bound(expected,'LOST','Stale report','A draft must not become B content','Electronics','2026-10-30');
   raise exception 'multi create admitted a mismatched or absent account';
  exception when insufficient_privilege then null; end;
 end loop;
end $$;
reset role;
do $$ begin
 assert not exists(select 1 from public.item_posts where user_id in
  ('00000000-0000-4000-9901-000000000001','00000000-0000-4000-9901-000000000002')),
  'refused dispatches leave no report';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9901-000000000001',true);
select set_config('bound.single',public.findback_create_post_client_bound(auth.uid()::text,
 'LOST','Own report','A valid draft still publishes','Electronics','2026-10-30'),true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9901-000000000002',true);
select set_config('bound.multi',public.findback_create_post_client_multi_bound(auth.uid()::text,
 'FOUND','Own multi report','A valid multi draft still publishes','Electronics','2026-10-30'),true);
reset role;
do $$ begin
 assert exists(select 1 from public.item_posts where id=current_setting('bound.single')
  and user_id='00000000-0000-4000-9901-000000000001'),'single owner stays A';
 assert exists(select 1 from public.item_posts where id=current_setting('bound.multi')
  and user_id='00000000-0000-4000-9901-000000000002'),'multi owner stays B';
 assert not has_function_privilege('anon',
  'public.findback_create_post_client_bound(text,text,text,text,text,text,double precision,double precision,text,text,text)','EXECUTE'),
  'anonymous cannot call bound create';
end $$;
select 'account-bound create SQL assertions passed' as result;
rollback;
