-- FindBack — public-only probation: 30 days by default, exactly 30 s spacing.
--
-- OWNER AMENDMENT 2026-10-24 (supersedes the 1/day + 120 s probation branch in
-- 20261023020000_trust_blocks_feedback_recovery.sql):
--
--   * PROBATION lasts 30 days unless a moderator sets an explicit end. The
--     server owns the default and the audit must record the SAME instant that
--     was persisted: the default is therefore computed in the public writer
--     before it delegates to the retained implementation. A BEFORE INSERT
--     trigger is deliberately NOT used - it would leave the audit's
--     `new_state.ends_at` saying null while the row said otherwise.
--   * A probation account keeps the ordinary TIER daily ceiling (NEW 3, NORMAL
--     base, TRUSTED 2 x base). There is no probation-only daily cap.
--   * Public interactions are spaced by exactly 30 s ACROSS actions: a new post,
--     a new comment (including the trusted notification reply), an added or
--     changed post/comment reaction, and a public rating. The interval replaces
--     every competing 60/90/120 s branch for a probation account.
--   * NOTHING private or safety-critical waits on that clock: private chat,
--     appeals, reporting, blocking, account access, deletion of one's own
--     content and every read are untouched. This file only adds a guard to the
--     five public write paths.
--   * The clock is server state, not a client timer and not a content row:
--     `public.public_action_admissions` survives content deletion, is written in
--     the SAME transaction as the mutation (rollback spends nothing), and is
--     serialized per actor with a transaction advisory lock. The timestamp is
--     sampled with `clock_timestamp()` AFTER that lock, so a waiting writer sees
--     the committed admission of the writer it waited for.
--
-- LIVE-PENDING: local PG17 behaviour only until the integrated candidate is
-- reviewed, applied to a quiescent window and re-proven hosted.

begin;

-- ---------------------------------------------------------------------------
-- 1. The admissions ledger.
--
-- Rate-limit accounting only. No body, no target id, no reason: an admission
-- answers "did this account spend its 30 s slot", nothing else. The row is
-- server-owned: RLS on, zero policies, zero grants.
-- ---------------------------------------------------------------------------
create table if not exists public.public_action_admissions (
  id          text primary key default gen_random_uuid()::text,
  user_id     text not null references public.users(id) on delete cascade,
  action_kind text not null,
  admitted_at timestamptz not null,
  created_at  timestamptz not null default clock_timestamp(),
  constraint public_action_admissions_kind_check check (action_kind in (
    'POST', 'COMMENT', 'POST_REACTION', 'COMMENT_REACTION', 'POST_RATING', 'RETURN_RATING'))
);

create index if not exists ix_public_action_admissions_user_time
  on public.public_action_admissions (user_id, admitted_at desc);

alter table public.public_action_admissions enable row level security;
revoke all on table public.public_action_admissions from public, anon, authenticated;

comment on table public.public_action_admissions is
  'FindBack public-interaction admission ledger (owner amendment 2026-10-24): one row per admitted public write by a PROBATION account. Server-owned rate-limit state, never a reputation or content record; bounded to 31 days per account by the spender.';

-- ---------------------------------------------------------------------------
-- 2. One derivation for every limit reader.
--
-- The client surface keeps `findback_post_limit()` (caller-scoped). The internal
-- `findback_post_limit_for(p_user)` exists so the BEFORE INSERT guard can read
-- the AUTHOR's limit after taking that author's lock, including the trusted
-- notification-reply path where there is no client subject.
-- ---------------------------------------------------------------------------
create or replace function public.findback_post_limit_for(p_user text)
returns table (limit_per_day integer, burst_cooldown_seconds integer)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_uid text := btrim(coalesce(p_user, ''));
  v_base integer := public.findback_base_interaction_limit();
  v_kind text;
  v_tier text;
begin
  if v_uid = '' then
    raise exception 'A user is required' using errcode = '22023';
  end if;

  v_kind := public.findback_active_sanction_kind(v_uid);

  if v_kind in ('RESTRICTED', 'SUSPENDED', 'BANNED') then
    return query select 0, 0;
    return;
  end if;

  v_tier := public.findback_reputation_tier(v_uid);

  -- PROBATION keeps the tier ceiling and reports the effective interval (30 s)
  -- for the neutral UI copy. The guard does NOT apply a second, content-time
  -- 30 s branch: the protected ledger is the only clock for these accounts.
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

create or replace function public.findback_post_limit()
returns table (limit_per_day integer, burst_cooldown_seconds integer)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return query select * from public.findback_post_limit_for(v_uid);
end;
$$;
revoke all on function public.findback_post_limit() from public, anon;
grant execute on function public.findback_post_limit() to authenticated;

comment on function public.findback_post_limit() is
  'FindBack interaction limit (definer, stable, DERIVED): (limit_per_day, burst_cooldown_seconds) from the caller''s standing and tier. 0 means every write is refused. PROBATION keeps the tier ceiling with a 30 s public-interaction interval.';

-- ---------------------------------------------------------------------------
-- 3. The public interaction clock.
--
-- All three functions take the same per-actor transaction lock. Advisory locks
-- re-enter, so a writer that already holds it (the BEFORE guard) pays nothing.
-- ---------------------------------------------------------------------------
create or replace function public.findback_public_admission_check(p_user text, p_kind text)
returns void
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_user text := btrim(coalesce(p_user, ''));
  v_last timestamptz;
  v_wait integer;
begin
  if v_user = '' then return; end if;
  if p_kind is null or p_kind not in
     ('POST', 'COMMENT', 'POST_REACTION', 'COMMENT_REACTION', 'POST_RATING', 'RETURN_RATING') then
    raise exception 'Unknown public action' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('findback_public_admission:' || v_user, 0));

  -- Standing is read AFTER serialization, so a sanction that committed while we
  -- waited is honoured and a sanction that expired cannot be bypassed.
  if public.findback_active_sanction_kind(v_user) is distinct from 'PROBATION' then
    return;
  end if;

  select a.admitted_at into v_last
    from public.public_action_admissions a
   where a.user_id = v_user
     and a.admitted_at > clock_timestamp() - interval '30 seconds'
   order by a.admitted_at desc
   limit 1;

  if v_last is not null then
    v_wait := greatest(1, ceil(extract(epoch from
      (v_last + interval '30 seconds' - clock_timestamp())))::integer);
    raise exception 'POST_COOLDOWN: wait % seconds before posting again', v_wait using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.findback_public_admission_check(text, text) from public, anon, authenticated;

create or replace function public.findback_public_admission_spend(p_user text, p_kind text)
returns void
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_user text := btrim(coalesce(p_user, ''));
begin
  if v_user = '' then return; end if;

  perform public.findback_public_admission_check(v_user, p_kind);

  if public.findback_active_sanction_kind(v_user) is distinct from 'PROBATION' then
    return;
  end if;

  -- Bounded retention: this account's rows never outlive 31 days.
  delete from public.public_action_admissions a
   where a.user_id = v_user
     and a.admitted_at < clock_timestamp() - interval '31 days';

  insert into public.public_action_admissions (user_id, action_kind, admitted_at)
  values (v_user, p_kind, clock_timestamp());
end;
$$;
revoke all on function public.findback_public_admission_spend(text, text) from public, anon, authenticated;

-- The client-facing admission seam. The reaction/rating writers below are
-- SECURITY DEFINER and charge through the internal spender directly; this one
-- exists so a client can spend its own reaction slot, derives its actor from
-- the session and takes no user parameter, so it can only ever charge itself.
create or replace function public.findback_admit_public_action(p_kind text)
returns void
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('POST_REACTION', 'COMMENT_REACTION') then
    raise exception 'Unknown client public action' using errcode = '22023';
  end if;
  perform public.findback_public_admission_spend(v_uid, p_kind);
end;
$$;
revoke all on function public.findback_admit_public_action(text) from public, anon;
grant execute on function public.findback_admit_public_action(text) to authenticated;

comment on function public.findback_admit_public_action(text) is
  'FindBack client admission seam (definer): derives its actor from the session and takes no user parameter, so a client can only ever charge itself. Restricted to reaction kinds so a client can never inflate or burn its POST/COMMENT daily ceiling through it; the only power it confers is spending one''s own 30 s slot early. The reaction and rating writers themselves are definers and spend through the internal function directly.';

-- ---------------------------------------------------------------------------
-- 3b. The reaction and rating tables stop being a second, ungated write path.
--
-- WHY (review F1): `authenticated` held INSERT/DELETE on all three tables with
-- live policies, so a client could write a reaction or a rating directly and
-- never touch the admission clock - and every such row still fires the reaction
-- notification trigger, so the bypass also produced notification churn. The
-- product's writers for these tables are the two reaction writers
-- (`findback_react_client`, `findback_react_comment_client`) and the two rating
-- writers (`findback_rate_return`, and `findback_rate_client` - the service-role
-- post-rating writer, which is NOT granted to `authenticated`: R3 F-2 found this
-- comment naming one rating writer while the code has two); the tables are
-- read-only to clients and those
-- writers are SECURITY DEFINER with explicit per-caller scoping, so the
-- RLS-scoped delete they relied on is replaced by a predicate that cannot widen
-- (see `and r.user_id = v_uid`). Being definers, they must also restate the read
-- visibility the old RLS supplied on the write policy (review R2-F1) - see
-- `findback_can_read_post_for` / `findback_can_read_comment_for` in each body.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.reactions from public, anon, authenticated;
revoke insert, update, delete on public.comment_reactions from public, anon, authenticated;
revoke insert, update, delete on public.ratings from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The BEFORE INSERT guard.
--
-- Provenance is unchanged for ordinary accounts: only an author's own row is
-- capped, and a non-probation row inserted by a trusted definer (notification
-- reply, repair) is exempt exactly as before. The two changes are:
--   * the author is serialized before standing/limit are read;
--   * a PROBATION author - including the trusted notification-reply path, where
--     the insert carries no client subject but the row still belongs to its
--     author - is spaced by the ledger instead of by content `created_at`.
-- ---------------------------------------------------------------------------
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
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
begin
  if v_actor = '' then
    return new;
  end if;

  -- `auth.uid()` is null for migrations, seeds and service-role work; a bare
  -- equality would make this NULL and fall through to the client cooldown path.
  v_self := coalesce(v_uid = v_actor, false);

  -- Serialize the AUTHOR before reading standing or limits, including the
  -- trusted notification-reply path where the insert has no client subject.
  perform pg_advisory_xact_lock(hashtextextended('findback_public_admission:' || v_actor, 0));
  v_probation := public.findback_active_sanction_kind(v_actor) = 'PROBATION';

  -- A PROBATION author's public activity is gated on every entrypoint: the row
  -- belongs to its author even when a trusted definer writes it (notification
  -- reply). Every other account keeps the accepted exemption for a row that is
  -- not the caller's own (migrations, seeds, service-role repair, moderation).
  if v_probation then
    select l.limit_per_day into v_limit from public.findback_post_limit_for(v_actor) l;
    if v_limit <= 0 then
      -- A zero limit is a STANDING fact, not a spent quota. It used to share the
      -- POST_LIMIT_REACHED word with the daily ceiling, which made the consumer
      -- copy ("that's all your replies for today") a lie for a restricted
      -- account. Two causes, two reasons (R3 F-1).
      raise exception 'POST_NOT_AVAILABLE: your account cannot post or comment right now' using errcode = 'P0001';
    end if;
    -- The ordinary ceiling is PER TABLE (3 posts and 3 comments for NEW), so the
    -- probation ceiling must be per table too; pooling them would silently halve
    -- it. Both the durable admissions and the surviving rows are counted and the
    -- larger wins: rows cover the pre-probation part of the day, admissions keep
    -- a deleted write from buying a fresh slot.
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
    -- Same distinction as the probation branch above: zero limit = standing,
    -- not a spent day (R3 F-1).
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
     and nullif(btrim(v_last), '')::timestamptz > now() - make_interval(secs => v_cooldown) then
    raise exception 'POST_COOLDOWN: wait % seconds before posting again', v_cooldown using errcode = 'P0001';
  end if;

  return new;
end;
$$;
revoke all on function public.findback_enforce_interaction_limit() from public, anon, authenticated;

comment on function public.findback_enforce_interaction_limit() is
  'FindBack interaction limit guard (definer, internal trigger): refuses an author''s own INSERT into item_posts/comments when the self-derived limit is spent (P0001 POST_LIMIT_REACHED, quota exhausted), when the standing makes the limit zero (P0001 POST_NOT_AVAILABLE, a standing fact and not a spent day - R3 F-1), or when the clock is live (P0001 POST_COOLDOWN). PROBATION accounts are spaced by public_action_admissions; every other account keeps the content-time cooldown.';

-- ---------------------------------------------------------------------------
-- 5. Spend the admission in the mutation's own transaction.
--
-- AFTER INSERT so a rolled-back or refused write spends nothing, and one
-- composite "comment + attachments" write spends exactly one COMMENT slot
-- because attachments are a different table.
-- ---------------------------------------------------------------------------
create or replace function public.findback_record_public_admission()
returns trigger
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  -- The row's author is the actor. The spender re-reads standing and no-ops for
  -- every non-probation author, so ordinary writes never create ledger rows.
  perform public.findback_public_admission_spend(new.user_id,
    case tg_table_name when 'item_posts' then 'POST' else 'COMMENT' end);
  return null;
end;
$$;
revoke all on function public.findback_record_public_admission() from public, anon, authenticated;

drop trigger if exists trg_findback_item_posts_public_admission on public.item_posts;
create trigger trg_findback_item_posts_public_admission
  after insert on public.item_posts
  for each row execute function public.findback_record_public_admission();

drop trigger if exists trg_findback_comments_public_admission on public.comments;
create trigger trg_findback_comments_public_admission
  after insert on public.comments
  for each row execute function public.findback_record_public_admission();

-- ---------------------------------------------------------------------------
-- 6. The writers that are not covered by the row guard.
--
-- A same-kind reaction or the same score is a NO-OP: no write, no clock, no
-- admission. A removal spends nothing. Only an added or changed value is a
-- public interaction.
-- ---------------------------------------------------------------------------
create or replace function public.findback_react_client(p_post_id text, p_type text)
returns table (
  post_id text,
  like_count bigint,
  dislike_count bigint,
  my_reaction text,
  reaction_counts jsonb
)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_available boolean;
  v_id text;
  v_previous text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_type is not null
     and p_type not in ('LIKE', 'DISLIKE', 'LOVE', 'HELPFUL', 'SUPPORT', 'WOW') then
    raise exception 'Invalid reaction type' using errcode = '22023';
  end if;
  -- Definer, so BOTH halves of the revoked `reactions_insert_own` policy are
  -- predicates here: the account scope (restated on the delete and the insert
  -- below) and the caller's read access to the target. Under its old
  -- `security invoker` body the second half was supplied by `item_posts` RLS;
  -- as a definer it must be asked explicitly, or a stranger could react to a
  -- HIDDEN or REMOVED post and fire its reaction notification and broadcast
  -- triggers. `findback_can_read_post_for` is the live reader predicate
  -- (`user_id = caller or moderation_visibility = 'PUBLISHED'`), so an
  -- unreadable post is refused exactly like an id that never existed and its
  -- counts are never returned — contract §13.1.
  v_available := public.findback_can_read_post_for(p_post_id, v_uid);
  if not v_available and p_type is not null then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;

  -- Serialize one actor's reaction on one target: an add and a removal racing
  -- each other must not both read "no row" and then lose one of the writes.
  perform pg_advisory_xact_lock(
    hashtextextended('findback_reaction:' || v_uid || ':' || p_post_id, 0));

  select r.type into v_previous from public.reactions r
   where r.id = md5('reaction|' || p_post_id || '|' || v_uid);

  if v_available and v_previous is distinct from p_type then
    if p_type is not null then
      perform public.findback_admit_public_action('POST_REACTION');
    end if;
    -- Definer now, so the caller scope is a predicate, not an RLS side effect.
    delete from public.reactions r where r.post_id = p_post_id and r.user_id = v_uid;
    if p_type is not null then
      v_id := md5('reaction|' || p_post_id || '|' || v_uid);
      insert into public.reactions (id, post_id, user_id, type, created_at)
      values (v_id, p_post_id, v_uid, p_type, v_now);
    end if;
  end if;

  -- Nothing is written on a target the caller cannot read, and its counts are
  -- not disclosed either: an unreadable post answers with the same empty shape
  -- a stranger gets for an id that never existed.
  if not v_available then
    return query select p_post_id, 0::bigint, 0::bigint, null::text, '{}'::jsonb;
  else
    return query
      select
        p_post_id,
        (select count(*) from public.reactions r
          where r.post_id = p_post_id and r.type = 'LIKE'),
        (select count(*) from public.reactions r
          where r.post_id = p_post_id and r.type = 'DISLIKE'),
        p_type,
        coalesce((
          select jsonb_object_agg(t.kind, t.n)
          from (
            select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                   count(*) as n
            from public.reactions r
            where r.post_id = p_post_id
            group by 1
          ) t
        ), '{}'::jsonb);
  end if;
end;
$$;
revoke all on function public.findback_react_client(text, text) from public, anon;
grant execute on function public.findback_react_client(text, text) to authenticated;

create or replace function public.findback_react_comment_client(p_comment_id text, p_type text)
returns table (comment_id text, my_reaction text, reaction_counts jsonb)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_id text;
  v_available boolean;
  v_previous text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_type is not null and p_type not in ('LIKE', 'DISLIKE', 'LOVE', 'HELPFUL', 'SUPPORT', 'WOW') then
    raise exception 'Invalid reaction type' using errcode = '22023';
  end if;
  v_available := public.findback_can_read_comment_for(p_comment_id, v_uid);
  if not v_available and p_type is not null then
    raise exception 'Comment not found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('findback_comment_reaction:' || v_uid || ':' || p_comment_id, 0));

  select cr.type into v_previous from public.comment_reactions cr
   where cr.comment_id = p_comment_id and cr.user_id = v_uid;

  if v_available and v_previous is distinct from p_type then
    if p_type is not null then
      perform public.findback_public_admission_spend(v_uid, 'COMMENT_REACTION');
    end if;
    delete from public.comment_reactions cr where cr.comment_id = p_comment_id and cr.user_id = v_uid;
    if p_type is not null then
      v_id := md5('comment_reaction|' || p_comment_id || '|' || v_uid);
      insert into public.comment_reactions (id, comment_id, user_id, type, created_at)
      values (v_id, p_comment_id, v_uid, p_type,
        to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;
  end if;

  if not v_available then
    return query select p_comment_id, null::text, '{}'::jsonb;
  else
    return query select p_comment_id, p_type, coalesce((
      select jsonb_object_agg(x.type, x.cnt) from (
        select cr.type, count(*)::integer cnt from public.comment_reactions cr
        where cr.comment_id = p_comment_id group by cr.type
      ) x), '{}'::jsonb);
  end if;
end;
$$;

create or replace function public.findback_rate_return(p_return_id text, p_score integer)
returns text
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_return_id text := btrim(coalesce(p_return_id, ''));
  v_return record;
  v_rated text;
  v_id text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'A rating must be between 1 and 5' using errcode = '22023';
  end if;

  select s.id, s.lost_owner_user_id, s.helper_user_id
    into v_return
    from public.successful_returns s
   where s.id = v_return_id;

  if not found then
    raise exception 'Recovery not found' using errcode = 'P0002';
  end if;

  if v_return.lost_owner_user_id is distinct from v_uid
     and v_return.helper_user_id is distinct from v_uid then
    raise exception 'Only the people in this recovery can rate it' using errcode = '42501';
  end if;

  if v_return.helper_user_id is null
     or v_return.lost_owner_user_id is null
     or v_return.helper_user_id = v_return.lost_owner_user_id then
    raise exception 'This recovery has no FindBack counterpart to rate' using errcode = '22023';
  end if;

  v_rated := case
    when v_uid = v_return.lost_owner_user_id then v_return.helper_user_id
    else v_return.lost_owner_user_id
  end;

  if v_rated = v_uid then
    raise exception 'You cannot rate yourself' using errcode = '22023';
  end if;

  -- A duplicate is refused BEFORE the clock is consulted: answering
  -- POST_COOLDOWN for "you already rated this" would be a false reason.
  if exists (select 1 from public.return_ratings rr
              where rr.successful_return_id = v_return.id
                and rr.rater_user_id = v_uid) then
    raise exception 'You have already rated this recovery' using errcode = '23505';
  end if;

  -- A new public rating is a public interaction.
  perform public.findback_public_admission_spend(v_uid, 'RETURN_RATING');

  insert into public.return_ratings (
    id, successful_return_id, rater_user_id, rated_user_id, score, created_at, updated_at
  ) values (
    gen_random_uuid()::text, v_return.id, v_uid, v_rated, p_score, v_now, v_now
  )
  returning id into v_id;

  return v_id;
exception
  when unique_violation then
    raise exception 'You have already rated this recovery' using errcode = '23505';
end;
$$;
revoke all on function public.findback_rate_return(text, integer) from public, anon;
grant execute on function public.findback_rate_return(text, integer) to authenticated;

-- Post ratings are service-role-only since 20261021162730 (no client write
-- path). The admission is kept so a future client grant cannot reopen an
-- ungated public write, and its actor is still the caller.
create or replace function public.findback_rate_client(p_post_id text, p_score integer)
returns table (
  post_id text,
  score integer,
  rating_avg numeric,
  rating_count bigint
)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_available boolean;
  v_id text;
  v_previous integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'Rating must be between 1 and 5' using errcode = '22023';
  end if;
  -- Definer, so the read visibility the old `security invoker` body inherited
  -- from `item_posts` RLS is asked explicitly (review R2-F1, same class as the
  -- reaction writer): an unreadable post is refused like an id that never
  -- existed, and its average/count are never disclosed. This RPC always writes
  -- a score, so there is no read-only path to answer with an empty shape.
  v_available := public.findback_can_read_post_for(p_post_id, v_uid);
  if not v_available then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('findback_rating:' || v_uid || ':' || p_post_id, 0));

  select ra.score into v_previous from public.ratings ra
   where ra.id = md5('rating|' || p_post_id || '|' || v_uid);

  if v_previous is distinct from p_score then
    perform public.findback_public_admission_spend(v_uid, 'POST_RATING');
    delete from public.ratings r where r.post_id = p_post_id and r.user_id = v_uid;
    v_id := md5('rating|' || p_post_id || '|' || v_uid);
    insert into public.ratings (id, post_id, user_id, score, created_at, updated_at)
    values (v_id, p_post_id, v_uid, p_score, v_now, v_now);
  end if;

  return query
    select
      p_post_id,
      p_score,
      (select round(avg(ra.score), 2) from public.ratings ra where ra.post_id = p_post_id),
      (select count(*) from public.ratings ra where ra.post_id = p_post_id);
end;
$$;
revoke all on function public.findback_rate_client(text, integer) from anon, authenticated, public;
grant execute on function public.findback_rate_client(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Server-owned 30-day probation default, audited exactly.
--
-- The public writer is the single place that can set the default BEFORE the
-- retained implementation runs, so the persisted `ends_at` and the audit's
-- `new_state.ends_at` are the same string. Everything else in this wrapper is
-- the accepted COMMENT atom, unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.findback_apply_moderation(
  p_target_type text,p_target_id text,p_action text,p_reason_code text,p_note text,
  p_sanction_kind text default null,p_sanction_ends_at text default null
)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
  v_uid text:=auth.uid()::text;
  v_now text;
  v_author text;
  v_post text;
  v_previous text;
  v_next text;
  v_audit text:=gen_random_uuid()::text;
  v_decision public.moderation_case_decisions%rowtype;
  v_closed text[];
  v_known text[];
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_target_type is null or p_target_type not in ('POST','COMMENT','USER') then
    raise exception 'Unknown moderation target type' using errcode='22023';
  end if;
  if p_target_id is null or btrim(p_target_id)='' then
    raise exception 'A moderation target id is required' using errcode='22023';
  end if;
  if p_target_type='USER' and p_action='PROBATION' and p_sanction_ends_at is null then
    -- Owner amendment 2026-10-24: probation lasts 30 days by default. Derived
    -- here, before the retained writer snapshots state, so the row and its audit
    -- agree exactly; no trigger may rewrite the instant afterwards.
    p_sanction_ends_at:=to_char((clock_timestamp()+interval '30 days') at time zone 'utc',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  end if;
  if p_target_type<>'COMMENT' then
    perform pg_advisory_xact_lock(hashtextextended('findback_moderation:'||p_target_type||':'||p_target_id,0));
    if p_target_type='POST' then perform 1 from public.item_posts p where p.id=p_target_id for update;
    else perform 1 from public.users u where u.id=p_target_id for update; end if;
    return public.findback_apply_post_user_moderation_internal(
      p_target_type,p_target_id,p_action,p_reason_code,p_note,p_sanction_kind,p_sanction_ends_at);
  end if;
  if p_action is null or p_action not in ('NO_ACTION','PUBLISH','HIDE','REMOVE') then
    raise exception 'This action requires a post or comment target' using errcode='22023';
  end if;
  if p_sanction_kind is not null or p_sanction_ends_at is not null then
    raise exception 'Account sanctions require a user target' using errcode='22023';
  end if;
  if p_reason_code is null or p_reason_code<>all(public.findback_report_reasons()) then
    raise exception 'Unknown moderation reason' using errcode='22023';
  end if;
  if char_length(coalesce(p_note,''))>2000 then
    raise exception 'Moderator note is too long' using errcode='22023';
  end if;
  if not public.findback_can(case p_action when 'NO_ACTION' then 'reports_review'
       when 'REMOVE' then 'content_remove' else 'content_hide' end) then
    raise exception 'You may not perform this moderation action' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('findback_moderation:COMMENT:'||p_target_id,0));
  select c.user_id,c.moderation_visibility,c.post_id into v_author,v_previous,v_post
    from public.comments c where c.id=p_target_id for update;
  if not found and p_action<>'NO_ACTION' then
    raise exception 'Moderation target unavailable' using errcode='P0002';
  end if;
  select d.* into v_decision from public.moderation_case_decisions d
    where d.target_type='COMMENT' and d.target_id=p_target_id;
  if v_decision.decider_user_id is not null and v_decision.decider_user_id<>v_uid
     and v_decision.reopened_at is null and not exists(
       select 1 from public.content_reports r where r.case_type='COMMENT' and r.case_id=p_target_id
         and r.status in ('OPEN','UNDER_REVIEW') and not(r.id=any(v_decision.known_report_ids))) then
    raise exception 'MODERATION_DECISION_FINAL' using errcode='P0001';
  end if;
  v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_next:=case p_action when 'PUBLISH' then 'PUBLISHED' when 'HIDE' then 'HIDDEN'
    when 'REMOVE' then 'REMOVED' else v_previous end;
  if p_action<>'NO_ACTION' then
    update public.comments c set moderation_visibility=v_next where c.id=p_target_id;
    if not found then raise exception 'Moderation target unavailable' using errcode='P0002'; end if;
  end if;
  insert into public.admin_audit_log(id,actor_user_id,action,target_type,target_id,
    reason,previous_state,new_state,created_at)
  values(v_audit,v_uid,p_action,'COMMENT',p_target_id,p_reason_code,
    case when v_previous is null then null else jsonb_build_object('moderation_visibility',v_previous) end,
    case when p_action='NO_ACTION' then jsonb_build_object('action','NO_ACTION','decision_generation',coalesce(v_decision.generation,0)+1)
      else jsonb_build_object('moderation_visibility',v_next,'decision_generation',coalesce(v_decision.generation,0)+1) end,v_now);
  insert into public.moderation_case_audits(audit_id,case_type,case_id,created_at)
    values(v_audit,'COMMENT',p_target_id,v_now);
  with closed as(
    update public.content_reports r set status=case when p_action='NO_ACTION' then 'DISMISSED' else 'ACTIONED' end,
      reviewed_at=v_now,reviewed_by=v_uid,updated_at=v_now,internal_note=nullif(btrim(coalesce(p_note,'')),'')
    where r.case_type='COMMENT' and r.case_id=p_target_id and r.status in ('OPEN','UNDER_REVIEW') returning r.id
  ) select coalesce(array_agg(id order by id),'{}'::text[]) into v_closed from closed;
  select coalesce(array_agg(r.id order by r.id),'{}'::text[]) into v_known from public.content_reports r
    where r.case_type='COMMENT' and r.case_id=p_target_id;
  insert into public.moderation_case_decisions(target_type,target_id,generation,decider_user_id,
    decision_action,audit_id,sanction_id,closed_report_ids,known_report_ids,decided_at,reopened_at,reopened_by_appeal_id)
  values('COMMENT',p_target_id,coalesce(v_decision.generation,0)+1,v_uid,p_action,v_audit,null,v_closed,v_known,v_now,null,null)
  on conflict(target_type,target_id) do update set generation=excluded.generation,decider_user_id=excluded.decider_user_id,
    decision_action=excluded.decision_action,audit_id=excluded.audit_id,sanction_id=null,
    closed_report_ids=excluded.closed_report_ids,known_report_ids=excluded.known_report_ids,
    decided_at=excluded.decided_at,reopened_at=null,reopened_by_appeal_id=null;
  if p_action<>'NO_ACTION' and v_author is not null then
    perform public.findback_insert_notification(v_author,null,'MODERATION',null,null,
      public.findback_moderation_outcome_copy(p_action,p_reason_code));
  end if;
  if v_post is not null then
    perform realtime.send(jsonb_build_object('postId',v_post,'entity','comment','invalidate',true,'op','MODERATION'),
      'comment:invalidate','post:'||v_post,true);
  end if;
  return v_audit;
end $$;
revoke all on function public.findback_apply_moderation(text,text,text,text,text,text,text) from public,anon;
grant execute on function public.findback_apply_moderation(text,text,text,text,text,text,text) to authenticated;

comment on function public.findback_apply_moderation(text,text,text,text,text,text,text) is
  'FindBack single moderation writer (definer): COMMENT is its own atom; POST/USER delegate to the retained implementation. A PROBATION sanction with no explicit end receives the server 30-day default before delegation, so the persisted ends_at and the audit new_state are identical.';

commit;
