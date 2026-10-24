-- F3 forward repair: a UTC day sampled before the actor lock can become stale
-- while waiting across midnight. Preserve applied 20261024050000 unchanged.
-- Same authority, quotas, standing and cooldown; sample the day after the lock.
begin;

create or replace function public.findback_enforce_interaction_limit()
returns trigger
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_actor text := btrim(coalesce(new.user_id, ''));
  v_self boolean;
  v_probation boolean;
  v_limit integer;
  v_cooldown integer;
  v_count integer;
  v_last text;
  v_day_start timestamptz;
begin
  if v_actor = '' then
    return new;
  end if;

  v_self := coalesce(v_uid = v_actor, false);

  perform pg_advisory_xact_lock(hashtextextended('findback_public_admission:' || v_actor, 0));
  v_day_start := (date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc');
  v_probation := public.findback_active_sanction_kind(v_actor) = 'PROBATION';

  if v_probation then
    select l.limit_per_day into v_limit from public.findback_post_limit_for(v_actor) l;
    if v_limit <= 0 then
      raise exception 'POST_NOT_AVAILABLE: your account cannot post or comment right now' using errcode = 'P0001';
    end if;
    select count(*) into v_count
      from public.public_action_admissions a
     where a.user_id = v_actor
       and a.action_kind = case tg_table_name when 'item_posts' then 'POST' else 'COMMENT' end
       and a.admitted_at >= v_day_start;
    if tg_table_name = 'item_posts' then
      select greatest(v_count, count(*)) into v_count
        from public.item_posts p
       where p.user_id = v_actor
         and nullif(btrim(p.created_at), '')::timestamptz >= v_day_start;
    else
      select greatest(v_count, count(*)) into v_count
        from public.comments c
       where c.user_id = v_actor
         and nullif(btrim(c.created_at), '')::timestamptz >= v_day_start;
    end if;
    if v_count >= v_limit then
      raise exception 'POST_LIMIT_REACHED: you have reached today''s limit of %', v_limit using errcode = 'P0001';
    end if;
    perform public.findback_public_admission_check(v_actor,
      case tg_table_name when 'item_posts' then 'POST' else 'COMMENT' end);
    return new;
  end if;

  if not v_self then
    return new;
  end if;

  select l.limit_per_day, l.burst_cooldown_seconds
    into v_limit, v_cooldown
    from public.findback_post_limit_for(v_actor) l;

  if v_limit <= 0 then
    raise exception 'POST_NOT_AVAILABLE: your account cannot post or comment right now' using errcode = 'P0001';
  end if;

  if tg_table_name = 'item_posts' then
    select count(*), max(p.created_at)
      into v_count, v_last
      from public.item_posts p
     where p.user_id = v_actor
       and nullif(btrim(p.created_at), '')::timestamptz >= v_day_start;
  else
    select count(*), max(c.created_at)
      into v_count, v_last
      from public.comments c
     where c.user_id = v_actor
       and nullif(btrim(c.created_at), '')::timestamptz >= v_day_start;
  end if;

  if v_count >= v_limit then
    raise exception 'POST_LIMIT_REACHED: you have reached today''s limit of %', v_limit using errcode = 'P0001';
  end if;

  if v_cooldown > 0 and v_last is not null
     and nullif(btrim(v_last), '')::timestamptz > clock_timestamp() - make_interval(secs => v_cooldown) then
    raise exception 'POST_COOLDOWN: wait % seconds before posting again', v_cooldown using errcode = 'P0001';
  end if;

  return new;
end;
$$;
revoke all on function public.findback_enforce_interaction_limit() from public, anon, authenticated;
comment on function public.findback_enforce_interaction_limit() is
  'FindBack interaction limit guard (definer, internal trigger): samples the UTC day after the actor lock and uses wall-clock standing/cooldown decisions. Refuses with P0001 POST_LIMIT_REACHED/POST_NOT_AVAILABLE/POST_COOLDOWN.';

commit;
