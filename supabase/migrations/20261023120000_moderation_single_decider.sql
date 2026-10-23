-- 20261023120000_moderation_single_decider.sql
--
-- LIVE-PENDING. This migration has NOT been applied to the hosted project.
-- Behaviour is proven only by supabase/tests/verify_20261023120000_moderation_single_decider.sql
-- on a disposable PostgreSQL 17 chain (see supabase/tests/run-live.sh and the
-- local chain harness). Static guards prove the text, never the behaviour.
--
-- ADDITIVE: creates two internal tables, adds durable case columns to the
-- report receipt (with a trigger and a backfill), and replaces four functions
-- already shipped (unapplied) by 20261022173000. No DROP, no DELETE.
--
-- Owner policy (2026-10-23), implemented here rather than assumed:
--   * ONE moderator decides a case. That decision is FINAL.
--   * Its attribution is that moderator's user id; no second-moderator approval
--     exists and none may be added.
--   * The SAME decider may change their own decision.
--   * A consumer re-evaluation request (appeal against that decision, or
--     against the sanction that decision created) REOPENS the case, after which
--     any capability-holding moderator may decide it again as a new generation.
-- A report the decision did not already know also reopens the canonical case;
-- a comment report belongs to its post's case, just like a comment decision.
--
-- Without this file a different moderator with the relevant capability could
-- silently reverse a finalized verdict: the writer only re-checked capability,
-- and a closed case disappears from the queue, so nothing stopped a stale
-- console. The decision row below is the missing persistent ownership; the
-- advisory lock serialises two moderators acting at once.

-- ---------------------------------------------------------------------------
-- 1. Persistent single-decider ownership for one logical target.
-- ---------------------------------------------------------------------------

create table if not exists public.moderation_case_decisions (
  target_type          text not null check (target_type in ('POST', 'COMMENT', 'USER')),
  target_id            text not null check (target_id <> ''),
  -- Increments on every new decision for this target, so audit history and a
  -- reopened case can be told apart without guessing from timestamps.
  generation           integer not null default 1 check (generation >= 1),
  -- Deliberately NO foreign key: the owner of a final decision must not
  -- evaporate when the account is deleted, or the case would fall open to any
  -- moderator as a takeover. The id is immutable and remains the attribution.
  decider_user_id      text not null,
  decision_action      text not null check (decision_action in (
                         'NO_ACTION', 'PUBLISH', 'HIDE', 'REMOVE',
                         'WARN', 'PROBATION', 'RESTRICT_POSTING', 'SUSPEND', 'BAN'
                       )),
  audit_id             text not null references public.admin_audit_log(id),
  -- The sanction this decision created, when it created one. A SANCTION appeal
  -- finds the case through this link.
  sanction_id          text null,
  -- Every report this decision closed, and every report the case already knew
  -- when it decided. "Is there a new report?" is an identity question: a report
  -- whose id is not in known_report_ids arrived after the decision, regardless
  -- of clock resolution. No timestamp comparison is involved.
  closed_report_ids    text[] not null default '{}'::text[],
  known_report_ids     text[] not null default '{}'::text[],
  decided_at           text not null,
  -- Set by a consumer re-evaluation request; cleared by the next decision.
  reopened_at          text null,
  reopened_by_appeal_id text null references public.appeals(id) on delete set null,
  primary key (target_type, target_id)
);

create index if not exists moderation_case_decisions_reopened_idx
  on public.moderation_case_decisions (reopened_at)
  where reopened_at is not null;

alter table public.moderation_case_decisions enable row level security;
revoke all on table public.moderation_case_decisions from public, anon, authenticated;

comment on table public.moderation_case_decisions is
  'FindBack final-decision ownership (owner policy 2026-10-23): one decider per logical case is final and is attributed to that moderator; only the same decider may revise it, or any capability holder after a consumer re-evaluation request (action or sanction appeal) or a new report reopens the case. EVERY decision about a COMMENT — a dismissal just as much as a hide — is stored on its POST case, because the comment report and the post visibility are one atom; stored ids, not timestamps, decide what counts as a new report. The decider id has no foreign key and is never nullable, so a deleted account cannot hand the case to someone else. Internal: no client grant, no policy; readers are definer functions.';

-- ---------------------------------------------------------------------------
-- 1b. Durable canonical association.
--
-- The case a report belongs to must survive the live target row AND the
-- 90-day evidence snapshot. It is therefore stored on the receipt itself
-- (opaque ids, no FK, never erased) and every moderation audit gets an
-- internal link to its case, so a deleted comment's history still resolves.
-- ---------------------------------------------------------------------------

alter table public.content_reports add column if not exists case_type text;
alter table public.content_reports add column if not exists case_id text;

create or replace function public.findback_set_report_case()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post_id text;
begin
  if new.case_type is null or new.case_id is null then
    if new.target_type = 'COMMENT' then
      select c.post_id into v_post_id
        from public.comments c
       where c.id = new.target_id;
      if v_post_id is null then
        v_post_id := new.evidence_snapshot->>'post_id';
      end if;
      if v_post_id is null then
        new.case_type := 'COMMENT';
        new.case_id := new.target_id;
      else
        new.case_type := 'POST';
        new.case_id := v_post_id;
      end if;
    else
      new.case_type := new.target_type;
      new.case_id := new.target_id;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.findback_set_report_case() from public, anon, authenticated;

drop trigger if exists content_reports_set_case on public.content_reports;
create trigger content_reports_set_case
before insert on public.content_reports
for each row execute function public.findback_set_report_case();

-- Backfill existing receipts from the live comment, then its snapshot, then
-- the receipt's own subject. No content is copied.
update public.content_reports r
   set case_type = 'POST', case_id = c.post_id
  from public.comments c
 where r.target_type = 'COMMENT' and c.id = r.target_id
   and (r.case_type is null or r.case_id is null);

update public.content_reports r
   set case_type = 'POST', case_id = r.evidence_snapshot->>'post_id'
 where r.target_type = 'COMMENT'
   and (r.case_type is null or r.case_id is null)
   and coalesce(r.evidence_snapshot->>'post_id', '') <> '';

update public.content_reports
   set case_type = 'COMMENT', case_id = target_id
 where target_type = 'COMMENT' and (case_type is null or case_id is null);

update public.content_reports
   set case_type = target_type, case_id = target_id
 where case_type is null or case_id is null;

alter table public.content_reports alter column case_type set not null;
alter table public.content_reports alter column case_id set not null;
alter table public.content_reports
  add constraint content_reports_case_type_check
  check (case_type in ('POST', 'COMMENT', 'USER'));
alter table public.content_reports
  add constraint content_reports_case_id_check check (case_id <> '');

comment on column public.content_reports.case_type is
  'The canonical moderation case this receipt belongs to (a comment report belongs to its post). Opaque, no FK, never erased with the evidence snapshot.';
comment on column public.content_reports.case_id is
  'The canonical case id (a post id for a comment report). Opaque, no FK, never erased with the evidence snapshot.';

create table if not exists public.moderation_case_audits (
  audit_id   text primary key references public.admin_audit_log(id) on delete cascade,
  case_type  text not null check (case_type in ('POST', 'COMMENT', 'USER')),
  case_id    text not null check (case_id <> ''),
  created_at text not null
);

create index if not exists moderation_case_audits_case_idx
  on public.moderation_case_audits (case_type, case_id, created_at);

alter table public.moderation_case_audits enable row level security;
revoke all on table public.moderation_case_audits from public, anon, authenticated;

comment on table public.moderation_case_audits is
  'FindBack durable audit-to-case links (owner policy 2026-10-23): every moderation action records the canonical case it decided, so a proactive comment action survives comment deletion and a parent revision. Internal: no client grant, no policy; readers are definer functions.';

-- Link existing audits. A live comment's authoritative parent wins; a deleted
-- comment falls back to any retained receipt; only a genuinely unrecoverable
-- legacy action keeps its COMMENT key.
create or replace function public.findback_backfill_moderation_case_audits()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into public.moderation_case_audits (audit_id, case_type, case_id, created_at)
  select
    l.id,
    case
      when l.target_type <> 'COMMENT' then l.target_type
      when c.post_id is not null then 'POST'
      when r.case_id is not null then r.case_type
      else 'COMMENT'
    end,
    case
      when l.target_type <> 'COMMENT' then l.target_id
      else coalesce(c.post_id, r.case_id, l.target_id)
    end,
    l.created_at
  from public.admin_audit_log l
  left join public.comments c
    on l.target_type = 'COMMENT' and c.id = l.target_id
  left join lateral (
    select r.case_type, r.case_id
      from public.content_reports r
     where r.target_type = 'COMMENT' and r.target_id = l.target_id
     order by r.created_at desc
     limit 1
  ) r on true
  where l.target_type in ('POST', 'COMMENT', 'USER')
  on conflict (audit_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.findback_backfill_moderation_case_audits() from public, anon, authenticated;

select public.findback_backfill_moderation_case_audits();

-- ---------------------------------------------------------------------------
-- 2. The writer: single-decider finality, serialised per target.
-- ---------------------------------------------------------------------------

create or replace function public.findback_apply_moderation(
  p_target_type text,
  p_target_id text,
  p_action text,
  p_reason_code text,
  p_note text,
  p_sanction_kind text default null,
  p_sanction_ends_at text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_capability text;
  v_kind text;
  v_post_id text;
  v_owner_user_id text;
  v_previous_visibility text;
  v_new_visibility text;
  v_previous_state jsonb;
  v_new_state jsonb;
  v_sanction_id text;
  v_audit_id text := gen_random_uuid()::text;
  v_notify_user text;
  v_notify_post text;
  v_target_exists boolean;
  v_decision_action text;
  v_decision_decider text;
  v_decision_generation integer;
  v_decision_audit_id text;
  v_decision_reopened_at text;
  v_decision_known_ids text[];
  v_close_atom boolean := p_action in ('PUBLISH', 'HIDE', 'REMOVE');
  v_closed_report_ids text[] := '{}'::text[];
  v_known_report_ids text[] := '{}'::text[];
  v_case_open boolean;
  v_generation integer;
  v_case_type text;
  v_case_id text;
  v_sanction_for_decision text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- A2.2: each action in the closed D39 vocabulary is authorized by exactly
  -- ONE capability. An ADMIN passes every branch inside findback_can().
  if p_action is null or p_action not in (
       'NO_ACTION', 'PUBLISH', 'HIDE', 'REMOVE',
       'WARN', 'PROBATION', 'RESTRICT_POSTING', 'SUSPEND', 'BAN'
     ) then
    raise exception 'Unknown moderation action' using errcode = '22023';
  end if;

  v_capability := case p_action
    when 'NO_ACTION' then 'reports_review'
    when 'PUBLISH' then 'content_hide'
    when 'HIDE' then 'content_hide'
    when 'REMOVE' then 'content_remove'
    when 'WARN' then 'members_warn'
    when 'PROBATION' then 'members_warn'
    when 'RESTRICT_POSTING' then 'members_restrict'
    when 'SUSPEND' then 'members_suspend'
    when 'BAN' then 'members_suspend'
  end;

  if not public.findback_can(v_capability) then
    raise exception 'You may not perform this moderation action' using errcode = '42501';
  end if;

  if p_target_type is null or p_target_type not in ('POST', 'COMMENT', 'USER') then
    raise exception 'Unknown moderation target type' using errcode = '22023';
  end if;
  if p_target_id is null or btrim(p_target_id) = '' then
    raise exception 'A moderation target id is required' using errcode = '22023';
  end if;
  if p_reason_code is null or p_reason_code <> all (public.findback_report_reasons()) then
    raise exception 'Unknown moderation reason code' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    raise exception 'The moderator note is too long' using errcode = '22023';
  end if;
  if p_sanction_ends_at is not null
     and p_sanction_ends_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
    raise exception 'The sanction end instant is not an ISO-8601 UTC text value' using errcode = '22023';
  end if;

  -- Resolve the target and snapshot the state the action replaces, BEFORE any
  -- write. previous_state is the only record of what changed.
  if p_target_type = 'USER' then
    select true into v_target_exists from public.users u where u.id = p_target_id;
    if v_target_exists is not true then
      raise exception 'Moderation target unavailable' using errcode = 'P0002';
    end if;
    select jsonb_build_object(
             'active_sanctions',
             coalesce((
               select jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'ends_at', s.ends_at)
                                order by s.created_at desc)
                 from public.account_sanctions s
                where s.user_id = p_target_id
                  and s.active
             ), '[]'::jsonb)
           )
      into v_previous_state;
    v_owner_user_id := p_target_id;
    v_notify_user := p_target_id;
    v_notify_post := null;
  else
    if p_target_type = 'POST' then
      select p.id, p.user_id, p.moderation_visibility
        into v_post_id, v_owner_user_id, v_previous_visibility
        from public.item_posts p
       where p.id = p_target_id;
    else
      -- There is no per-comment moderation state in this contract. A content
      -- action on a COMMENT moderates the POST that carries it, exactly as the
      -- B2b inventory specifies; the audit target stays the comment.
      select c.post_id, c.user_id
        into v_post_id, v_owner_user_id
        from public.comments c
       where c.id = p_target_id;
      if v_post_id is not null then
        select p.user_id, p.moderation_visibility
          into v_owner_user_id, v_previous_visibility
          from public.item_posts p
         where p.id = v_post_id;
      end if;
    end if;

    if v_post_id is null then
      raise exception 'Moderation target unavailable' using errcode = 'P0002';
    end if;

    v_previous_state := jsonb_build_object('moderation_visibility', v_previous_visibility);
    v_notify_user := v_owner_user_id;
    v_notify_post := v_post_id;
  end if;

  -- The ownership key follows the state atom, not the action or the report
  -- row. EVERY decision about a COMMENT — a dismissal just as much as a hide —
  -- shares its POST's case. Without that, a moderator could dismiss a comment
  -- (COMMENT key) and a second moderator could then hide the same comment
  -- (POST key), or the reverse, reversing one verdict through a key change.
  if p_target_type = 'COMMENT' then
    v_case_type := 'POST';
    v_case_id := v_post_id;
  else
    v_case_type := p_target_type;
    v_case_id := p_target_id;
  end if;

  -- One writer at a time per case. Two moderators pressing the same stale
  -- sheet must not both read "no decision yet" and both write one.
  perform pg_advisory_xact_lock(hashtextextended('findback_moderation:' || v_case_type || ':' || v_case_id, 0));

  -- Read the current decision after taking the lock.
  select d.decision_action, d.decider_user_id, d.generation, d.audit_id,
         d.reopened_at, d.known_report_ids
    into v_decision_action, v_decision_decider, v_decision_generation,
         v_decision_audit_id, v_decision_reopened_at, v_decision_known_ids
    from public.moderation_case_decisions d
   where d.target_type = v_case_type
     and d.target_id = v_case_id;

  -- A case is open when there has never been a decision, when a consumer asked
  -- for re-evaluation, or when a report exists that the case did not already
  -- know at decision time. Identity, not a timestamp: a report written in the
  -- same millisecond is still new, and an older report the dismissal did not
  -- close is still old.
  v_case_open := v_decision_audit_id is null
    or v_decision_reopened_at is not null
    or exists (
         select 1 from public.content_reports r
          where r.status in ('OPEN', 'UNDER_REVIEW')
            and r.id <> all(coalesce(v_decision_known_ids, '{}'::text[]))
            and r.case_type = v_case_type
            and r.case_id = v_case_id
       );

  -- A final decision belongs to its decider. Another moderator may only act
  -- after the case is reopened. The decider id is immutable, so a deleted
  -- account does not turn a decided case into a free-for-all.
  if not v_case_open
     and v_decision_decider <> v_uid then
    raise exception 'MODERATION_DECISION_FINAL' using errcode = 'P0001';
  end if;

  v_generation := coalesce(v_decision_generation, 0) + 1;
  v_new_state := v_previous_state;

  -- Apply exactly ONE effect.
  if p_action in ('PUBLISH', 'HIDE', 'REMOVE') then
    if p_target_type = 'USER' then
      raise exception 'A content action needs a post or a comment target' using errcode = '22023';
    end if;
    if p_sanction_kind is not null or p_sanction_ends_at is not null then
      raise exception 'A content action takes no sanction parameters' using errcode = '22023';
    end if;

    v_new_visibility := case p_action
      when 'PUBLISH' then 'PUBLISHED'
      when 'HIDE' then 'HIDDEN'
      when 'REMOVE' then 'REMOVED'
    end;

    update public.item_posts p
       set moderation_visibility = v_new_visibility,
           updated_at = v_now
     where p.id = v_post_id;

    v_new_state := jsonb_build_object('moderation_visibility', v_new_visibility);
  elsif p_action in ('WARN', 'PROBATION', 'RESTRICT_POSTING', 'SUSPEND', 'BAN') then
    if p_target_type <> 'USER' then
      raise exception 'A member sanction needs a user target' using errcode = '22023';
    end if;
    if p_sanction_kind is not null and p_sanction_kind not in (
         'WARNING', 'PROBATION', 'RESTRICTED', 'SUSPENDED', 'BANNED'
       ) then
      raise exception 'Unknown sanction kind' using errcode = '22023';
    end if;

    -- The mapping this order proposes and the CONTRACT table fixes (A2.1).
    v_kind := case p_action
      when 'WARN' then 'WARNING'
      when 'PROBATION' then 'PROBATION'
      when 'RESTRICT_POSTING' then 'RESTRICTED'
      when 'SUSPEND' then 'SUSPENDED'
      when 'BAN' then 'BANNED'
    end;
    if p_sanction_kind is not null and p_sanction_kind <> v_kind then
      raise exception 'The sanction kind does not match the action' using errcode = '22023';
    end if;

    v_sanction_id := gen_random_uuid()::text;
    insert into public.account_sanctions (
      id, user_id, kind, starts_at, ends_at, reason_code, moderator_note,
      active, created_by, created_at, revoked_at, revoked_by
    ) values (
      v_sanction_id, p_target_id, v_kind, v_now, p_sanction_ends_at,
      p_reason_code, p_note, true, v_uid, v_now, null, null
    );

    v_new_state := jsonb_build_object(
      'sanction_id', v_sanction_id,
      'kind', v_kind,
      'ends_at', p_sanction_ends_at
    );
  else
    -- NO_ACTION: a legal action that writes only the audit row, so a moderator
    -- can dismiss without inventing a state change.
    if p_sanction_kind is not null or p_sanction_ends_at is not null then
      raise exception 'A dismissal takes no sanction parameters' using errcode = '22023';
    end if;
  end if;

  -- Bind the audit row to the decision generation it produced.
  v_new_state := v_new_state || jsonb_build_object('decision_generation', v_generation);

  -- Close the derived case: every report the case owns becomes ACTIONED, or
  -- DISMISSED for a NO_ACTION. The case owns the whole visibility atom, so a
  -- POST/COMMENT content action also closes the reports of the comments that
  -- belong to that post. This is the ONLY statement that touches a report row,
  -- and it never touches an evidence_* column. Its returning set is the
  -- decision's proof of what it closed.
  with closed as (
    update public.content_reports r
       set status = case when p_action = 'NO_ACTION' then 'DISMISSED' else 'ACTIONED' end,
           reviewed_by = v_uid,
           reviewed_at = v_now,
           updated_at = v_now,
           internal_note = p_note
     where r.status in ('OPEN', 'UNDER_REVIEW')
       and (
         (v_close_atom and r.case_type = v_case_type and r.case_id = v_case_id)
         or (not v_close_atom and r.target_type = p_target_type and r.target_id = p_target_id)
       )
     returning r.id
  ),
  known as (
    -- Captured in the SAME statement, hence the same snapshot, as the closing
    -- update. A report that commits after this statement is unknown, even if
    -- it commits before this transaction ends: it reopens the case rather than
    -- being silently marked as already considered.
    select r.id
      from public.content_reports r
     where r.case_type = v_case_type
       and r.case_id = v_case_id
  )
  select
    coalesce((select array_agg(id) from closed), '{}'::text[]),
    coalesce((select array_agg(id) from known), '{}'::text[])
  into v_closed_report_ids, v_known_report_ids;

  -- EXACTLY ONE audit row per action (D37). Written here rather than through
  -- findback_write_audit() because that helper returns void and the caller
  -- needs the audit id; the append-only invariant is unchanged (INSERT only).
  insert into public.admin_audit_log (
    id, actor_user_id, action, target_type, target_id, reason,
    previous_state, new_state, created_at
  ) values (
    v_audit_id, v_uid, p_action, p_target_type, p_target_id, p_reason_code,
    v_previous_state, v_new_state, v_now
  );

  -- Durable link from the audit row to the canonical case, so a proactive
  -- comment action still resolves after the comment row is gone and after the
  -- current decision has moved to the parent post.
  insert into public.moderation_case_audits (audit_id, case_type, case_id, created_at)
  values (v_audit_id, v_case_type, v_case_id, v_now)
  on conflict (audit_id) do nothing;

  -- Persist the owner of this case generation. A revision by the same decider
  -- replaces the row but increments the generation; a reopened case clears the
  -- reopen marker because it has just been decided again.
  v_sanction_for_decision := case
    when p_action in ('WARN', 'PROBATION', 'RESTRICT_POSTING', 'SUSPEND', 'BAN')
      then v_sanction_id
    else null
  end;

  insert into public.moderation_case_decisions (
    target_type, target_id, generation, decider_user_id, decision_action,
    audit_id, sanction_id, closed_report_ids, known_report_ids, decided_at,
    reopened_at, reopened_by_appeal_id
  ) values (
    v_case_type, v_case_id, v_generation, v_uid, p_action,
    v_audit_id, v_sanction_for_decision, v_closed_report_ids, v_known_report_ids,
    v_now, null, null
  )
  on conflict (target_type, target_id) do update
    set generation = excluded.generation,
        decider_user_id = excluded.decider_user_id,
        decision_action = excluded.decision_action,
        audit_id = excluded.audit_id,
        sanction_id = excluded.sanction_id,
        closed_report_ids = excluded.closed_report_ids,
        known_report_ids = excluded.known_report_ids,
        decided_at = excluded.decided_at,
        reopened_at = null,
        reopened_by_appeal_id = null;

  -- D13: the author learns of a decision through the existing inbox, with a
  -- NULL actor. A dismissal notifies nobody: it would disclose that a report
  -- existed.
  if p_action <> 'NO_ACTION' then
    perform public.findback_insert_notification(
      v_notify_user,
      null,
      'MODERATION',
      v_notify_post,
      null,
      public.findback_moderation_outcome_copy(p_action, p_reason_code)
    );
  end if;

  return v_audit_id;
end;
$$;

revoke all on function public.findback_apply_moderation(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.findback_apply_moderation(text, text, text, text, text, text, text) to authenticated;

comment on function public.findback_apply_moderation(text, text, text, text, text, text, text) is
  'FindBack moderation writer (definer, MC D39 + owner policy 2026-10-23): the ONE privileged writer. Each action maps to exactly one D1 capability (NO_ACTION→reports_review, PUBLISH/HIDE→content_hide, REMOVE→content_remove, WARN/PROBATION→members_warn, RESTRICT_POSTING→members_restrict, SUSPEND/BAN→members_suspend). Every decision about a COMMENT shares the POST case key (one visibility atom), while a dismissal closes only the reports of the submitted subject and a content action closes every report the atom owns. A final decision belongs to its decider: another moderator is refused with P0001 MODERATION_DECISION_FINAL until a consumer re-evaluation request (action or sanction appeal) or a report the decision did not already know reopens the case; the same decider may revise, which increments the decision generation. It writes one state change, appends exactly one audit row against the submitted target, updates the case owner, the sanction link and the known-report set, and emits one NULL-actor outcome notification.';

-- ---------------------------------------------------------------------------
-- 3. The queue: a reopened case is actionable again.
-- ---------------------------------------------------------------------------

create or replace function public.findback_moderation_queue(p_limit integer default 50)
returns table (
  target_type text,
  target_id text,
  report_count bigint,
  reasons text[],
  first_reported_at text,
  last_reported_at text,
  current_visibility text,
  target_exists boolean,
  status text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.findback_can('reports_review') then
    raise exception 'You may not read the moderation queue' using errcode = '42501';
  end if;

  return query
    with atom_reports as (
      -- Every report normalised to the case that actually owns it: a comment
      -- report belongs to its post's visibility atom, exactly like a comment
      -- decision does. Without this, a reopened comment-origin case would show
      -- zero reports and the moderator could not see what was reported.
      select
        r.case_type,
        r.case_id,
        r.reason,
        r.created_at,
        r.status
      from public.content_reports r
    ),
    report_cases as (
      select
        a.case_type as target_type,
        a.case_id as target_id,
        count(*) as report_count,
        array_agg(distinct a.reason order by a.reason) as reasons,
        min(a.created_at) as first_reported_at,
        max(a.created_at) as last_reported_at,
        case when bool_or(a.status = 'OPEN') then 'OPEN' else 'UNDER_REVIEW' end as status
      from atom_reports a
      where a.status in ('OPEN', 'UNDER_REVIEW')
        and a.case_id is not null
      group by a.case_type, a.case_id
    ),
    reopened_cases as (
      select
        d.target_type,
        d.target_id,
        (select count(*) from atom_reports a
          where a.case_type = d.target_type and a.case_id = d.target_id) as report_count,
        coalesce((
          select array_agg(distinct a.reason order by a.reason)
            from atom_reports a
           where a.case_type = d.target_type and a.case_id = d.target_id
        ), '{}'::text[]) as reasons,
        coalesce((
          select min(a.created_at) from atom_reports a
           where a.case_type = d.target_type and a.case_id = d.target_id
        ), d.decided_at) as first_reported_at,
        coalesce((
          select max(a.created_at) from atom_reports a
           where a.case_type = d.target_type and a.case_id = d.target_id
        ), d.reopened_at) as last_reported_at,
        'OPEN'::text as status
      from public.moderation_case_decisions d
      where d.reopened_at is not null
    ),
    cases as (
      select * from report_cases
      union all
      select * from reopened_cases x
       where not exists (
         select 1 from report_cases g
          where g.target_type = x.target_type and g.target_id = x.target_id
       )
    )
    select
      g.target_type,
      g.target_id,
      g.report_count,
      g.reasons,
      g.first_reported_at,
      g.last_reported_at,
      case
        when g.target_type = 'POST' then
          (select p.moderation_visibility from public.item_posts p where p.id = g.target_id)
        when g.target_type = 'COMMENT' then
          (select p.moderation_visibility
             from public.comments c
             join public.item_posts p on p.id = c.post_id
            where c.id = g.target_id)
        else null
      end as current_visibility,
      case
        when g.target_type = 'POST' then
          exists (select 1 from public.item_posts p where p.id = g.target_id)
        when g.target_type = 'COMMENT' then
          exists (select 1 from public.comments c where c.id = g.target_id)
        else
          exists (select 1 from public.users u where u.id = g.target_id)
      end as target_exists,
      g.status
    from cases g
    order by g.first_reported_at asc, g.target_type asc, g.target_id asc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke all on function public.findback_moderation_queue(integer) from public, anon;
grant execute on function public.findback_moderation_queue(integer) to authenticated;

comment on function public.findback_moderation_queue(integer) is
  'FindBack moderation queue (definer, reports_review): actionable report groups derived by the canonical case key — a comment report is listed under its post atom — plus a case a consumer asked to re-evaluate, which re-enters with status OPEN and its true report count, reasons and timestamps. No reporter identity, no decision owner and no snapshot: the queue is an index, the target reader is the detail.';

-- ---------------------------------------------------------------------------
-- 4. The target reader: says when a consumer asked for re-evaluation, and
--    what the current decision generation is, without projecting identities.
-- ---------------------------------------------------------------------------

create or replace function public.findback_moderation_target(
  p_target_type text,
  p_target_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_target jsonb;
  v_exists boolean := false;
  v_comment_post_id text;
  v_case_type text;
  v_case_id text;
begin
  if not public.findback_can('reports_review') then
    raise exception 'You may not read a moderation target' using errcode = '42501';
  end if;

  if p_target_type is null or p_target_type not in ('POST', 'COMMENT', 'USER') then
    raise exception 'Unknown moderation target type' using errcode = '22023';
  end if;
  if p_target_id is null or btrim(p_target_id) = '' then
    raise exception 'A moderation target id is required' using errcode = '22023';
  end if;

  if p_target_type = 'POST' then
    select jsonb_build_object(
             'target_type', 'POST',
             'id', p.id,
             'user_id', p.user_id,
             'type', p.type,
             'title', p.title,
             'description_excerpt', left(p.description, 500),
             'status', p.status,
             'moderation_visibility', p.moderation_visibility,
             'created_at', p.created_at
           )
      into v_target
      from public.item_posts p
     where p.id = p_target_id;
    v_exists := v_target is not null;
  elsif p_target_type = 'COMMENT' then
    select jsonb_build_object(
             'target_type', 'COMMENT',
             'id', c.id,
             'post_id', c.post_id,
             'user_id', c.user_id,
             'body_excerpt', left(c.body, 500),
             'post_moderation_visibility', p.moderation_visibility,
             'created_at', c.created_at
           )
      into v_target
      from public.comments c
      left join public.item_posts p on p.id = c.post_id
     where c.id = p_target_id;
    v_exists := v_target is not null;
    select c.post_id into v_comment_post_id
      from public.comments c
     where c.id = p_target_id;
  else
    select jsonb_build_object(
             'target_type', 'USER',
             'id', u.id,
             'username', u.username,
             'display_name', u.display_name,
             'avatar_url', u.avatar_url,
             'created_at', u.created_at
           )
      into v_target
      from public.users u
     where u.id = p_target_id;
    v_exists := v_target is not null;
  end if;

  -- Resolve ONE case identity. Every comment decision, dismissal or content,
  -- lives on its post's atom, so the reader must not choose the decision and
  -- the reopen request from two different keys. If the comment row is gone, the
  -- decision that audited this comment still identifies the case.
  if p_target_type = 'COMMENT' then
    if v_comment_post_id is null then
      -- The comment row is gone. Its retained receipt stores the canonical
      -- case durably; if no receipt exists (a proactive action), the audit
      -- link does. Neither depends on the expiring evidence snapshot.
      select r.case_type, r.case_id
        into v_case_type, v_case_id
        from public.content_reports r
       where r.target_type = 'COMMENT' and r.target_id = p_target_id
       order by r.created_at desc
       limit 1;

      if v_case_type is null then
        select ca.case_type, ca.case_id
          into v_case_type, v_case_id
          from public.moderation_case_audits ca
          join public.admin_audit_log l on l.id = ca.audit_id
         where l.target_type = 'COMMENT' and l.target_id = p_target_id
         order by l.created_at desc
         limit 1;
      end if;

      if v_case_type is null then
        v_case_type := 'COMMENT';
        v_case_id := p_target_id;
      end if;
    else
      v_case_type := 'POST';
      v_case_id := v_comment_post_id;
    end if;
  else
    v_case_type := p_target_type;
    v_case_id := p_target_id;
  end if;

  return jsonb_build_object(
    'target_type', p_target_type,
    'target_id', p_target_id,
    'target_exists', v_exists,
    -- The pointer-or-absence is reported HONESTLY: a deleted target is null,
    -- never a fabricated row (the amendment's B2b consequence).
    'target', case when v_exists then v_target else null end,
    -- One decision and one reopen request, both from the resolved case above.
    -- Moderation-target readers are privileged; the decider's id is still not
    -- projected, matching the prior contract.
    'decision', (
      select jsonb_build_object(
               'action', d.decision_action,
               'generation', d.generation,
               'decided_at', d.decided_at,
               'reopened_at', d.reopened_at
             )
        from public.moderation_case_decisions d
       where d.target_type = v_case_type
         and d.target_id = v_case_id
    ),
    'reopen', (
      select jsonb_build_object(
               'appeal_id', a.id,
               'message', a.message,
               'submitted_at', a.submitted_at
             )
        from public.moderation_case_decisions d
        join public.appeals a on a.id = d.reopened_by_appeal_id
       where d.target_type = v_case_type
         and d.target_id = v_case_id
         and d.reopened_at is not null
    ),
    -- The canonical case's evidence: a POST atom includes the reports on its
    -- comments, and a COMMENT target describes the same atom. Original report
    -- identity and snapshot filtering are preserved.
    'reports', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', r.id,
                 'reason', r.reason,
                 'detail', r.detail,
                 'status', r.status,
                 'created_at', r.created_at,
                 'reviewed_at', r.reviewed_at,
                 -- The read filter that bounds the cleanup lag: an expired or
                 -- erased snapshot is unavailable to moderators too (§13.11).
                 'evidence', case
                   when r.evidence_erased_at is not null then null
                   when r.evidence_expires_at <= v_now then null
                   else r.evidence_snapshot
                 end
               ) order by r.created_at desc, r.id desc
             )
        from public.content_reports r
       where r.case_type = v_case_type
         and r.case_id = v_case_id
    ), '[]'::jsonb),
    -- The canonical case's decision history, including a comment action that
    -- was audited against the comment while owning the post atom.
    'outcomes', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'action', l.action,
                 'reason', l.reason,
                 'created_at', l.created_at
               ) order by l.created_at desc, l.id desc
             )
        from public.admin_audit_log l
        join public.moderation_case_audits ca on ca.audit_id = l.id
       where ca.case_type = v_case_type
         and ca.case_id = v_case_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.findback_moderation_target(text, text) from public, anon;
grant execute on function public.findback_moderation_target(text, text) to authenticated;

comment on function public.findback_moderation_target(text, text) is
  'FindBack moderation target detail (definer, reports_review): the live target row (or an honest null after deletion), the canonical case it belongs to (a comment shares its post atom), every report and audit row of that case, its current decision generation and any open consumer re-evaluation request. Decision, reopen, reports and outcomes are selected from one durable case identity stored on the receipt and the audit links, so they survive comment deletion, parent revision and evidence erasure. Reporter identity and moderator identity are never projected; an expired or erased snapshot is returned as null.';

-- ---------------------------------------------------------------------------
-- 5. The consumer request: an appeal against the current decision reopens it.
-- ---------------------------------------------------------------------------

create or replace function public.findback_submit_appeal(
  p_target_kind text,
  p_target_id text,
  p_message text
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_message text := btrim(coalesce(p_message, ''));
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_owned boolean := false;
  v_sanction_id text;
  v_action_id text;
  v_case_type text;
  v_case_id text;
  v_id text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_target_kind is null or p_target_kind not in ('MODERATION_ACTION', 'SANCTION') then
    raise exception 'Unknown appeal target kind' using errcode = '22023';
  end if;
  if p_target_id is null or btrim(p_target_id) = '' then
    raise exception 'An appeal target id is required' using errcode = '22023';
  end if;
  if char_length(v_message) < 1 or char_length(v_message) > 2000 then
    raise exception 'An appeal message must be between 1 and 2000 characters' using errcode = '22023';
  end if;

  -- The ownership proof. Every failure — missing, someone else's, or a target
  -- whose live row is gone — is the SAME raise, so the RPC is not an oracle.
  if p_target_kind = 'SANCTION' then
    select s.id into v_sanction_id
      from public.account_sanctions s
     where s.id = p_target_id
       and s.user_id = v_uid;
    v_owned := v_sanction_id is not null;
  else
    select l.id
      into v_action_id
      from public.admin_audit_log l
     where l.id = p_target_id
       and (
         (l.target_type = 'USER' and l.target_id = v_uid)
         or (l.target_type = 'POST'
               and exists (select 1 from public.item_posts p
                            where p.id = l.target_id and p.user_id = v_uid))
         or (l.target_type = 'COMMENT'
               and exists (select 1 from public.comments c
                            where c.id = l.target_id and c.user_id = v_uid))
       );
    v_owned := v_action_id is not null;
  end if;

  if not v_owned then
    raise exception 'Appeal target unavailable' using errcode = 'P0002';
  end if;

  -- Resolve the current decision this request targets, then take the SAME case
  -- lock the writer takes, so a request and a decision cannot interleave. An
  -- appeal against an older decision finds no row and simply stays history.
  if p_target_kind = 'SANCTION' then
    select d.target_type, d.target_id
      into v_case_type, v_case_id
      from public.moderation_case_decisions d
     where d.sanction_id = p_target_id;
  else
    select d.target_type, d.target_id
      into v_case_type, v_case_id
      from public.moderation_case_decisions d
     where d.audit_id = p_target_id;
  end if;

  if v_case_type is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'findback_moderation:' || v_case_type || ':' || v_case_id, 0));
  end if;

  begin
    insert into public.appeals (
      id, appellant_user_id, subject_kind, subject_id,
      sanction_id, moderation_action_id, message, status,
      reviewer_note, submitted_at, resolved_at, resolved_by
    ) values (
      gen_random_uuid()::text, v_uid, p_target_kind, p_target_id,
      case when p_target_kind = 'SANCTION' then p_target_id end,
      case when p_target_kind = 'MODERATION_ACTION' then p_target_id end,
      v_message, 'SUBMITTED',
      null, v_now, null, null
    )
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'APPEAL_ALREADY_OPEN' using errcode = 'P0001';
  end;

  -- A re-evaluation request against the CURRENT decision or sanction reopens
  -- the case and returns it to the queue, whoever decided it. An appeal against
  -- an older decision is history and must not reopen a case that has since been
  -- decided again.
  if p_target_kind = 'MODERATION_ACTION' then
    update public.moderation_case_decisions d
       set reopened_at = v_now,
           reopened_by_appeal_id = v_id
     where d.audit_id = p_target_id
       and d.reopened_at is null;
  else
    update public.moderation_case_decisions d
       set reopened_at = v_now,
           reopened_by_appeal_id = v_id
     where d.sanction_id = p_target_id
       and d.reopened_at is null;
  end if;

  return v_id;
end;
$$;

revoke all on function public.findback_submit_appeal(text, text, text) from public, anon;
grant execute on function public.findback_submit_appeal(text, text, text) to authenticated;

comment on function public.findback_submit_appeal(text, text, text) is
  'FindBack appeal writer (definer, authenticated, MC D15 + owner policy 2026-10-23): the caller must own the referenced action or sanction; one open appeal per (subject_kind, subject_id); the refusal is one neutral P0002 and a duplicate is the stable APPEAL_ALREADY_OPEN. An appeal against the current moderation decision OR the current sanction REOPENS that case for re-evaluation (serialised with the writer); an older decision or sanction is not reopened. Emits no notification and no moderator signal.';
