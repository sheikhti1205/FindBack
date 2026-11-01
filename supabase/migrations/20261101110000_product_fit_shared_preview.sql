-- Deliberate minimal public boundary, not anonymous access to full reports.
begin;
alter table public.item_posts add column public_share_enabled boolean not null default true;
-- The historical authenticated INSERT grant covers the entire table, including
-- future columns. Preserve all previously insertable columns explicitly so the
-- new owner preference cannot bypass its RPC. SELECT/UPDATE were already scoped.
revoke insert on public.item_posts from authenticated;
do $$declare v_columns text; begin
 select string_agg(quote_ident(a.attname),',' order by a.attnum) into v_columns
 from pg_catalog.pg_attribute a where a.attrelid='public.item_posts'::regclass
  and a.attnum>0 and not a.attisdropped and a.attname<>'public_share_enabled';
 execute format('grant insert (%s) on public.item_posts to authenticated',v_columns);
end$$;
revoke select(public_share_enabled),insert(public_share_enabled),update(public_share_enabled)
 on public.item_posts from public,anon,authenticated;

create function public.findback_shared_report_preview(p_post_id text)
returns table(id text,type text,title text,category text,event_month text,excerpt text)
language sql stable security definer set search_path=public,pg_temp as $$
 with eligible as (
  select p.id,p.type,p.title,p.event_date,
   case when p.category=any(array['Electronics','Bags & Wallets','Keys','Documents & IDs',
    'Books & Stationery','Clothing','Accessories & Jewelry','Other','Phones & Tablets',
    'Computers & Accessories','Audio & Wearables','Cameras & Photography','Watches & Eyewear',
    'Footwear','Personal Care','Tools & Equipment','Office Supplies','Umbrellas & Bottles',
    'Household Items','Sports & Fitness','Toys & Games','Travel & Luggage','Vehicle Accessories',
    'Medical & Health Items','Pet Accessories']) then p.category else 'Other' end as category
  from public.item_posts p where p.id=p_post_id
   and p.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and p.moderation_visibility='PUBLISHED' and p.public_share_enabled
   and exists(select 1 from public.users u where u.id=p.user_id)
 ), safe as (
  select e.*,
   (select n from unnest(array['backpack','wallet','umbrella','phone','tablet','laptop','camera',
     'keys','watch','glasses','bottle','suitcase','headphones','earbuds','book','jacket','helmet']) n
    where lower(left(e.title,500)) ~ ('\m'||n||'\M') limit 1) as item,
   (select c from unnest(array['black','white','blue','red','green','brown','grey','gray','pink',
     'purple','yellow','orange','silver','gold']) c
    where lower(left(e.title,500)) ~ ('\m'||c||'\M') limit 1) as color
  from eligible e
 )
 select s.id,s.type,
  case when s.item is null then s.category
   else case when s.color is null then initcap(s.item) else initcap(s.color)||' '||s.item end end,
  s.category,
  case when s.event_date ~ '^\d{4}-(0[1-9]|1[0-2])-\d{2}($|T)'
    and pg_catalog.pg_input_is_valid(left(s.event_date,10),'date')
   then left(s.event_date,7) else null end,
  'A '||lower(s.type)||' item report. Sign in to compare the details and contact the person who posted it.'
 from safe s;
$$;
revoke all on function public.findback_shared_report_preview(text) from public,anon,authenticated;
grant execute on function public.findback_shared_report_preview(text) to anon,authenticated,service_role;
comment on function public.findback_shared_report_preview(text) is
 'Public six-field allowlist. No free-form text/location/media/profile. PUBLISHED + share-enabled only; absent/hidden/revoked/deleted collapse. Published block policy does not hide content, no interactions granted.';

create function public.findback_report_sharing(p_post_id text,p_enabled boolean default null)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_enabled boolean;
begin
 if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 perform pg_catalog.pg_advisory_xact_lock(20261029060000);
 select p.public_share_enabled into v_enabled from public.item_posts p
  where p.id=p_post_id and p.user_id=v_uid for update;
 if not found then raise exception 'Report unavailable' using errcode='42501'; end if;
 if p_enabled is not null then
  update public.item_posts set public_share_enabled=p_enabled where id=p_post_id and user_id=v_uid;
  v_enabled:=p_enabled;
 end if;
 return v_enabled;
end;
$$;
revoke all on function public.findback_report_sharing(text,boolean) from public,anon,authenticated;
grant execute on function public.findback_report_sharing(text,boolean) to authenticated,service_role;
commit;
