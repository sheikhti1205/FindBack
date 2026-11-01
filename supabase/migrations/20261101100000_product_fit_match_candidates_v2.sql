-- Stage A relevance retrieval, before the bounded Stage B on-device pool.
-- Does not replace applied readers, visibility/RLS/block owners or projections.
-- No category/date/radius hard filter: long losses and absent location survive.
begin;

create function public.findback_match_candidates_v2(
  p_target_id text,
  p_limit integer default 80
)
returns table (
  id text, user_id text, type text, title text, description text, category text,
  status text, event_date text, latitude double precision, longitude double precision,
  location_label text, youtube_url text, created_at text, updated_at text,
  author_username text, author_email_verified integer, author_phone_verified integer,
  author_avatar_url text, author_created_at text,
  like_count bigint, dislike_count bigint, rating_avg numeric, rating_count bigint,
  comment_count bigint, attachments jsonb, total_count bigint,
  reaction_counts jsonb, reaction_total bigint, my_reaction text
)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  with target as materialized (
    select t.*,
      tsvector_to_array(to_tsvector('pg_catalog.simple',
        left(coalesce(t.title,''),512)||' '||left(coalesce(t.description,''),4096)||' '||
        left(coalesce(t.location_label,''),512))) as words,
      case when t.event_date ~ '^\d{4}-\d{2}-\d{2}$'
        and pg_input_is_valid(t.event_date,'date') then t.event_date::date end as event_day
    from public.findback_visible_posts t
    where t.id=p_target_id and t.status='OPEN' and not t.blocked_author
      and (select auth.uid()) is not null
  ), eligible as (
    select c.*, u.username as author_username,
      u.email_verified as author_email_verified, u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url, u.created_at as author_created_at,
      t.category as target_category, t.words as target_words, t.event_day as target_day,
      t.latitude as target_latitude, t.longitude as target_longitude,
      tsvector_to_array(to_tsvector('pg_catalog.simple',
        left(coalesce(c.title,''),512)||' '||left(coalesce(c.description,''),4096)||' '||
        left(coalesce(c.location_label,''),512))) as words,
      case when c.event_date ~ '^\d{4}-\d{2}-\d{2}$'
        and pg_input_is_valid(c.event_date,'date') then c.event_date::date end as event_day,
      case when left(c.created_at,10) ~ '^\d{4}-\d{2}-\d{2}$'
        and pg_input_is_valid(left(c.created_at,10),'date') then left(c.created_at,10)::date end as created_day
    from public.findback_visible_posts c
    join public.users u on u.id=c.user_id
    cross join target t
    where c.type<>t.type and c.status='OPEN' and c.id<>t.id
      and c.user_id<>(select auth.uid())::text and c.user_id<>t.user_id
      and not c.blocked_author
  ), scored as (
    select e.*,
      0.35 * case when e.category=e.target_category then 1 else 0 end
      + 0.35 * (select count(*)::double precision from unnest(e.words) w
          where w=any(e.target_words)) / greatest(cardinality(e.words),cardinality(e.target_words),1)
      + case when e.event_day is not null and e.target_day is not null
          then 0.15/(1+abs(e.event_day-e.target_day)/30.0) else 0 end
      + case when e.latitude between -90 and 90 and e.longitude between -180 and 180
          and e.target_latitude between -90 and 90 and e.target_longitude between -180 and 180
          then 0.10/(1+6371*acos(least(1.0,greatest(-1.0,
            sin(radians(e.latitude))*sin(radians(e.target_latitude))
            +cos(radians(e.latitude))*cos(radians(e.target_latitude))
             *cos(radians(e.longitude-e.target_longitude)))))/25) else 0 end
      + case when e.created_day is not null
          then 0.05/(1+greatest(current_date-e.created_day,0)/30.0) else 0 end as relevance
    from eligible e
  ), pool as materialized (
    select s.*, count(*) over() as total_count
    from scored s
    order by relevance desc, created_at desc, id desc
    limit least(greatest(coalesce(p_limit,80),1),80)
  )
  -- Expensive social/media projection happens only after relevance selection.
  select c.id, c.user_id, c.type, c.title, c.description, c.category, c.status,
    c.event_date, c.latitude, c.longitude, c.location_label, c.youtube_url,
    c.created_at, c.updated_at, c.author_username, c.author_email_verified,
    c.author_phone_verified, c.author_avatar_url, c.author_created_at,
    (select count(r.id) from public.reactions r where r.post_id=c.id and r.type='LIKE'),
    (select count(r.id) from public.reactions r where r.post_id=c.id and r.type='DISLIKE'),
    (select avg(r.score) from public.ratings r where r.post_id=c.id),
    (select count(r.id) from public.ratings r where r.post_id=c.id),
    (select count(cm.id) from public.comments cm where cm.post_id=c.id),
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'post_id',a.post_id,'file_url',a.file_url,'mime_type',a.mime_type,
      'file_name',a.file_name,'file_size',a.file_size,'created_at',a.created_at,
      'display_order',a.display_order,'width',a.width,'height',a.height)
      order by a.display_order asc,a.created_at asc,a.id asc)
      from public.attachments a where a.post_id=c.id),'[]'::jsonb),
    c.total_count,
    coalesce((select jsonb_object_agg(r.kind,r.n) from (
      select case when rx.type='LIKE' then 'LOVE' else rx.type end as kind,count(*) as n
      from public.reactions rx where rx.post_id=c.id group by 1
    ) r),'{}'::jsonb),
    (select count(r.id) from public.reactions r where r.post_id=c.id),
    (select r.type from public.reactions r where r.post_id=c.id and r.user_id=auth.uid()::text limit 1)
  from pool c
  order by c.relevance desc,c.created_at desc,c.id desc;
$$;

revoke all on function public.findback_match_candidates_v2(text,integer) from public,anon;
grant execute on function public.findback_match_candidates_v2(text,integer) to authenticated;
comment on function public.findback_match_candidates_v2(text,integer) is
  'Authenticated invoker relevance pool: existing visible-view/RLS and block exclusion before category/text-locality/date/geo/recency ordering, then 1..80 cap. Open opposite-type candidates exclude viewer and target author. Missing location and long-running losses are not hard-filtered. Unchanged candidate projection, no block bit or confidence score. Local semantic/text ranking remains stage two.';

commit;
