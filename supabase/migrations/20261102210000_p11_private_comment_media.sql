-- Comment bytes: reserve before upload, bind through the existing atomic writer,
-- private authorized reads, reclaim abandoned reservations through existing queue.
begin;
update storage.buckets set public=false where id='findback-comment-media';
create index if not exists comment_attachments_storage_path_idx on public.comment_attachments(storage_path)
  where storage_path is not null;

create table public.comment_media_reservations (
  storage_key text primary key,
  user_id text not null references public.users(id) on delete cascade,
  post_id text not null references public.item_posts(id) on delete cascade,
  attachment_id text unique references public.comment_attachments(id)
    on delete cascade deferrable initially deferred,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '24 hours'
);
create index comment_media_reservations_user_idx on public.comment_media_reservations(user_id);
create index comment_media_reservations_post_idx on public.comment_media_reservations(post_id);
create index comment_media_reservations_expiry_idx on public.comment_media_reservations(expires_at)
  where attachment_id is null;
alter table public.comment_media_reservations enable row level security;
revoke all on public.comment_media_reservations from public,anon,authenticated;

create function public.findback_reserve_comment_media(p_post_id text,p_extension text)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare u text:=auth.uid()::text; k text;
begin
  if u is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_extension is null or p_extension not in ('jpg','jpeg','png','webp','gif','heic','heif','avif','bmp') then
    raise exception 'Invalid photo extension' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u,714));
  if exists(select 1 from public.account_deletion_fences where user_id=u) then
    raise exception 'Account unavailable' using errcode='42501'; end if;
  if not exists(select 1 from public.users where id=u and email_verified=1)
     or not public.findback_can_read_post_for(p_post_id,u) then
    raise exception 'Post not found' using errcode='P0002'; end if;
  if (select count(*) from public.comment_media_reservations where user_id=u and attachment_id is null)>=16 then
    raise exception 'Too many pending photos. Try again later.' using errcode='22023'; end if;
  k:=u||'/'||gen_random_uuid()::text||'.'||p_extension;
  insert into public.comment_media_reservations(storage_key,user_id,post_id) values(k,u,p_post_id);
  return k;
end $$;
revoke all on function public.findback_reserve_comment_media(text,text) from public,anon;
grant execute on function public.findback_reserve_comment_media(text,text) to authenticated;

-- Lock the reservation for the duration of the Storage insert: discard/TTL
-- cannot acknowledge deletion and then let a late upload recreate the object.
create function public.findback_can_upload_comment_object(p_key text)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare r public.comment_media_reservations;
begin
  select * into r from public.comment_media_reservations
  where storage_key=p_key and user_id=auth.uid()::text
    and attachment_id is null and expires_at>clock_timestamp() for share;
  return found and public.findback_can_read_post_for(r.post_id,auth.uid()::text);
end $$;
revoke all on function public.findback_can_upload_comment_object(text) from public,anon;
grant execute on function public.findback_can_upload_comment_object(text) to authenticated;
drop policy if exists findback_comment_media_insert_own on storage.objects;
create policy findback_comment_media_insert_own on storage.objects for insert to authenticated
  with check(bucket_id='findback-comment-media' and public.findback_can_upload_comment_object(name));
drop policy if exists findback_comment_media_delete_own on storage.objects;
drop policy if exists findback_comment_media_select_own on storage.objects;

create function public.findback_can_read_comment_object(p_key text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select auth.uid() is not null and (
    exists(select 1 from public.comment_media_reservations r
      where r.storage_key=p_key and r.user_id=auth.uid()::text
      and r.attachment_id is null and r.expires_at>now()
      and public.findback_can_read_post_for(r.post_id,auth.uid()::text))
    or exists(select 1 from public.comment_attachments a where a.storage_path=p_key
      and public.findback_can_read_comment_for(a.comment_id,auth.uid()::text))
  );
$$;
revoke all on function public.findback_can_read_comment_object(text) from public,anon;
grant execute on function public.findback_can_read_comment_object(text) to authenticated;
create policy findback_comment_media_select_authorized on storage.objects for select to authenticated
  using(bucket_id='findback-comment-media' and public.findback_can_read_comment_object(name));

-- The canonical comment RPC still owns tree/admission/descriptor validation.
-- This final row boundary supplies the missing atomic reservation consumption.
create function public.findback_bind_comment_media()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.comment_media_reservations; p text; m jsonb; u text:=auth.uid()::text;
begin
  if new.storage_path is null then return new; end if;
  select post_id into p from public.comments where id=new.comment_id and user_id=new.user_id;
  select * into r from public.comment_media_reservations where storage_key=new.storage_path for update;
  if not found or r.user_id is distinct from u or new.user_id is distinct from u
     or r.post_id is distinct from p or r.attachment_id is not null or r.expires_at<=clock_timestamp() then
    raise exception 'Photo reservation unavailable' using errcode='22023'; end if;
  select metadata into m from storage.objects where bucket_id='findback-comment-media' and name=r.storage_key for share;
  if not found or coalesce(m->>'mimetype','') not in ('image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/avif','image/bmp')
     or coalesce(m->>'size','') !~ '^[0-9]{1,8}$' then
    raise exception 'Uploaded photo unavailable' using errcode='22023'; end if;
  if (m->>'size')::bigint not between 1 and 25000000 then
    raise exception 'Invalid uploaded photo size' using errcode='22023'; end if;
  if new.kind<>'photo' or new.provider<>'STORAGE'
     or new.remote_url !~ '^https://[a-zA-Z0-9-]+\.supabase\.co/storage/v1/object/authenticated/findback-comment-media/'
     or split_part(new.remote_url,'/findback-comment-media/',2) is distinct from r.storage_key then
    raise exception 'Invalid private photo address' using errcode='22023'; end if;
  new.mime_type:=m->>'mimetype'; new.file_size:=(m->>'size')::bigint;
  new.preview_url:=new.remote_url;
  update public.comment_media_reservations set attachment_id=new.id where storage_key=r.storage_key;
  return new;
end $$;
revoke all on function public.findback_bind_comment_media() from public,anon,authenticated;
create trigger comment_attachments_bind_reservation before insert on public.comment_attachments
  for each row execute function public.findback_bind_comment_media();

create function public.findback_enqueue_comment_reservation_cleanup()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.comment_media_cleanup_queue(storage_key) values(old.storage_key)
  on conflict(storage_key) do nothing;
  return old;
end $$;
revoke all on function public.findback_enqueue_comment_reservation_cleanup() from public,anon,authenticated;
create trigger comment_media_reservations_cleanup after delete on public.comment_media_reservations
  for each row execute function public.findback_enqueue_comment_reservation_cleanup();

create function public.findback_discard_comment_media(p_key text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  delete from public.comment_media_reservations where storage_key=p_key
    and user_id=auth.uid()::text and attachment_id is null;
end $$;
revoke all on function public.findback_discard_comment_media(text) from public,anon;
grant execute on function public.findback_discard_comment_media(text) to authenticated;

create function public.purge_abandoned_comment_media(p_limit integer default 200)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  with expired as (
    select storage_key from public.comment_media_reservations
    where attachment_id is null and expires_at<=clock_timestamp()
    order by expires_at,storage_key limit greatest(1,least(coalesce(p_limit,200),1000)) for update skip locked
  ) delete from public.comment_media_reservations r using expired e where r.storage_key=e.storage_key;
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.purge_abandoned_comment_media(integer) from public,anon,authenticated;
grant execute on function public.purge_abandoned_comment_media(integer) to service_role;
commit;
