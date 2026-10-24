-- F3 fix-forward: authoritative post-wait time for sanction/day decisions.
-- now() is transaction-start time; clock_timestamp() is wall-clock time.
-- Only these definer helpers change; no public/private writer semantics change.
begin;

-- 1. Effective sanction kind uses wall-clock time, not transaction start.
create or replace function public.findback_active_sanction_kind(p_user text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
begin
  select s.kind
    into v_kind
    from public.account_sanctions s
   where s.user_id = p_user
     and s.active
     and s.revoked_at is null
     and (nullif(btrim(s.starts_at), '') is null
          or nullif(btrim(s.starts_at), '')::timestamptz <= clock_timestamp())
     and (nullif(btrim(s.ends_at), '') is null
          or nullif(btrim(s.ends_at), '')::timestamptz > clock_timestamp())
   order by case s.kind
              when 'BANNED' then 4
              when 'SUSPENDED' then 3
              when 'RESTRICTED' then 2
              when 'PROBATION' then 1
              else 0
            end desc,
            s.created_at desc
   limit 1;

  return v_kind;
end;
$$;
revoke all on function public.findback_active_sanction_kind(text) from public, anon, authenticated;
comment on function public.findback_active_sanction_kind(text) is
  'FindBack effective sanction (definer, internal): the most serious ACTIVE sanction kind for a user, or NULL. Uses clock_timestamp() so sanctions starting or expiring during a lock wait are honored. Consumes account_sanctions; never writes one.';

-- 2. Reputation tier becomes volatile because it calls the volatile helper.
create or replace function public.findback_reputation_tier(p_user text)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_user text := btrim(coalesce(p_user, ''));
  v_kind text;
  v_count integer;
  v_avg numeric;
begin
  if v_user = '' then
    raise exception 'A user is required' using errcode = '22023';
  end if;

  v_kind := public.findback_active_sanction_kind(v_user);

  if v_kind in ('RESTRICTED', 'SUSPENDED', 'BANNED') then
    return 'NEW';
  end if;

  select count(*), coalesce(avg(r.score), 0)
    into v_count, v_avg
    from public.return_ratings r
   where r.rated_user_id = v_user;

  if v_count >= 5 and v_avg >= 4.0 then
    return 'TRUSTED';
  end if;

  if v_count >= 5 then
    return 'NORMAL';
  end if;

  return 'NEW';
end;
$$;
revoke all on function public.findback_reputation_tier(text) from public, anon;
grant execute on function public.findback_reputation_tier(text) to authenticated;
comment on function public.findback_reputation_tier(text) is
  'FindBack reputation tier (definer, volatile, DERIVED): NEW / NORMAL / TRUSTED from return_ratings plus the serious part of standing. Uses clock_timestamp() via the sanction helper. No stored score.';

-- 3. Interaction limit guard uses wall-clock time for day boundary and cooldown.
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
  v_day_start timestamptz := (date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc');
begin
  if v_actor = '' then
    return new;
  end if;

  v_self := coalesce(v_uid = v_actor, false);

  perform pg_advisory_xact_lock(hashtextextended('findback_public_admission:' || v_actor, 0));
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
  'FindBack interaction limit guard (definer, internal trigger): uses clock_timestamp() for sanction/day/cooldown decisions so sanctions starting or expiring during lock waits are honored. Refuses with P0001 POST_LIMIT_REACHED/POST_NOT_AVAILABLE/POST_COOLDOWN.';

-- 4. post_limit_for becomes volatile because it calls volatile helpers.
-- Fix F3-2: restore input normalization that was lost.
create or replace function public.findback_post_limit_for(p_user text)
returns table (limit_per_day integer, burst_cooldown_seconds integer)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_base integer := public.findback_base_interaction_limit();
  v_kind text;
  v_tier text;
begin
  p_user := btrim(coalesce(p_user, ''));
  if p_user = '' then
    raise exception 'A user is required' using errcode = '22023';
  end if;

  v_kind := public.findback_active_sanction_kind(p_user);

  if v_kind in ('RESTRICTED', 'SUSPENDED', 'BANNED') then
    return query select 0, 0;
    return;
  end if;

  v_tier := public.findback_reputation_tier(p_user);

  if v_kind = 'PROBATION' then
    return query select
      case v_tier when 'TRUSTED' then v_base * 2 when 'NORMAL' then v_base else 3 end,
      30;
    return;
  end if;

  if v_tier = 'TRUSTED' then
    return query select v_base * 2, 60;
    return;
  end if;

  if v_tier = 'NORMAL' then
    return query select v_base, 90;
    return;
  end if;

  return query select 3, 120;
end;
$$;
revoke all on function public.findback_post_limit_for(text) from public, anon, authenticated;

-- Fix F3-1: promote client-facing functions to volatile because they call
-- the volatile sanction helper and clock_timestamp().
create or replace function public.findback_standing(p_user text default null)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_subject text := btrim(coalesce(p_user, ''));
  v_kind text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_subject = '' then
    v_subject := v_uid;
  end if;

  if v_subject <> v_uid then
    raise exception 'Standing is visible only to the account it describes' using errcode = '42501';
  end if;

  v_kind := public.findback_active_sanction_kind(v_subject);

  return case v_kind
    when 'BANNED' then 'BANNED'
    when 'SUSPENDED' then 'SUSPENDED'
    when 'RESTRICTED' then 'RESTRICTED'
    when 'PROBATION' then 'PROBATION'
    else 'GOOD'
  end;
end;
$$;
revoke all on function public.findback_standing(text) from public, anon;
grant execute on function public.findback_standing(text) to authenticated;

create or replace function public.findback_post_limit()
returns table (limit_per_day integer, burst_cooldown_seconds integer)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return query select * from public.findback_post_limit_for(auth.uid()::text);
end;
$$;
revoke all on function public.findback_post_limit() from public, anon;
grant execute on function public.findback_post_limit() to authenticated;

commit;
