-- Run only on a disposable local Supabase database AFTER the migrations:
-- psql --set ON_ERROR_STOP=1 --file supabase/tests/auth_phone_verification_sync.test.sql
-- No Auth HTTP calls or SMS. Fixtures and assertions always roll back.
begin;

do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_badge integer;
  v_phone text;
  v_email_badge integer;
begin
  assert public.findback_normalize_bd_phone('01812345678') = '+8801812345678';
  assert public.findback_normalize_bd_phone('8801812345678') = '+8801812345678';
  assert public.findback_normalize_bd_phone('+88018-1234 5678') = '+8801812345678';
  assert public.findback_normalize_bd_phone('01212345678') is null;
  assert public.findback_normalize_bd_phone('') is null;
  assert public.findback_normalize_bd_phone(null) is null;

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_a, v_a::text || '@example.invalid', jsonb_build_object('username', 'pa_' || left(v_a::text, 8), 'phone', '01812345678', 'phoneVerified', true)),
    (v_b, v_b::text || '@example.invalid', jsonb_build_object('username', 'pb_' || left(v_b::text, 8), 'phone', '+8801812345678', 'phone_verified', true));

  select phone_verified, phone into v_badge, v_phone from public.users where id = v_a::text;
  assert v_badge = 0, 'Client metadata must not grant verification';
  assert v_phone = '+8801812345678', 'Display number must normalize';
  assert (select phone_verified = 0 from public.users where id = v_b::text), 'Same unverified display number can be saved by another account';

  -- Starting a challenge must not prove ownership or change email signup state.
  update auth.users set phone_change = '8801812345678' where id = v_a;
  assert (select phone_verified = 0 from public.users where id = v_a::text);

  -- Equivalent to GoTrue's confirmed-phone update (NOT an actual SMS test).
  update auth.users set phone = '8801812345678', phone_confirmed_at = now(), phone_change = '', email_confirmed_at = now() where id = v_a;
  select phone_verified, email_verified into v_badge, v_email_badge from public.users where id = v_a::text;
  assert v_badge = 1, 'Confirmed auth phone must grant its own matching badge';
  assert v_email_badge = 1, 'Email confirmation sync must remain intact';
  assert (select phone_verified = 0 from public.users where id = v_b::text), 'Confirmation must never update another account';

  -- Editing display metadata immediately clears proof. Neither metadata flags
  -- nor a code delivered to the previous number can verify the edited number.
  update auth.users set raw_user_meta_data = raw_user_meta_data || '{"phone":"01912345678","phoneVerified":true}'::jsonb where id = v_a;
  select phone_verified, phone into v_badge, v_phone from public.users where id = v_a::text;
  assert v_badge = 0, 'An edited number requires its own verification';
  assert v_phone = '+8801912345678';
  update auth.users set phone_confirmed_at = now() where id = v_a;
  assert (select phone_verified = 0 from public.users where id = v_a::text), 'Old phone proof cannot verify a new display number';

  update auth.users set phone = '8801912345678', phone_confirmed_at = now() where id = v_a;
  assert (select phone_verified = 1 from public.users where id = v_a::text);
  update auth.users set phone_confirmed_at = null where id = v_a;
  assert (select phone_verified = 0 from public.users where id = v_a::text), 'Revoked confirmation must clear the badge';

  assert not has_column_privilege('authenticated', 'public.users', 'phone_verified', 'UPDATE');
  assert not has_column_privilege('authenticated', 'public.users', 'phone', 'SELECT');
  assert not has_function_privilege('authenticated', 'public.handle_auth_user_updated()', 'EXECUTE');
  assert not has_function_privilege('anon', 'public.findback_normalize_bd_phone(text)', 'EXECUTE');
end;
$$;

rollback;
