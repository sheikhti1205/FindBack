-- FindBack — the match-candidate reader (CF-060 D40/D41, the CF-050 gate).
--
-- WHY THIS FILE EXISTS.
-- The owner-adopted moderation contract left ONE question open (MC §13.9,
-- "D40/D41 candidate reconciliation remains an explicit bounded design
-- gate"): when the app proposes a possible match, may it propose the report
-- of somebody the reader has blocked?
--
-- The answer was reviewed and pinned (DESIGN-CF050-CANDIDATE-RECONCILIATION.md
-- r2, independently re-reviewed PASS):
--
--   * The exclusion belongs in the READER'S WHERE CLAUSE. The alternative —
--     return the row and let the client decide — was rejected as the
--     "fake-control class": a block created after the fetch is not
--     recomputed client-side, so the flag would be a constant false behind a
--     guard that can never fire.
--   * There is NO client-visible block column on the candidate path. The
--     reader's output shape is the feed reader's shape MINUS the
--     `blocked_author` bit, so nothing downstream (the shared `PostItem`, the
--     candidate mapper, the card) has to know that blocks exist at all. A
--     candidate that is blocked is simply not proposed.
--   * The consumer surface shows NO block copy. There is no "hidden by a
--     block" note, no empty-state explanation, no counter.
--
-- WHY A NEW FUNCTION AND NOT A FLAG ON THE FEED READER.
-- The feed reader's return shape is frozen (§13.9: "Do not mutate R3's
-- frozen projection contracts during review"), and the candidate reader has
-- a different contract anyway: it is driven by the TARGET REPORT, not by a
-- type filter, so the client can no longer lie about the target's type to
-- bypass a filter (packet 12 §23).
--
-- THE PROJECTION IS COPIED, NOT INVENTED.
-- The candidate row is the feed reader's row, column for column, so the
-- client's existing mapper reads it unchanged. The copy is from the CURRENT
-- feed reader — `findback_query_posts_client` as re-created by
-- 20261020090000_cf060_r10_feed_block_flag.sql — with exactly one
-- difference: the trailing `blocked_author` bit is NOT projected here, for
-- the reason above.
--
-- WHAT THIS MIGRATION DOES NOT DO (the design's §3.4, verbatim intent):
--   * It reads no new privileged table: not `user_blocks`, not
--     `content_reports`, not the role tables. The block term consumes the
--     view's own projection.
--   * It adds no second moderation predicate and no new block atom.
--   * It does not change the view, its WHERE, or its comment.
--   * It does not change `findback_query_posts_client` or its neighbours.
--   * It does not change any table, column or policy.
--
-- FAIL-CLOSED BY CONSTRUCTION:
--   * The target is read from `public.findback_visible_posts`, so a caller
--     cannot target a report absent from that view; an invisible target yields
--     an empty list. Owners can still see/target their own HIDDEN reports,
--     exactly as the canonical view allows; no new visibility rule is added.
--   * `auth.uid()` is NULL for an anonymous caller, so the "not my own row"
--     term matches nothing and the reader returns nothing. `anon` is revoked.
--   * `blocked_author` comes from `findback_is_blocked_with_me`, which
--     returns `exists(...)` and is therefore never NULL: `not
--     blocked_author` is a clean boolean exclusion.
--
-- STATUS. This migration has NOT been applied to the hosted project. The
-- behavioural verifier (supabase/tests/verify_20261022160000_match_candidates_reader.sql)
-- is for a DISPOSABLE LOCAL engine; its execution evidence is archived
-- separately. This header is not proof of execution or hosted deployment.
--
-- Static guard: supabase/tests/match_candidates_reader_parity.test.mjs

begin;

-- Fail loudly if ANY earlier overload exists. Never silently leave another
-- callable signature beside this one, and never replace an applied payload.
do $$ begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'findback_match_candidates_client'
  ) then
    raise exception 'Match-candidate reader already exists; use a new migration' using errcode = '42723';
  end if;
end $$;

create function public.findback_match_candidates_client(
  p_target_id text,
  p_limit integer default 20
)
returns table (
  id text,
  user_id text,
  type text,
  title text,
  description text,
  category text,
  status text,
  event_date text,
  latitude double precision,
  longitude double precision,
  location_label text,
  youtube_url text,
  created_at text,
  updated_at text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text,
  like_count bigint,
  dislike_count bigint,
  rating_avg numeric,
  rating_count bigint,
  comment_count bigint,
  attachments jsonb,
  total_count bigint,
  reaction_counts jsonb,
  reaction_total bigint,
  my_reaction text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with target as (
    -- The target is read from the VISIBLE view, so a caller cannot point the
    -- reader at a report they are not allowed to see. An invisible target
    -- leaves the cross join empty and the reader returns nothing.
    select t.id, t.type
    from public.findback_visible_posts t
    where t.id = p_target_id
  ),
  filtered as (
    select
      c.*,
      u.username as author_username,
      u.email_verified as author_email_verified,
      u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url,
      u.created_at as author_created_at,
      (select count(r.id) from reactions r where r.post_id = c.id and r.type = 'LIKE') as like_count,
      (select count(r.id) from reactions r where r.post_id = c.id and r.type = 'DISLIKE') as dislike_count,
      (select avg(ra.score) from ratings ra where ra.post_id = c.id) as rating_avg,
      (select count(ra.id) from ratings ra where ra.post_id = c.id) as rating_count,
      (select count(cm.id) from comments cm where cm.post_id = c.id) as comment_count,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'post_id', a.post_id,
            'file_url', a.file_url,
            'mime_type', a.mime_type,
            'file_name', a.file_name,
            'file_size', a.file_size,
            'created_at', a.created_at,
            'display_order', a.display_order,
            'width', a.width,
            'height', a.height
          ) order by a.display_order asc, a.created_at asc, a.id asc
        )
        from attachments a
        where a.post_id = c.id
      ), '[]'::jsonb) as attachments,
      count(*) over() as total_count,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                 count(*) as n
          from public.reactions r
          where r.post_id = c.id
          group by 1
        ) t
      ), '{}'::jsonb) as reaction_counts,
      (select count(r.id) from reactions r where r.post_id = c.id) as reaction_total,
      (select r.type from reactions r
        where r.post_id = c.id and r.user_id = auth.uid()::text
        limit 1) as my_reaction
    from public.findback_visible_posts c
    join users u on u.id = c.user_id
    cross join target t
    where
      c.type <> t.type                                   -- a LOST report matches a FOUND one and the other way round
      and c.status = 'OPEN'                              -- only an open report can still be the answer
      and c.id <> t.id                                   -- never the target itself
      and c.user_id <> (select auth.uid())::text         -- never the reader's own report
      and not c.blocked_author                           -- THE DECISION: a blocked counterpart is not proposed
  )
  select
    id,
    user_id,
    type,
    title,
    description,
    category,
    status,
    event_date,
    latitude,
    longitude,
    location_label,
    youtube_url,
    created_at,
    updated_at,
    author_username,
    author_email_verified,
    author_phone_verified,
    author_avatar_url,
    author_created_at,
    like_count,
    dislike_count,
    rating_avg,
    rating_count,
    comment_count,
    attachments,
    total_count,
    reaction_counts,
    reaction_total,
    my_reaction
  from filtered
  order by created_at desc, id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 20);
$$;

revoke all on function public.findback_match_candidates_client(text, integer) from public, anon;
grant execute on function public.findback_match_candidates_client(text, integer) to authenticated;

comment on function public.findback_match_candidates_client(text, integer) is
  'FindBack match-candidate reader (authenticated): the open reports of the OPPOSITE type to the target report, for the reader of that target. The target is read from the visible view: another party''s invisible report is not targetable; owners can still target their own HIDDEN reports, exactly as the canonical view allows. A candidate from a blocked pair is EXCLUDED in the WHERE clause, so no block bit is projected to the client and the consumer surface shows no block copy. The output shape is the feed reader''s shape without the blocked_author column. The reader''s own rows are never candidates. Page size clamped to 1..20.';

commit;
