-- ===========================================================================
-- FindBack — CF-060 B2a reports + B2b moderation + B2c appeals
-- ===========================================================================
--
-- LIVE-PENDING. This file has NOT been applied to the hosted project and no
-- device/consumer proof exists. It is authored for independent review.
--
-- ADDITIVE ONLY. It creates new objects, re-creates exactly one shipped
-- function and one shipped constraint (both named in the guarded-drop
-- inventory below, both replaced in place), and adds one index to the existing
-- audit table. It drops no table, no column and no function, rewrites no row,
-- and backfills nothing.
--
-- The accepted contract this implements:
--   MODERATION-CONTRACT-DECISION.md §2 (C1, D1–D7), §3 (C2, D8–D15),
--   §7 (C6, D34–D39), §13.7 (the picker gate, which stays default-OFF),
--   §13.11 (the owner's 90-day evidence expiry) and §13.12 (O7).
--   The role/capability layer is already applied (D1-ROLES,
--   20261022143000_roles_capabilities_invitations.sql) and is REUSED here:
--   findback_can(p_capability) is the one authorization predicate, and
--   admin_audit_log is the one append-only audit table. Neither is redefined.
--   CONTRACT-ROLES-ADMIN-2026-10-22.md A2.1/A2.2/A2.6 supplies the
--   action → capability map this file enforces.
--
-- THE MEASURED CORRECTIONS (B2-PREFLIGHT-CORRECTIONS-2026-10-21.md §2–§4,
-- B2-TARGET-IDENTITY-AMENDMENT-DRAFT.md), all of which this file implements
-- rather than the historical D3/D6 shapes:
--
--   1. D3's exact one-live-pointer CHECK is REPLACED, not weakened. A foreign
--      key `on delete set null` performs an UPDATE, and PostgreSQL re-evaluates
--      row CHECKs on that UPDATE: the exact D3 disjunction made deleting a
--      reported POST/COMMENT/USER fail 23514. The replacement CHECK lets the
--      pointer for the row's own target type be OCCUPIED (and equal to the
--      logical key) or NULLED BY THE FK ONLY; the other two slots are always
--      null. A trigger restores the half a row CHECK cannot express: INSERT
--      requires the live pointer, and UPDATE may never change the logical
--      identity, repoint a pointer, or resurrect a nulled one.
--   2. D6's coalesced-pointer unique index is REPLACED by the plain three-column
--      key (reporter_user_id, target_type, target_id). The coalesced form mapped
--      two distinct deleted targets of one reporter onto ('','') and failed
--      23505 on the second deletion.
--   3. B2c's premise that an appeal CHECK is not re-evaluated is measurably
--      false: deleting a sanctioned account cascades through account_sanctions
--      and re-evaluates the appeal row. appeals therefore carries the same
--      immutable logical pair (subject_kind, subject_id) beside its nullable
--      live pointers, and one open appeal per (subject_kind, subject_id).
--   4. The writer validates the target and returns the duplicate receipt
--      BEFORE it counts the rate limit, and serializes per reporter, so a
--      duplicate retry never becomes an error and the limit cannot be raced.
--
-- GUARDED-DROP INVENTORY (all of them `if exists`, none CASCADE):
--   * function public.findback_insert_notification(text,text,text,text,text,text,text)
--       — re-created ONLY so a MODERATION row may carry a NULL actor (D13:
--       the copy may not name the moderator). Same 7-argument signature; the
--       default keeps every 6-argument caller working.
--   * constraint public.notifications_type_check — re-created with the added
--       'MODERATION' value.
--   * trigger content_reports_identity_guard / content_reports_evidence_guard
--   * trigger appeals_identity_guard
--   * no view, no policy and no grant is dropped or narrowed here.
--
-- NOTHING IS GRANTED BACK TO A CONSUMER ROLE ON A MODERATION TABLE. Every new
-- table is `revoke all ... from public, anon, authenticated` with RLS enabled
-- and ZERO policies; Supabase's default ACL grants `authenticated` table rights
-- on every new table, so "no policy" is NOT "no access" (ACL-CLOSURE.md:52-58,
-- MC D36). The consumer receipt is a definer RPC, not a table grant, which is
-- STRICTER than D4's five-column grant: no column of content_reports is
-- readable by any client role. admin_audit_log is append-only and gets no
-- UPDATE/DELETE grant.
--
-- ONE DELIBERATE CONTRACT-SHAPE DEVIATION, stated here and in the handoff:
-- D4's receipt was a column grant plus an RLS policy. The brief for this lane
-- requires "definer queue/receipt readers" and "the consumer's own report
-- submission + receipt must work for an ordinary user while the moderation
-- tables stay ungranted"; findback_my_reports() therefore returns the same
-- five columns as a definer reader and the table carries no grant at all.
--
-- OPEN PRECONDITION, NOT CLOSED BY THIS FILE (release blocker, not a defect of
-- these objects): B2a's moderation-privacy precondition (§0.2 of
-- WORK-ORDER-CF060-B2a-REPORTS.md, WORK_QUEUE Residual 1/12) is not applied in
-- the tree this file sits on. public.item_posts still grants
-- select (moderation_visibility) to authenticated and its RLS SELECT policy is
-- `using (true)`. This file introduces the FIRST writer of that column, so
-- applying it before the precondition moves the existing oracle from "reads a
-- constant" to "reads a real moderation state". The precondition (revoke the
-- column, move the atom into the item_posts SELECT policy, recreate
-- findback_visible_posts with an explicit projection) is owned by the
-- coordinator and must land before this file is applied.
--
-- WHAT THIS FILE ADDS
--   B2a  public.content_reports (+ its immutable identity and evidence guards,
--        the four indexes, the target-availability writer, the server-built
--        evidence snapshot, the 90-day expiry sweep and the receipt reader).
--   B2b  public.account_sanctions, the queue/target readers, the owner-scoped
--        state and outcome readers, the outcome notification, and the ONE
--        privileged writer public.findback_apply_moderation(...).
--   B2c  public.appeals (+ its identity guard and one-open-per-subject index),
--        public.findback_submit_appeal(...) and the uncalled resolver copy.
--
-- DELIBERATELY UNREACHABLE (CF-080 owns them; nothing here writes them):
--   * appeals.status 'UNDER_REVIEW' / 'RESOLVED' have NO writer;
--   * findback_resolve_appeal / an appeals queue DO NOT EXIST;
--   * findback_appeal_outcome_copy has NO call site.
--
-- Verification: supabase/tests/verify_20261022173000_moderation_reports_sanctions_appeals.sql
-- (the new client-callable definers are also added, in sort order, to the
-- pinned CLIENT_REACHABLE_DEFINERS set in supabase/tests/migration_parity.test.mjs,
-- which is a deliberate security-model change: each of them is role- or
-- capability-guarded at call time.)

begin;

-- ---------------------------------------------------------------------------
-- 1. The reason vocabulary (D2: a CHECK, never a lookup table). It is written
--    once as an immutable function so the writer, the audit reason and the
--    client can agree, and it is spelled out again in the table CHECK so a
--    `create or replace` of the function can never widen stored rows.
-- ---------------------------------------------------------------------------

create or replace function public.findback_report_reasons()
returns text[]
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select array[
    'SCAM_OR_MISLEADING',
    'SPAM_OR_DUPLICATE',
    'HARASSMENT',
    'INAPPROPRIATE_CONTENT',
    'PRIVATE_INFORMATION',
    'SUSPECTED_STOLEN_OR_ILLEGAL',
    'OTHER'
  ];
$$;

revoke all on function public.findback_report_reasons() from public, anon;
grant execute on function public.findback_report_reasons() to authenticated;

comment on function public.findback_report_reasons() is
  'FindBack report reasons (MC D2): the closed seven-value vocabulary. A CHECK in the table spells it out too, so this function can never quietly widen stored rows.';

-- ---------------------------------------------------------------------------
-- 2. public.content_reports (MC D1 + §13.11 + the measured target identity).
-- ---------------------------------------------------------------------------

create table if not exists public.content_reports (
  id                  text primary key default gen_random_uuid()::text,
  -- D7: the report row survives the reporter; only the identity is unlinked.
  reporter_user_id    text null references public.users(id) on delete set null,
  target_type         text not null check (target_type in ('POST', 'COMMENT', 'USER')),
  -- The amendment's immutable opaque logical key: no FK, no second evidence
  -- copy, never a client projection. It is the id the reporter submitted.
  target_id           text not null check (target_id <> ''),
  -- D7 live pointers: a moderator's "target if it still exists". The FK may
  -- null them; nothing else may.
  target_post_id      text null references public.item_posts(id) on delete set null,
  target_comment_id   text null references public.comments(id) on delete set null,
  target_user_id      text null references public.users(id) on delete set null,
  reason              text not null check (reason in (
                        'SCAM_OR_MISLEADING',
                        'SPAM_OR_DUPLICATE',
                        'HARASSMENT',
                        'INAPPROPRIATE_CONTENT',
                        'PRIVATE_INFORMATION',
                        'SUSPECTED_STOLEN_OR_ILLEGAL',
                        'OTHER'
                      )),
  detail              text null check (detail is null or char_length(detail) <= 2000),
  -- D5: built server-side from live rows; never accepted from a caller.
  evidence_snapshot   jsonb not null,
  -- §13.11: an immutable, server-assigned capture instant and an explicit
  -- expiry instant. Neither a duplicate, an edit, nor a deletion moves them.
  evidence_captured_at text not null,
  evidence_expires_at  text not null,
  evidence_erased_at   text null,
  status              text not null default 'OPEN'
                        check (status in ('OPEN', 'UNDER_REVIEW', 'ACTIONED', 'DISMISSED')),
  reviewed_by         text null references public.users(id) on delete set null,
  internal_note       text null,
  reviewed_at         text null,
  created_at          text not null,
  updated_at          text not null,
  -- THE REPLACEMENT CHECK (measured correction 1). The pointer slot for the
  -- row's own target type may be occupied — and then it equals the logical key
  -- — or it may be NULLED BY THE FK. The other two slots are always null.
  constraint content_reports_target_shape_check check (
    (target_type = 'POST'
       and (target_post_id is null or target_post_id = target_id)
       and target_comment_id is null
       and target_user_id is null)
    or (target_type = 'COMMENT'
       and (target_comment_id is null or target_comment_id = target_id)
       and target_post_id is null
       and target_user_id is null)
    or (target_type = 'USER'
       and (target_user_id is null or target_user_id = target_id)
       and target_post_id is null
       and target_comment_id is null)
  )
);

-- The replacement dedupe key (measured correction 2): a plain three-column
-- key on the immutable logical identity survives live-target unlinkage, so two
-- distinct deleted targets of one reporter stay two receipts.
create unique index if not exists content_reports_dedupe_key
  on public.content_reports (reporter_user_id, target_type, target_id);

-- The rate query (D6).
create index if not exists content_reports_reporter_created_idx
  on public.content_reports (reporter_user_id, created_at desc);

-- The expiry sweep (§13.11).
create index if not exists content_reports_expiry_idx
  on public.content_reports (evidence_expires_at) where evidence_erased_at is null;

-- The queue's own grouping filter (D38).
create index if not exists content_reports_queue_idx
  on public.content_reports (status, target_type, target_id);

comment on table public.content_reports is
  'FindBack content reports (MC D1, amended for the measured D3/D6/D7 defects). The row is the accountability receipt and survives both the reporter and the target; the LIVE pointer columns may be nulled by their FKs, while target_id (opaque, no FK) and the bounded server-captured evidence snapshot survive until the owner-approved 90-day expiry erases them (§13.11). evidence_snapshot is moderator-only and is never readable by a client role.';
comment on column public.content_reports.target_id is
  'Immutable opaque logical target key (the id the reporter submitted). It is NOT a public projection, NOT target text and NOT a second evidence copy; B2b groups cases by (target_type, target_id).';
comment on column public.content_reports.evidence_snapshot is
  'Moderator-only bounded evidence captured server-side at submit time (MC D5). Erased to {} 90 days after evidence_captured_at, even if the case is still open (§13.11).';
comment on constraint content_reports_target_shape_check on public.content_reports is
  'Measured correction: the pointer for the row''s own target type may be occupied (equal to target_id) or nulled by its FK. Replaces D3''s exact one-live-pointer CHECK, which made target deletion fail 23514.';

-- ---------------------------------------------------------------------------
-- 3. The report guards.
--
--    Two BEFORE triggers, deliberately separate and deliberately ordered by
--    name (PostgreSQL fires same-timing triggers in name order):
--      content_reports_evidence_guard  (e) — the evidence may not move;
--      content_reports_identity_guard  (i) — the identity may not be rewritten.
--    They guard disjoint column sets, so the order is readable, not load-bearing;
--    the SQL verifier proves both fire on one UPDATE.
-- ---------------------------------------------------------------------------

-- 3a. Evidence immutability (§13.11): the snapshot, its capture instant, its
--     expiry instant and the reporter's free text may change exactly once —
--     the erasure transition — and only with an erasure stamp at or after the
--     row's own expiry instant. The stamp is compared to the expiry, not to
--     now(), so the single writer's p_now seam and production now() follow
--     exactly one rule (a bare now() here would have made the sweep's seam
--     unusable: the writer stamps +90 d, the guard would still read today).
create or replace function public.findback_guard_report_evidence_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- evidence_erased_at is set at most once, and never cleared.
  if new.evidence_erased_at is distinct from old.evidence_erased_at
     and not (old.evidence_erased_at is null and new.evidence_erased_at is not null) then
    raise exception 'A report evidence erasure cannot be moved or undone' using errcode = '42501';
  end if;

  if new.evidence_snapshot is distinct from old.evidence_snapshot
     or new.evidence_captured_at is distinct from old.evidence_captured_at
     or new.evidence_expires_at is distinct from old.evidence_expires_at
     or new.detail is distinct from old.detail then
    -- The one permitted transition: physical erasure at/after expiry.
    if not (
         old.evidence_erased_at is null
         and new.evidence_erased_at is not null
         and new.evidence_erased_at >= old.evidence_expires_at
         and new.evidence_snapshot = '{}'::jsonb
         and new.evidence_captured_at = old.evidence_captured_at
         and new.evidence_expires_at = old.evidence_expires_at
         and new.detail is null
       ) then
      raise exception 'A report evidence snapshot is immutable until it expires' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.findback_guard_report_evidence_immutable() from public, anon, authenticated;

comment on function public.findback_guard_report_evidence_immutable() is
  'FindBack report evidence guard (definer, internal): the bounded evidence, its capture instant, its expiry instant and the reporter detail may change only through the single physical-erasure transition, whose stamp must be at or after the row''s own expiry instant (§13.11).';

-- 3b. Target identity (§2.3 of the amendment): INSERT requires the live
--     pointer the relaxed CHECK can no longer demand; UPDATE may not change the
--     logical key or type, repoint a pointer, or resurrect a nulled one.
create or replace function public.findback_guard_report_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.target_type = 'POST' and new.target_post_id is null then
      raise exception 'A POST report needs its live target pointer' using errcode = '23514';
    end if;
    if new.target_type = 'COMMENT' and new.target_comment_id is null then
      raise exception 'A COMMENT report needs its live target pointer' using errcode = '23514';
    end if;
    if new.target_type = 'USER' and new.target_user_id is null then
      raise exception 'A USER report needs its live target pointer' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.target_type is distinct from old.target_type
     or new.target_id is distinct from old.target_id then
    raise exception 'A report target identity is immutable' using errcode = '42501';
  end if;

  -- The only pointer transition the schema permits is nonnull -> null (the
  -- FK). A non-null new value that differs is a repoint or a resurrection.
  if new.target_post_id is distinct from old.target_post_id
     and new.target_post_id is not null then
    raise exception 'A report target pointer cannot be set or repointed' using errcode = '42501';
  end if;
  if new.target_comment_id is distinct from old.target_comment_id
     and new.target_comment_id is not null then
    raise exception 'A report target pointer cannot be set or repointed' using errcode = '42501';
  end if;
  if new.target_user_id is distinct from old.target_user_id
     and new.target_user_id is not null then
    raise exception 'A report target pointer cannot be set or repointed' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.findback_guard_report_identity() from public, anon, authenticated;

comment on function public.findback_guard_report_identity() is
  'FindBack report identity guard (definer, internal): an INSERT must carry the live pointer for its target type, and an UPDATE may not change target_type/target_id, repoint a pointer, or resurrect a nulled one (the FK alone may null it).';

drop trigger if exists content_reports_evidence_guard on public.content_reports;
create trigger content_reports_evidence_guard
  before update on public.content_reports
  for each row execute function public.findback_guard_report_evidence_immutable();

drop trigger if exists content_reports_identity_guard on public.content_reports;
create trigger content_reports_identity_guard
  before insert or update on public.content_reports
  for each row execute function public.findback_guard_report_identity();

-- ---------------------------------------------------------------------------
-- 4. Public content_reports: no grant, RLS on, zero policies (MC D36).
--    The receipt is a definer reader (section 5), so no column is exposed.
-- ---------------------------------------------------------------------------

alter table public.content_reports enable row level security;
revoke all on table public.content_reports from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The server-built evidence snapshot (MC D5) and the report writers.
-- ---------------------------------------------------------------------------

-- 5a. D5 exact shapes, and nothing else. Explicitly absent: any binary, any
--     token, any whole user row, users.email/phone/password_hash, and any
--     internal moderation field of the target beyond the post's own current
--     moderation_visibility (which the moderator already sees).
create or replace function public.findback_capture_report_evidence(
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
  v_post_id text;
  v_snapshot jsonb;
  v_ids jsonb;
begin
  if p_target_type = 'POST' then
    select coalesce(
             jsonb_agg(a.id order by a.id),
             '[]'::jsonb
           )
      into v_ids
      from public.attachments a
     where a.post_id = p_target_id;

    select jsonb_build_object(
             'target_type', 'POST',
             'title', p.title,
             'description_excerpt', left(p.description, 500),
             'attachment_ids', v_ids,
             'author_user_id', p.user_id,
             'lifecycle_status', p.status,
             'moderation_visibility', p.moderation_visibility,
             'captured_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           )
      into v_snapshot
      from public.item_posts p
     where p.id = p_target_id;

    return v_snapshot;
  end if;

  if p_target_type = 'COMMENT' then
    select jsonb_build_object(
             'target_type', 'COMMENT',
             'body_excerpt', left(c.body, 500),
             'post_id', c.post_id,
             'author_user_id', c.user_id,
             'captured_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           )
      into v_snapshot
      from public.comments c
     where c.id = p_target_id;

    return v_snapshot;
  end if;

  if p_target_type = 'USER' then
    select jsonb_build_object(
             'target_type', 'USER',
             'username', u.username,
             'display_name', u.display_name,
             'avatar_url', u.avatar_url,
             'created_at_of_account', u.created_at,
             'captured_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           )
      into v_snapshot
      from public.users u
     where u.id = p_target_id;

    return v_snapshot;
  end if;

  return null;
end;
$$;

revoke all on function public.findback_capture_report_evidence(text, text) from public, anon, authenticated;

comment on function public.findback_capture_report_evidence(text, text) is
  'FindBack report evidence capture (definer, internal, MC D5): builds the bounded snapshot from live rows. The reporter supplies only a reason and detail, so a client cannot forge, omit or exfiltrate through it.';

-- 5b. The report limit policy seam (D6 + O3). The numeric values are policy,
--     not code, and live in this ONE function. B3 owns the base accessor that
--     O3 doubles; when it lands, this function becomes 2 x that base. Until
--     then no caller may inline these numbers (the writer calls this function).
create or replace function public.findback_report_limit()
returns table (limit_per_day integer, burst_cooldown_seconds integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- D29's Normal base is (5/day, 60 s); O3 doubles it for reports.
  return query select 10, 120;
end;
$$;

revoke all on function public.findback_report_limit() from public, anon, authenticated;

comment on function public.findback_report_limit() is
  'FindBack report limit policy (definer, internal): 10 reports per trailing 24 h with a 120 s burst cooldown, i.e. O3''s 2 x the D29 Normal base (5, 60). The value is policy owned by this one function, never a literal in the writer.';

-- 5c. THE report writer (MC D4). One definer function; no table is granted.
create or replace function public.findback_submit_report(
  p_target_type text,
  p_target_id text,
  p_reason text,
  p_detail text
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_detail text := nullif(btrim(coalesce(p_detail, '')), '');
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_limit_per_day integer;
  v_burst integer;
  v_day_count integer;
  v_last text;
  v_existing_id text;
  v_snapshot jsonb;
  v_id text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_target_type is null or p_target_type not in ('POST', 'COMMENT', 'USER') then
    raise exception 'Unknown report target type' using errcode = '22023';
  end if;
  if p_target_id is null or btrim(p_target_id) = '' then
    raise exception 'A report target id is required' using errcode = '22023';
  end if;
  if p_reason is null or p_reason <> all (public.findback_report_reasons()) then
    raise exception 'Unknown report reason' using errcode = '22023';
  end if;
  if v_detail is not null and char_length(v_detail) > 2000 then
    raise exception 'Report detail is too long' using errcode = '22023';
  end if;

  -- Serialize this reporter's target validation, dedupe, limit and insert.
  -- A count-then-insert alone cannot keep the limit under concurrency.
  perform pg_advisory_xact_lock(hashtextextended('findback_report:' || v_uid, 0));

  -- Target availability against the ONE visibility decision (D10). Every
  -- failure is the SAME raise, so nonexistent, deleted and moderated are
  -- byte-identical: the writer is not an existence oracle (§13.1).
  if p_target_type = 'POST' then
    if not exists (
      select 1
        from public.item_posts p
       where p.id = p_target_id
         and (p.user_id = v_uid or p.moderation_visibility = 'PUBLISHED')
    ) then
      raise exception 'Report target unavailable' using errcode = 'P0002';
    end if;
  elsif p_target_type = 'COMMENT' then
    if not exists (
      select 1
        from public.comments c
        join public.item_posts p on p.id = c.post_id
       where c.id = p_target_id
         and (p.user_id = v_uid or p.moderation_visibility = 'PUBLISHED')
    ) then
      raise exception 'Report target unavailable' using errcode = 'P0002';
    end if;
  else
    if not exists (select 1 from public.users u where u.id = p_target_id) then
      raise exception 'Report target unavailable' using errcode = 'P0002';
    end if;
  end if;

  -- A duplicate retry returns the SURVIVING receipt id before any limit is
  -- considered (the measured ordering inference). It never raises 23505.
  select r.id into v_existing_id
    from public.content_reports r
   where r.reporter_user_id = v_uid
     and r.target_type = p_target_type
     and r.target_id = p_target_id;
  if v_existing_id is not null then
    return v_existing_id;
  end if;

  select l.limit_per_day, l.burst_cooldown_seconds
    into v_limit_per_day, v_burst
    from public.findback_report_limit() l;

  select count(*), max(r.created_at)
    into v_day_count, v_last
    from public.content_reports r
   where r.reporter_user_id = v_uid
     and r.created_at >= to_char((now() at time zone 'utc') - interval '24 hours',
                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  if v_day_count >= v_limit_per_day then
    raise exception 'REPORT_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  if v_last is not null
     and v_last > to_char((now() at time zone 'utc') - make_interval(secs => v_burst),
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') then
    raise exception 'REPORT_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  v_snapshot := public.findback_capture_report_evidence(p_target_type, p_target_id);
  if v_snapshot is null then
    -- The target vanished between validation and capture: still neutral.
    raise exception 'Report target unavailable' using errcode = 'P0002';
  end if;

  insert into public.content_reports (
    id, reporter_user_id, target_type, target_id,
    target_post_id, target_comment_id, target_user_id,
    reason, detail, evidence_snapshot,
    evidence_captured_at, evidence_expires_at, evidence_erased_at,
    status, reviewed_by, internal_note, reviewed_at, created_at, updated_at
  ) values (
    gen_random_uuid()::text, v_uid, p_target_type, p_target_id,
    case when p_target_type = 'POST' then p_target_id end,
    case when p_target_type = 'COMMENT' then p_target_id end,
    case when p_target_type = 'USER' then p_target_id end,
    p_reason, v_detail,
    v_snapshot,
    v_now,
    to_char((now() at time zone 'utc') + interval '90 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    null,
    'OPEN', null, null, null, v_now, v_now
  )
  on conflict (reporter_user_id, target_type, target_id) do nothing;

  select r.id into v_id
    from public.content_reports r
   where r.reporter_user_id = v_uid
     and r.target_type = p_target_type
     and r.target_id = p_target_id;

  if v_id is null then
    raise exception 'The report could not be stored' using errcode = 'P0001';
  end if;
  return v_id;
end;
$$;

revoke all on function public.findback_submit_report(text, text, text, text) from public, anon;
grant execute on function public.findback_submit_report(text, text, text, text) to authenticated;

comment on function public.findback_submit_report(text, text, text, text) is
  'FindBack report writer (definer, authenticated): validates the target against the one visibility decision, returns the existing receipt for a duplicate, enforces the policy limit, and captures the evidence server-side. Idempotent for one (reporter, target); never an existence oracle (one neutral P0002).';

-- 5d. The consumer receipt (D4 shape, definer reader). Exactly five columns;
--     no target_id, no evidence, no internal note, no reviewer, no reporter.
create or replace function public.findback_my_reports()
returns table (
  id text,
  target_type text,
  reason text,
  status text,
  created_at text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return query
    select r.id, r.target_type, r.reason, r.status, r.created_at
      from public.content_reports r
     where r.reporter_user_id = v_uid
     order by r.created_at desc, r.id desc
     limit 100;
end;
$$;

revoke all on function public.findback_my_reports() from public, anon;
grant execute on function public.findback_my_reports() to authenticated;

comment on function public.findback_my_reports() is
  'FindBack report receipts (definer, authenticated): the caller''s OWN reports, five columns only. This is the whole consumer read path — content_reports itself is ungranted to every client role.';

-- 5e. The 90-day physical erasure (§13.11). service_role only; `p_now` is a
--     TEST SEAM for the exact expiry boundary, not a client parameter.
create or replace function public.findback_expire_report_evidence(
  p_limit integer default 500,
  p_now text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_now text := coalesce(
    p_now,
    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_id text;
  v_count integer := 0;
begin
  for v_id in
    select r.id
      from public.content_reports r
     where r.evidence_erased_at is null
       and r.evidence_expires_at <= v_now
     order by r.evidence_expires_at asc, r.id asc
     limit least(greatest(coalesce(p_limit, 500), 1), 5000)
  loop
    -- Erase the WHOLE bounded snapshot and every copy of its text: the
    -- reporter's detail and the internal note may not become immortal
    -- evidence (§13.11).
    update public.content_reports r
       set evidence_snapshot = '{}'::jsonb,
           detail = null,
           internal_note = null,
           evidence_erased_at = v_now,
           updated_at = v_now
     where r.id = v_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.findback_expire_report_evidence(integer, text) from public, anon, authenticated;
grant execute on function public.findback_expire_report_evidence(integer, text) to service_role;

comment on function public.findback_expire_report_evidence(integer, text) is
  'FindBack evidence expiry sweep (definer, service_role only): physically erases the bounded snapshot, the reporter detail and the internal note 90 days after capture, even if the case is open (§13.11). p_now is a test seam for the exact boundary, never a client parameter.';

-- ---------------------------------------------------------------------------
-- 6. public.account_sanctions (MC D28/D39): a history table, never a flag.
-- ---------------------------------------------------------------------------

create table if not exists public.account_sanctions (
  id             text primary key default gen_random_uuid()::text,
  user_id        text not null references public.users(id) on delete cascade,
  kind           text not null check (kind in ('WARNING', 'PROBATION', 'RESTRICTED', 'SUSPENDED', 'BANNED')),
  starts_at      text not null,
  ends_at        text null,
  reason_code    text not null check (reason_code in (
                   'SCAM_OR_MISLEADING',
                   'SPAM_OR_DUPLICATE',
                   'HARASSMENT',
                   'INAPPROPRIATE_CONTENT',
                   'PRIVATE_INFORMATION',
                   'SUSPECTED_STOLEN_OR_ILLEGAL',
                   'OTHER'
                 )),
  moderator_note text null check (moderator_note is null or char_length(moderator_note) <= 2000),
  active         boolean not null default true,
  created_by     text null references public.users(id) on delete set null,
  created_at     text not null,
  revoked_at     text null,
  revoked_by     text null references public.users(id) on delete set null
);

create index if not exists account_sanctions_user_active_idx
  on public.account_sanctions (user_id, active);

alter table public.account_sanctions enable row level security;
revoke all on table public.account_sanctions from public, anon, authenticated;

comment on table public.account_sanctions is
  'FindBack account sanctions (MC D28/D39): an append-only-ish HISTORY of WARNING/PROBATION/RESTRICTED/SUSPENDED/BANNED rows. There is no is_banned flag on users; the sanction is the standing. A revocation is a new fact written by the same privileged writer, never an edit by a client.';

-- ---------------------------------------------------------------------------
-- 7. admin_audit_log — REUSED, never re-created (D37). D1-ROLES already
--    created it, revoked every client role and enabled RLS. This file only
--    re-asserts those two facts (idempotent) and adds the queue index the
--    moderation readers group by. Append-only stays true: no UPDATE, no
--    DELETE, no write grant to any client role.
-- ---------------------------------------------------------------------------

alter table public.admin_audit_log enable row level security;
revoke all on table public.admin_audit_log from public, anon, authenticated;

create index if not exists admin_audit_log_target_idx
  on public.admin_audit_log (target_type, target_id, created_at desc);

comment on column public.admin_audit_log.reason is
  'The closed reason code (the seven report reasons) for a moderation action — never free text, so the 90-day evidence erasure cannot orphan internal prose here.';

-- ---------------------------------------------------------------------------
-- 8. The outcome notification path (D13).
--    The vocabulary gains 'MODERATION' and the insert helper lets THAT type
--    carry a NULL actor, so the copy can never name the moderator.
-- ---------------------------------------------------------------------------

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('LIKE', 'DISLIKE', 'COMMENT', 'MENTION', 'STATUS', 'REACTION', 'MODERATION'));

create or replace function public.findback_insert_notification(
  p_user_id text,
  p_actor_id text,
  p_type text,
  p_post_id text,
  p_comment_id text,
  p_preview text,
  p_reaction_kind text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  -- Never notify yourself; never double-notify the same actor for the same
  -- post/comment/type. A NULL actor is allowed for the two SYSTEM types
  -- (STATUS has no actor; MODERATION must not name the moderator, D13).
  if p_user_id is null or p_user_id = p_actor_id then
    return;
  end if;
  if p_actor_id is null and p_type not in ('STATUS', 'MODERATION') then
    return;
  end if;
  if p_comment_id is null then
    if exists (
      select 1 from public.notifications n
      where n.user_id = p_user_id
        and n.actor_id is not distinct from p_actor_id
        and n.type = p_type
        and n.post_id is not distinct from p_post_id
        and n.comment_id is null
        and n.deleted_at is null
    ) then
      return;
    end if;
  end if;
  insert into public.notifications
    (id, user_id, actor_id, type, post_id, comment_id, preview, read, created_at, deleted_at, reaction_kind)
  values
    (gen_random_uuid()::text, p_user_id, p_actor_id, p_type,
     p_post_id, p_comment_id, left(nullif(p_preview, ''), 200), 0, v_now, null, p_reaction_kind);
end;
$$;

revoke all on function
  public.findback_insert_notification(text, text, text, text, text, text, text)
  from public, anon, authenticated;

comment on function public.findback_insert_notification(text, text, text, text, text, text, text) is
  'FindBack notification insert helper (definer, internal). Unchanged from 20261011000000 except ONE delta: a MODERATION row may carry a NULL actor, because D13 forbids the copy from naming the moderator. Every 6-argument caller keeps working through the default.';

-- Consumer-safe outcome copy (D13): consequence only. No reason code, no
-- reporter, no moderator, no report count, no internal vocabulary. It is a
-- function, not a literal, so a later wave can extend it in one place.
create or replace function public.findback_moderation_outcome_copy(
  p_action text,
  p_reason_code text
)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select case p_action
    when 'PUBLISH' then 'Your content is visible again after a review.'
    when 'HIDE' then 'We hid this content after a review of our community rules.'
    when 'REMOVE' then 'We removed this content after a review of our community rules.'
    when 'WARN' then 'We sent you a warning about a recent post or comment.'
    when 'PROBATION' then 'Your account is on probation for a limited time.'
    when 'RESTRICT_POSTING' then 'Your account cannot publish new reports right now.'
    when 'SUSPEND' then 'Your account is suspended, so you cannot post or comment right now.'
    when 'BAN' then 'Your account has been banned.'
    else 'Your account was reviewed.'
  end;
$$;

revoke all on function public.findback_moderation_outcome_copy(text, text) from public, anon, authenticated;

comment on function public.findback_moderation_outcome_copy(text, text) is
  'FindBack moderation outcome copy (definer, internal, D13): consumer-safe consequence text. It never carries the reason code, the reporter, the moderator, the report count or an internal vocabulary. Called only by findback_apply_moderation.';

-- ---------------------------------------------------------------------------
-- 9. THE single privileged writer (D39 + A2.2 action → capability map).
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

  -- Close the derived case: every OPEN report for this logical target becomes
  -- ACTIONED, or DISMISSED for a NO_ACTION. This is the ONLY statement that
  -- touches a report row, and it never touches an evidence_* column.
  update public.content_reports r
     set status = case when p_action = 'NO_ACTION' then 'DISMISSED' else 'ACTIONED' end,
         reviewed_by = v_uid,
         reviewed_at = v_now,
         updated_at = v_now,
         internal_note = p_note
   where r.target_type = p_target_type
     and r.target_id = p_target_id
     and r.status = 'OPEN';

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
  'FindBack moderation writer (definer, MC D39): the ONE privileged writer. Its closed action vocabulary maps each action to the D1 capability that authorizes it (NO_ACTION→reports_review, PUBLISH/HIDE→content_hide, REMOVE→content_remove, WARN/PROBATION→members_warn, RESTRICT_POSTING→members_restrict, SUSPEND/BAN→members_suspend); an ADMIN passes every action. It writes one state change, closes the report group, appends exactly one admin_audit_log row and emits one NULL-actor outcome notification.';

-- ---------------------------------------------------------------------------
-- 10. The privileged readers (D38: a "case" is derived, never a table).
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
    from (
      select
        r.target_type,
        r.target_id,
        count(*) as report_count,
        array_agg(distinct r.reason order by r.reason) as reasons,
        min(r.created_at) as first_reported_at,
        max(r.created_at) as last_reported_at,
        case when bool_or(r.status = 'OPEN') then 'OPEN' else 'UNDER_REVIEW' end as status
      from public.content_reports r
      where r.status in ('OPEN', 'UNDER_REVIEW')
      group by r.target_type, r.target_id
    ) g
    order by g.first_reported_at asc, g.target_type asc, g.target_id asc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke all on function public.findback_moderation_queue(integer) from public, anon;
grant execute on function public.findback_moderation_queue(integer) to authenticated;

comment on function public.findback_moderation_queue(integer) is
  'FindBack moderation queue (definer, reports_review): open report groups derived by the stable (target_type, target_id) key — no case table (D38). No reporter identity, no snapshot and no note: the queue is an index, the target reader is the detail.';

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

  return jsonb_build_object(
    'target_type', p_target_type,
    'target_id', p_target_id,
    'target_exists', v_exists,
    -- The pointer-or-absence is reported HONESTLY: a deleted target is null,
    -- never a fabricated row (the amendment's B2b consequence).
    'target', case when v_exists then v_target else null end,
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
       where r.target_type = p_target_type
         and r.target_id = p_target_id
    ), '[]'::jsonb),
    'outcomes', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'action', l.action,
                 'reason', l.reason,
                 'created_at', l.created_at
               ) order by l.created_at desc, l.id desc
             )
        from public.admin_audit_log l
       where l.target_type = p_target_type
         and l.target_id = p_target_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.findback_moderation_target(text, text) from public, anon;
grant execute on function public.findback_moderation_target(text, text) to authenticated;

comment on function public.findback_moderation_target(text, text) is
  'FindBack moderation target detail (definer, reports_review): the live target row (or an honest null after deletion), its report group and its decision history. Reporter identity, moderator identity and internal case state are never projected; an expired snapshot is returned as null.';

create or replace function public.findback_my_moderation_outcomes()
returns table (
  target_type text,
  target_id text,
  action text,
  reason text,
  created_at text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Five columns, exactly (D13). No actor, no note, no previous/new state.
  return query
    select l.target_type, l.target_id, l.action, l.reason, l.created_at
      from public.admin_audit_log l
     where (l.target_type = 'POST'
              and exists (select 1 from public.item_posts p
                           where p.id = l.target_id and p.user_id = v_uid))
        or (l.target_type = 'COMMENT'
              and exists (select 1 from public.comments c
                           where c.id = l.target_id and c.user_id = v_uid))
        or (l.target_type = 'USER' and l.target_id = v_uid)
     order by l.created_at desc, l.id desc
     limit 100;
end;
$$;

revoke all on function public.findback_my_moderation_outcomes() from public, anon;
grant execute on function public.findback_my_moderation_outcomes() to authenticated;

comment on function public.findback_my_moderation_outcomes() is
  'FindBack own moderation outcomes (definer, authenticated, D13): the caller''s own decisions, five columns only. A deleted target no longer resolves ownership, so its outcome is not returned.';

create or replace function public.findback_my_post_moderation()
returns table (
  post_id text,
  moderation_visibility text,
  updated_at text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- The owner learns the state of THEIR OWN rows and nobody else's. It is a
  -- state reader, never a second visibility predicate.
  return query
    select p.id, p.moderation_visibility, p.updated_at
      from public.item_posts p
     where p.user_id = v_uid
     order by p.updated_at desc, p.id desc
     limit 200;
end;
$$;

revoke all on function public.findback_my_post_moderation() from public, anon;
grant execute on function public.findback_my_post_moderation() to authenticated;

comment on function public.findback_my_post_moderation() is
  'FindBack own post moderation state (definer, authenticated): the caller''s own rows in every state, and no one else''s. It answers "what is the state of my row", never "may you see this row".';

-- ---------------------------------------------------------------------------
-- 11. public.appeals (MC D15 + the measured B2c deletion correction).
-- ---------------------------------------------------------------------------

create table if not exists public.appeals (
  id                   text primary key default gen_random_uuid()::text,
  -- D15: the row survives the appellant; only the identity is unlinked.
  appellant_user_id    text null references public.users(id) on delete set null,
  -- The amendment's immutable logical pair. No FK, no client projection.
  subject_kind         text not null check (subject_kind in ('SANCTION', 'MODERATION_ACTION')),
  subject_id           text not null check (subject_id <> ''),
  -- The nullable live pointers; the FKs may null them, nothing else may.
  sanction_id          text null references public.account_sanctions(id) on delete set null,
  moderation_action_id text null references public.admin_audit_log(id) on delete set null,
  message              text not null check (char_length(message) between 1 and 2000),
  status               text not null default 'SUBMITTED'
                         check (status in ('SUBMITTED', 'UNDER_REVIEW', 'RESOLVED')),
  reviewer_note        text null,
  submitted_at         text not null,
  resolved_at          text null,
  resolved_by          text null,
  constraint appeals_target_shape_check check (
    (subject_kind = 'SANCTION'
       and (sanction_id is null or sanction_id = subject_id)
       and moderation_action_id is null)
    or (subject_kind = 'MODERATION_ACTION'
       and (moderation_action_id is null or moderation_action_id = subject_id)
       and sanction_id is null)
  )
);

-- One OPEN appeal per subject. The plain pair is stricter and simpler than the
-- coalesced expression form, and it cannot merge two ordinary appeals after a
-- shared sanction is deleted.
create unique index if not exists appeals_one_open_per_subject_idx
  on public.appeals (subject_kind, subject_id)
  where status in ('SUBMITTED', 'UNDER_REVIEW');

create index if not exists appeals_appellant_idx
  on public.appeals (appellant_user_id, submitted_at desc);

alter table public.appeals enable row level security;
revoke all on table public.appeals from public, anon, authenticated;

comment on table public.appeals is
  'FindBack appeals (MC D15): submission is shipped here; RESOLUTION and the appeals queue are CF-080''s and do not exist yet, so the consumer affordance stays hidden (an appeal that cannot be resolved is a broken promise). The row survives both the appellant and the subject: subject_kind/subject_id are the immutable identity pair, the live pointers are nullable, and reviewer_note is never consumer-visible.';

comment on constraint appeals_target_shape_check on public.appeals is
  'Measured B2c correction: the pointer for the row''s own subject kind may be occupied (equal to subject_id) or nulled by its FK. The historical claim that a SET NULL does not re-evaluate this CHECK is false (23514 on sanctioned-account deletion).';

create or replace function public.findback_guard_appeal_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.subject_kind = 'SANCTION' and new.sanction_id is null then
      raise exception 'A SANCTION appeal needs its live target pointer' using errcode = '23514';
    end if;
    if new.subject_kind = 'MODERATION_ACTION' and new.moderation_action_id is null then
      raise exception 'A MODERATION_ACTION appeal needs its live target pointer' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.subject_kind is distinct from old.subject_kind
     or new.subject_id is distinct from old.subject_id then
    raise exception 'An appeal subject identity is immutable' using errcode = '42501';
  end if;

  if new.sanction_id is distinct from old.sanction_id
     and new.sanction_id is not null then
    raise exception 'An appeal target pointer cannot be set or repointed' using errcode = '42501';
  end if;
  if new.moderation_action_id is distinct from old.moderation_action_id
     and new.moderation_action_id is not null then
    raise exception 'An appeal target pointer cannot be set or repointed' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.findback_guard_appeal_identity() from public, anon, authenticated;

comment on function public.findback_guard_appeal_identity() is
  'FindBack appeal identity guard (definer, internal): an INSERT must carry the live pointer for its subject kind; an UPDATE may not change subject_kind/subject_id, repoint a pointer, or resurrect a nulled one.';

drop trigger if exists appeals_identity_guard on public.appeals;
create trigger appeals_identity_guard
  before insert or update on public.appeals
  for each row execute function public.findback_guard_appeal_identity();

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
    select l.id into v_action_id
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

  return v_id;
end;
$$;

revoke all on function public.findback_submit_appeal(text, text, text) from public, anon;
grant execute on function public.findback_submit_appeal(text, text, text) to authenticated;

comment on function public.findback_submit_appeal(text, text, text) is
  'FindBack appeal writer (definer, authenticated, MC D15): the caller must own the referenced action or sanction; one open appeal per (subject_kind, subject_id); the refusal is one neutral P0002 and a duplicate is the stable APPEAL_ALREADY_OPEN. Emits no notification and no moderator signal.';

-- The resolver's copy, deliberately UNCALLED until CF-080 lands a resolver
-- (§13.11/D15: no later migration should be required). No grant, no call site.
create or replace function public.findback_appeal_outcome_copy(p_status text)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select case p_status
    when 'GRANTED' then 'Your appeal was granted and the decision has been changed.'
    when 'DENIED' then 'Your appeal was reviewed and the original decision stands.'
    else 'Your appeal was reviewed.'
  end;
$$;

revoke all on function public.findback_appeal_outcome_copy(text) from public, anon, authenticated;

comment on function public.findback_appeal_outcome_copy(text) is
  'FindBack appeal outcome copy (definer, internal): the two consumer-safe strings CF-080''s resolver will notify with. DELIBERATELY UNCALLED in this chain — there is no resolver and no appeals queue.';

commit;
