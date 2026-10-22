-- DISPOSABLE LOCAL BACKEND ONLY. Real roles/RLS, scratch data, always rolled back.
-- Run after the full chain and the catalog verifier; never against hosted data.
begin;
insert into public.users (id, username, email, phone, created_at, updated_at) values
 ('00000000-0000-4000-8000-00000000e101', 'clear_probe_a', 'clear-a@example.invalid', '+1555000e101', '2020-01-01', '2020-01-01'),
 ('00000000-0000-4000-8000-00000000e102', 'clear_probe_b', 'clear-b@example.invalid', '+1555000e102', '2020-01-01', '2020-01-01');
insert into public.item_posts (id, user_id, type, title, description, category, event_date, latitude, longitude, location_label, youtube_url, created_at, updated_at) values
 ('clear-probe-a', '00000000-0000-4000-8000-00000000e101', 'LOST', 'Probe title', 'A valid probe description', 'Electronics', '2020-01-01', 1.5, 2.5, 'Old place', 'https://youtu.be/abcdefghijk', '2020-01-01', '2020-01-01'),
 ('clear-probe-b', '00000000-0000-4000-8000-00000000e102', 'FOUND', 'Other title', 'Another valid description', 'Electronics', '2020-01-01', 3.5, 4.5, 'Other place', null, '2020-01-01', '2020-01-01'),
 ('clear-probe-legacy', '00000000-0000-4000-8000-00000000e101', 'LOST', 'Legacy title', 'A valid probe description', 'Electronics', '', null, null, null, null, '2020-01-01', '2020-01-01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000e101', true);
do $$
declare
  before_row jsonb;
  after_row jsonb;
  field text;
  ok boolean;
begin
  select to_jsonb(p) - 'updated_at' into before_row from public.item_posts p where id = 'clear-probe-a';
  -- A real ten-positional-argument caller, then the explicit null/empty arrays.
  ok := public.findback_update_post_client('clear-probe-a', null, 'Changed title', null, null, null, null, null, null, null);
  if ok is distinct from true then raise exception 'B1 ten-argument caller did not succeed'; end if;
  select to_jsonb(p) - 'updated_at' into after_row from public.item_posts p where id = 'clear-probe-a';
  if after_row is distinct from jsonb_set(before_row, '{title}', '"Changed title"') then raise exception 'B1 unrelated stored values changed'; end if;
  if not exists(select 1 from public.item_posts where id='clear-probe-a' and updated_at is not null and updated_at <> '2020-01-01') then raise exception 'B1 timestamp not updated'; end if;
  before_row := after_row;
  perform public.findback_update_post_client('clear-probe-a', p_clear_fields => null);
  perform public.findback_update_post_client('clear-probe-a', p_clear_fields => array[]::text[]);
  select to_jsonb(p) - 'updated_at' into after_row from public.item_posts p where id = 'clear-probe-a';
  if after_row is distinct from before_row then raise exception 'B2 null/empty array changed a field'; end if;

  perform public.findback_update_post_client('clear-probe-a', p_clear_fields => array[' LOCATION_LABEL ']);
  if not exists(select 1 from public.item_posts where id='clear-probe-a' and location_label is null and latitude=1.5 and longitude=2.5) then raise exception 'B3 normalized label clear failed'; end if;
  perform public.findback_update_post_client('clear-probe-a', p_location_label => 'New place', p_clear_fields => array['location_label']);
  if not exists(select 1 from public.item_posts where id='clear-probe-a' and location_label='New place') then raise exception 'B4 explicit label did not win'; end if;

  foreach field in array array['latitude','longitude'] loop
    perform public.findback_update_post_client('clear-probe-a', p_latitude => 1.5, p_longitude => 2.5);
    perform public.findback_update_post_client('clear-probe-a', p_clear_fields => array[field]);
    if not exists(select 1 from public.item_posts where id='clear-probe-a' and latitude is null and longitude is null and location_label='New place') then raise exception 'B5 coordinate pair clear failed: %', field; end if;
  end loop;
  select to_jsonb(p) into before_row from public.item_posts p where id='clear-probe-a';
  foreach field in array array['type','title','description','category','event_date','nonsense',''] loop
    begin
      perform public.findback_update_post_client('clear-probe-a', p_clear_fields => array[field]);
      raise exception 'B6 refused field accepted: %', field;
    exception when sqlstate '22023' then null; end;
  end loop;
  begin
    perform public.findback_update_post_client('clear-probe-a', p_clear_fields => array['latitude'], p_latitude => 3.5);
    raise exception 'B7 clear/set latitude conflict accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.findback_update_post_client('clear-probe-a', p_clear_fields => array['longitude'], p_longitude => 3.5);
    raise exception 'B7 clear/set longitude conflict accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.findback_update_post_client('clear-probe-a', p_title => 'x');
    raise exception 'B8 invalid title accepted';
  exception when sqlstate '22023' then null; end;
  select to_jsonb(p) into after_row from public.item_posts p where id='clear-probe-a';
  if after_row is distinct from before_row then raise exception 'B9 refusal changed stored row'; end if;

  begin
    perform public.findback_update_post_client('clear-probe-legacy', p_title => 'Updated legacy title');
    raise exception 'B10 invalid stored row accepted';
  exception when sqlstate '22023' then null; end;
  if not exists(select 1 from public.item_posts where id='clear-probe-legacy' and title='Legacy title' and event_date='') then raise exception 'B10 stored row changed on refusal'; end if;
  begin
    perform public.findback_update_post_client('clear-probe-b', p_title => 'Unauthorized title');
    raise exception 'B11 other owner accepted';
  exception when sqlstate '42501' then null; end;
  begin
    perform public.findback_update_post_client('clear-probe-missing', p_title => 'Missing title');
    raise exception 'B12 missing row accepted';
  exception when sqlstate '42501' then null; end;
end;
$$;
select 'B1-B12 owner, merged validation, legacy callers, clears, refusals, timestamps' as probe;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  begin
    perform public.findback_update_post_client('clear-probe-a');
    raise exception 'B13 no-session caller accepted';
  exception when sqlstate '28000' then null; end;
end $$;
set local role anon;
do $$ begin
  begin
    perform public.findback_update_post_client('clear-probe-a');
    raise exception 'B14 anonymous caller accepted';
  exception when sqlstate '42501' then null; end;
end $$;
reset role;
select 'B13-B14 no-session and anonymous refusals' as probe;
select 'B15 nonowner row unchanged' as probe
where exists(select 1 from public.item_posts where id='clear-probe-b' and title='Other title' and latitude=3.5 and longitude=4.5);
rollback;
