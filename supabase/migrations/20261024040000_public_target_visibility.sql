-- F1 fix-forward: definer authority must survive every lock wait through the
-- mutation AND aggregate response. Never WAIT on the author while retaining
-- content/report gates. A failed author try-lock rolls back tentative authority;
-- a separate rolled-back subtransaction waits without retaining those gates.
begin;

create or replace function public.findback_react_client(p_post_id text,p_type text)
returns table(post_id text,like_count bigint,dislike_count bigint,my_reaction text,reaction_counts jsonb)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_uid text:=auth.uid()::text;
  v_available boolean;
  v_locked boolean;
  v_previous text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_type is not null and p_type not in ('LIKE','DISLIKE','LOVE','HELPFUL','SUPPORT','WOW') then
    raise exception 'Invalid reaction type' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('findback_reaction:'||v_uid||':'||p_post_id,0));
  loop
  begin
  -- SHARE conflicts with visibility UPDATE and DELETE; KEY SHARE would not
  -- protect a non-key moderation_visibility change. Hold until transaction end.
  perform 1 from public.item_posts p where p.id=p_post_id for share;
  v_locked:=found;
  select r.type into v_previous from public.reactions r
    where r.id=md5('reaction|'||p_post_id||'|'||v_uid);
  if p_type is not null and v_previous is distinct from p_type then
    if not pg_try_advisory_xact_lock(hashtextextended('findback_public_admission:'||v_uid,0)) then
      raise exception 'Retry public authority acquisition' using errcode='PFA01';
    end if;
  end if;
  -- Never reuse a visibility boolean sampled before a target/author wait.
  v_available:=v_locked and public.findback_can_read_post_for(p_post_id,v_uid);
  if not v_available then
    if p_type is not null then raise exception 'Post not found' using errcode='P0002'; end if;
    return query select p_post_id,0::bigint,0::bigint,null::text,'{}'::jsonb;
    return;
  end if;
  if v_previous is distinct from p_type then
    if p_type is not null then perform public.findback_admit_public_action('POST_REACTION'); end if;
    delete from public.reactions r where r.post_id=p_post_id and r.user_id=v_uid;
    if p_type is not null then
      insert into public.reactions(id,post_id,user_id,type,created_at)
      values(md5('reaction|'||p_post_id||'|'||v_uid),p_post_id,v_uid,p_type,
        to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;
  end if;
  return query select p_post_id,
    (select count(*) from public.reactions r where r.post_id=p_post_id and r.type='LIKE'),
    (select count(*) from public.reactions r where r.post_id=p_post_id and r.type='DISLIKE'),p_type,
    coalesce((select jsonb_object_agg(t.kind,t.n) from (
      select case when r.type='LIKE' then 'LOVE' else r.type end as kind,count(*) as n
      from public.reactions r where r.post_id=p_post_id group by 1)t),'{}'::jsonb);
  return;
  exception when sqlstate 'PFA01' then
    -- The enclosing subtransaction has released its tentative content locks.
    -- Wait in another subtransaction, then roll it back to RELEASE the author
    -- lock before trying content again. No session locks or public retry error.
    begin
      perform pg_advisory_xact_lock(hashtextextended('findback_public_admission:'||v_uid,0));
      raise exception 'Public author became available' using errcode='PFA02';
    exception when sqlstate 'PFA02' then null;
    end;
  end;
  end loop;
end $$;
revoke all on function public.findback_react_client(text,text) from public,anon;
grant execute on function public.findback_react_client(text,text) to authenticated;

create or replace function public.findback_react_comment_client(p_comment_id text,p_type text)
returns table(comment_id text,my_reaction text,reaction_counts jsonb)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_uid text:=auth.uid()::text;
  v_post text;
  v_post_locked boolean;
  v_comment_locked boolean;
  v_available boolean;
  v_previous text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_type is not null and p_type not in ('LIKE','DISLIKE','LOVE','HELPFUL','SUPPORT','WOW') then
    raise exception 'Invalid reaction type' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('findback_comment_reaction:'||v_uid||':'||p_comment_id,0));
  loop
  begin
  -- Parent lookup is a hint only: lock in post-before-comment order, then
  -- require that the locked comment still belongs to that same locked post.
  select c.post_id into v_post from public.comments c where c.id=p_comment_id;
  perform 1 from public.item_posts p where p.id=v_post for share;
  v_post_locked:=found;
  perform pg_advisory_xact_lock(hashtextextended('findback_moderation:COMMENT:'||p_comment_id,0));
  perform 1 from public.comments c where c.id=p_comment_id and c.post_id=v_post for share;
  v_comment_locked:=found;
  select cr.type into v_previous from public.comment_reactions cr
    where cr.comment_id=p_comment_id and cr.user_id=v_uid;
  if p_type is not null and v_previous is distinct from p_type then
    if not pg_try_advisory_xact_lock(hashtextextended('findback_public_admission:'||v_uid,0)) then
      raise exception 'Retry public authority acquisition' using errcode='PFA01';
    end if;
  end if;
  v_available:=v_post_locked and v_comment_locked and public.findback_can_read_comment_for(p_comment_id,v_uid);
  if not v_available then
    if p_type is not null then raise exception 'Comment not found' using errcode='P0002'; end if;
    return query select p_comment_id,null::text,'{}'::jsonb;
    return;
  end if;
  if v_previous is distinct from p_type then
    if p_type is not null then perform public.findback_public_admission_spend(v_uid,'COMMENT_REACTION'); end if;
    delete from public.comment_reactions cr where cr.comment_id=p_comment_id and cr.user_id=v_uid;
    if p_type is not null then
      insert into public.comment_reactions(id,comment_id,user_id,type,created_at)
      values(md5('comment_reaction|'||p_comment_id||'|'||v_uid),p_comment_id,v_uid,p_type,
        to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;
  end if;
  return query select p_comment_id,p_type,coalesce((select jsonb_object_agg(x.type,x.cnt) from (
    select cr.type,count(*)::integer cnt from public.comment_reactions cr
    where cr.comment_id=p_comment_id group by cr.type)x),'{}'::jsonb);
  return;
  exception when sqlstate 'PFA01' then
    begin
      perform pg_advisory_xact_lock(hashtextextended('findback_public_admission:'||v_uid,0));
      raise exception 'Public author became available' using errcode='PFA02';
    exception when sqlstate 'PFA02' then null;
    end;
  end;
  end loop;
end $$;
revoke all on function public.findback_react_comment_client(text,text) from public,anon;
grant execute on function public.findback_react_comment_client(text,text) to authenticated;

-- Still service-only. Do not silently restore the removed client rating grant.
create or replace function public.findback_rate_client(p_post_id text,p_score integer)
returns table(post_id text,score integer,rating_avg numeric,rating_count bigint)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_uid text:=auth.uid()::text;
  v_previous integer;
  v_locked boolean;
  v_now text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_score is null or p_score<1 or p_score>5 then
    raise exception 'Rating must be between 1 and 5' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('findback_rating:'||v_uid||':'||p_post_id,0));
  loop
  begin
  perform 1 from public.item_posts p where p.id=p_post_id for share;
  v_locked:=found;
  select ra.score into v_previous from public.ratings ra where ra.id=md5('rating|'||p_post_id||'|'||v_uid);
  if v_previous is distinct from p_score then
    if not pg_try_advisory_xact_lock(hashtextextended('findback_public_admission:'||v_uid,0)) then
      raise exception 'Retry public authority acquisition' using errcode='PFA01';
    end if;
  end if;
  if not v_locked or not public.findback_can_read_post_for(p_post_id,v_uid) then
    raise exception 'Post not found' using errcode='P0002'; end if;
  if v_previous is distinct from p_score then
    perform public.findback_public_admission_spend(v_uid,'POST_RATING');
    v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    delete from public.ratings r where r.post_id=p_post_id and r.user_id=v_uid;
    insert into public.ratings(id,post_id,user_id,score,created_at,updated_at)
    values(md5('rating|'||p_post_id||'|'||v_uid),p_post_id,v_uid,p_score,v_now,v_now);
  end if;
  return query select p_post_id,p_score,
    (select round(avg(ra.score),2) from public.ratings ra where ra.post_id=p_post_id),
    (select count(*) from public.ratings ra where ra.post_id=p_post_id);
  return;
  exception when sqlstate 'PFA01' then
    begin
      perform pg_advisory_xact_lock(hashtextextended('findback_public_admission:'||v_uid,0));
      raise exception 'Public author became available' using errcode='PFA02';
    exception when sqlstate 'PFA02' then null;
    end;
  end;
  end loop;
end $$;
revoke all on function public.findback_rate_client(text,integer) from public,anon,authenticated;
grant execute on function public.findback_rate_client(text,integer) to service_role;

commit;
