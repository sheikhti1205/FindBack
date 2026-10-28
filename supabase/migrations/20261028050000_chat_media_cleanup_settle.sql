-- Cleanup tombstones and late-write re-checks. A Storage removal is not proven
-- by the delete call alone: an upload admitted before metadata deletion can land
-- after the bytes were removed. Keep the cleanup provenance row after a verified
-- removal, re-check absence for a bounded window, and only then purge the row.
-- Object keys are random UUIDs and are never reused, so a tombstone can only
-- ever refer to one immutable object generation.
begin;
alter table public.chat_media_cleanup_queue
 add column removed_at timestamptz,
 add column next_check_at timestamptz,
 add column purge_after timestamptz,
 add constraint chat_media_cleanup_settle_shape check(
  (removed_at is null and next_check_at is null and purge_after is null) or
  (removed_at is not null and next_check_at is not null and purge_after is not null
   and next_check_at>=removed_at and purge_after>=next_check_at));
create index chat_media_cleanup_tombstone_idx on public.chat_media_cleanup_queue(next_check_at,purge_after)
 where removed_at is not null;

-- Same shape as the accepted function, plus a keyset cursor. Without it a set
-- of candidates that can never be removed (blocked source, permanent Storage
-- error) is re-claimed in every batch of every sweep and starves everything
-- ordered after it. The worker passes the last (bucket, key) it saw.
drop function if exists public.findback_chat_media_cleanup_candidates(integer);
create function public.findback_chat_media_cleanup_candidates(
 p_limit integer default 100, p_after_bucket text default null, p_after_key text default null
)
returns table(bucket_id text,media_id text,generation text,object_key text)
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare due record; emitted integer:=0; cap integer:=greatest(0,least(coalesce(p_limit,100),100));
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'Media cleanup requires READ COMMITTED' using errcode='25001';
 end if;
 -- A half-specified cursor would silently page past everything, so refuse it.
 if (p_after_bucket is null)<>(p_after_key is null) then
  raise exception 'Incomplete cleanup cursor' using errcode='22023';
 end if;
 if cap=0 then return; end if;
 for due in select d.bucket_id,d.media_id,d.generation,d.object_key from (
  select 'findback-chat-media'::text as bucket_id,a.id as media_id,a.generation,a.object_key
   from public.chat_media_attachments a where a.expires_at<=clock_timestamp()-interval '1 hour'
  union
  select q.bucket_id,q.media_id,q.generation,q.object_key from public.chat_media_cleanup_queue q
   where q.not_before<=clock_timestamp()
    and (q.removed_at is null or q.next_check_at<=clock_timestamp() or q.purge_after<=clock_timestamp())
 ) d where p_after_bucket is null or (d.bucket_id,d.object_key)>(p_after_bucket,p_after_key)
 order by d.bucket_id,d.object_key
 loop
  if due.bucket_id='findback-chat-media' then
   if not pg_try_advisory_xact_lock(public.findback_chat_media_source_lock_key(due.media_id,due.generation,due.object_key)) then
    continue;
   end if;
   -- Check only after the common fence. In-flight captures either hold it or
   -- are now committed/visible. Later captures re-read expired/deleted metadata
   -- and cannot add a new source after this pre-Storage authorization.
   if public.findback_chat_media_source_cleanup_blocked(due.media_id,due.generation,due.object_key) then continue; end if;
  end if;
  bucket_id:=due.bucket_id; media_id:=due.media_id; generation:=due.generation; object_key:=due.object_key;
  return next;
  emitted:=emitted+1;
  if emitted>=cap then return; end if;
 end loop;
end
$$;
revoke all on function public.findback_chat_media_cleanup_candidates(integer,text,text) from public,anon,authenticated;
grant execute on function public.findback_chat_media_cleanup_candidates(integer,text,text) to service_role;

-- Called only after the worker verified the object is absent. Live metadata is
-- deleted first (which queues the same key through the delete trigger), then the
-- surviving queue row becomes a tombstone. A tombstone is re-checked once a day
-- and purged after seven days; a re-check that finds bytes again re-authorizes
-- removal instead of silently orphaning them.
-- Returns true only when this call actually advanced or purged the row. A
-- caller must not count a declined acknowledgement (lost lock, blocked source,
-- nothing due) as success.
drop function if exists public.findback_chat_media_cleanup_done(text,text,text,text);
create function public.findback_chat_media_cleanup_done(
 p_bucket_id text,p_media_id text,p_generation text,p_object_key text
)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_live boolean; v_queued boolean; v_changed integer:=0; v_last integer:=0;
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'Media cleanup requires READ COMMITTED' using errcode='25001';
 end if;
 if p_bucket_id not in('findback-chat-media','findback-chat-moderation-evidence') then
  raise exception 'Unknown media bucket' using errcode='22023'; end if;
 if p_bucket_id='findback-chat-media' then
  if not pg_try_advisory_xact_lock(public.findback_chat_media_source_lock_key(p_media_id,p_generation,p_object_key)) then return false; end if;
  if public.findback_chat_media_source_cleanup_blocked(p_media_id,p_generation,p_object_key) then return false; end if;
 end if;
 select exists(select 1 from public.chat_media_attachments a where p_bucket_id='findback-chat-media'
   and a.id=p_media_id and a.generation=p_generation and a.object_key=p_object_key
   and a.expires_at<=clock_timestamp()-interval '1 hour') into v_live;
 select exists(select 1 from public.chat_media_cleanup_queue q where q.bucket_id=p_bucket_id
   and q.media_id=p_media_id and q.generation=p_generation and q.object_key=p_object_key
   and q.not_before<=clock_timestamp()
   and (q.removed_at is null or q.next_check_at<=clock_timestamp() or q.purge_after<=clock_timestamp())) into v_queued;
 if not v_live and not v_queued then return false; end if;
 if v_live then
  delete from public.chat_media_attachments where id=p_media_id and generation=p_generation
   and object_key=p_object_key and expires_at<=clock_timestamp()-interval '1 hour';
  get diagnostics v_changed=row_count;
  update public.chat_media_cleanup_queue set removed_at=clock_timestamp(),
   next_check_at=clock_timestamp()+interval '1 day',purge_after=clock_timestamp()+interval '7 days'
   where bucket_id='findback-chat-media' and media_id=p_media_id and generation=p_generation
    and object_key=p_object_key and removed_at is null;
  get diagnostics v_last=row_count; v_changed:=v_changed+v_last;
 end if;
 if v_queued then
  delete from public.chat_media_cleanup_queue q where q.bucket_id=p_bucket_id and q.media_id=p_media_id
   and q.generation=p_generation and q.object_key=p_object_key and q.purge_after<=clock_timestamp();
  get diagnostics v_last=row_count; v_changed:=v_changed+v_last;
  -- Re-check daily, but never schedule the next check past the purge instant:
  -- purge_after is fixed for the life of the tombstone, so a plain +1 day would
  -- violate the shape constraint on the sixth day and fail every acknowledgement
  -- for the last day of the window.
  update public.chat_media_cleanup_queue q set removed_at=coalesce(q.removed_at,clock_timestamp()),
   next_check_at=least(clock_timestamp()+interval '1 day',
    coalesce(q.purge_after,clock_timestamp()+interval '7 days')),
   purge_after=coalesce(q.purge_after,clock_timestamp()+interval '7 days')
   where q.bucket_id=p_bucket_id and q.media_id=p_media_id and q.generation=p_generation
    and q.object_key=p_object_key and (q.removed_at is null or q.next_check_at<=clock_timestamp());
  get diagnostics v_last=row_count; v_changed:=v_changed+v_last;
 end if;
 -- True only when a row was actually deleted, purged or re-armed. A lost lock,
 -- a blocked source or a row that is not due is reported as declined.
 return v_changed>0;
end
$$;
revoke all on function public.findback_chat_media_cleanup_done(text,text,text,text) from public,anon,authenticated;
grant execute on function public.findback_chat_media_cleanup_done(text,text,text,text) to service_role;

-- A worker that observes bytes again after acknowledgement calls this to make
-- the tombstone due immediately. It never creates a new provenance row for a
-- key the database no longer tracks, and it never deletes anything.
create function public.findback_chat_media_cleanup_recheck(
 p_bucket_id text,p_media_id text,p_generation text,p_object_key text
)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_updated integer;
begin
 if p_bucket_id not in('findback-chat-media','findback-chat-moderation-evidence') then
  raise exception 'Unknown media bucket' using errcode='22023'; end if;
 update public.chat_media_cleanup_queue q set next_check_at=clock_timestamp(),
  not_before=least(q.not_before,clock_timestamp())
  where q.bucket_id=p_bucket_id and q.media_id=p_media_id and q.generation=p_generation
   and q.object_key=p_object_key;
 get diagnostics v_updated=row_count;
 return v_updated>0;
end
$$;
revoke all on function public.findback_chat_media_cleanup_recheck(text,text,text,text) from public,anon,authenticated;
grant execute on function public.findback_chat_media_cleanup_recheck(text,text,text,text) to service_role;
commit;
