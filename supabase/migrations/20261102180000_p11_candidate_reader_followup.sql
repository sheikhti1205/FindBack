-- Fix forward: 20261102120000 is applied and restored byte-for-byte to f4a56b6c.
-- The pinned reader needs privileged aggregates after raw social reads closed.
-- The security_invoker view has no WHERE; explicitly govern BOTH arms here.
begin;
create or replace function public.findback_match_candidates_client(
  p_target_id text,
  p_limit integer default 20
)
returns table (
  id text, user_id text, type text, title text, description text, category text,
  status text, event_date text, latitude double precision, longitude double precision,
  location_label text, youtube_url text, created_at text, updated_at text,
  author_username text, author_email_verified integer, author_phone_verified integer,
  author_avatar_url text, author_created_at text, like_count bigint, dislike_count bigint,
  rating_avg numeric, rating_count bigint, comment_count bigint, attachments jsonb,
  total_count bigint, reaction_counts jsonb, reaction_total bigint, my_reaction text
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with target as (
    select t.id, t.type
    from public.findback_visible_posts t
    where t.id = p_target_id and public.findback_can_read_post(t.id)
  ), filtered as (
    select c.*, u.username as author_username,
      u.email_verified as author_email_verified, u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url, u.created_at as author_created_at,
      (select count(r.id) from public.reactions r where r.post_id=c.id and r.type='LIKE') as like_count,
      (select count(r.id) from public.reactions r where r.post_id=c.id and r.type='DISLIKE') as dislike_count,
      (select avg(ra.score) from public.ratings ra where ra.post_id=c.id) as rating_avg,
      (select count(ra.id) from public.ratings ra where ra.post_id=c.id) as rating_count,
      (select count(cm.id) from public.comments cm where cm.post_id=c.id) as comment_count,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',a.id,'post_id',a.post_id,'file_url',a.file_url,'mime_type',a.mime_type,
        'file_name',a.file_name,'file_size',a.file_size,'created_at',a.created_at,
        'display_order',a.display_order,'width',a.width,'height',a.height
      ) order by a.display_order,a.created_at,a.id)
      from public.attachments a where a.post_id=c.id),'[]'::jsonb) as attachments,
      count(*) over() as total_count,
      coalesce((select jsonb_object_agg(t.kind,t.n) from (
        select case when r.type='LIKE' then 'LOVE' else r.type end as kind,count(*) as n
        from public.reactions r where r.post_id=c.id group by 1
      ) t),'{}'::jsonb) as reaction_counts,
      (select count(r.id) from public.reactions r where r.post_id=c.id) as reaction_total,
      (select r.type from public.reactions r where r.post_id=c.id
        and r.user_id=auth.uid()::text limit 1) as my_reaction
    from public.findback_visible_posts c
    join public.users u on u.id=c.user_id cross join target t
    where c.type<>t.type and c.status='OPEN' and c.id<>t.id
      and c.user_id<>(select auth.uid())::text and not c.blocked_author
      and public.findback_can_read_post(c.id)
  )
  select id,user_id,type,title,description,category,status,event_date,latitude,longitude,
    location_label,youtube_url,created_at,updated_at,author_username,author_email_verified,
    author_phone_verified,author_avatar_url,author_created_at,like_count,dislike_count,
    rating_avg,rating_count,comment_count,attachments,total_count,reaction_counts,
    reaction_total,my_reaction
  from filtered order by created_at desc,id desc
  limit least(greatest(coalesce(p_limit,20),1),20);
$$;
revoke all on function public.findback_match_candidates_client(text,integer) from public,anon;
grant execute on function public.findback_match_candidates_client(text,integer) to authenticated;
comment on function public.findback_match_candidates_client(text,integer) is
  'Legacy compatibility reader; governed definer aggregates, explicit target/candidate visibility. Shipping matching uses v2. Legacy ratings are not recovery reputation.';

-- No shipping client reads attachments directly (all use governed projections).
-- Revoke table AND column ACLs, since a column grant survives a table revoke.
revoke select on public.attachments from authenticated,anon;
do $$ declare cols text; begin
  select string_agg(quote_ident(attname),',') into cols from pg_attribute
  where attrelid='public.attachments'::regclass and attnum>0 and not attisdropped;
  execute 'revoke select ('||cols||') on public.attachments from authenticated,anon';
end $$;
drop policy if exists attachments_select_authenticated on public.attachments;
commit;
