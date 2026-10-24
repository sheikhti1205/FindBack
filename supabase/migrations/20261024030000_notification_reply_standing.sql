-- Fix-forward for safety re-audit F2. A notification reply is public activity
-- by the token's author, not a service-role repair. Do not change the generic
-- trusted-insert exemption or introduce a private-write limiter.
begin;

create or replace function public.findback_consume_reply_token_and_add_comment(p_token_hash text,p_body text)
returns table(ok boolean,reason text,comment_id text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_token public.push_reply_tokens%rowtype; v_now text;
  v_hint_post text; v_hint_parent text;
  v_parent_post text; v_parent_depth integer; v_actor text; v_author_id text;
  v_depth integer:=0; v_body text; v_id text:=gen_random_uuid()::text; v_limit integer;
begin
  if p_token_hash is null or length(p_token_hash) not between 32 and 128 then
    return query select false,'missing',null::text; return; end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 1000 then
    return query select false,'invalid_body',null::text; return; end if;
  -- Preserve content-before-token lock ordering for parent deletion cascades.
  select t.post_id,t.parent_comment_id into v_hint_post,v_hint_parent
    from public.push_reply_tokens t where t.token_hash=p_token_hash;
  if not found then return query select false,'missing',null::text; return; end if;
  perform 1 from public.item_posts p where p.id=v_hint_post for share;
  perform 1 from public.comments c where c.id=v_hint_parent for share;
  select t.* into v_token from public.push_reply_tokens t where t.token_hash=p_token_hash for update;
  if not found then return query select false,'missing',null::text; return; end if;
  if v_token.post_id is distinct from v_hint_post or v_token.parent_comment_id is distinct from v_hint_parent then
    return query select false,'parent_unavailable',null::text; return; end if;

  -- Same author lock as the public row guard. A wait must precede credential
  -- expiry/standing checks, not leave an earlier eligibility decision cached.
  perform pg_advisory_xact_lock(hashtextextended('findback_public_admission:' || v_token.user_id,0));
  v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  if v_token.used_at is not null then return query select false,'used',null::text; return; end if;
  if v_token.expires_at<=v_now then return query select false,'expired',null::text; return; end if;
  select c.post_id,c.depth,u.username,c.user_id into v_parent_post,v_parent_depth,v_actor,v_author_id
    from public.comments c join public.users u on u.id=c.user_id where c.id=v_token.parent_comment_id;
  if not found or v_parent_post<>v_token.post_id then
    return query select false,'parent_unavailable',null::text; return; end if;
  if not public.findback_can_read_post_for(v_token.post_id,v_token.user_id)
     or not public.findback_can_read_comment_for(v_token.parent_comment_id,v_token.user_id)
     or public.findback_is_blocked_pair(v_token.user_id,v_author_id) then
    return query select false,'parent_unavailable',null::text; return; end if;
  if v_parent_depth>=5 then return query select false,'depth_exceeded',null::text; return; end if;

  -- auth.uid() is not the author on this service-only path. Use the canonical
  -- author's limit owner; effective serious standing wins over probation.
  select l.limit_per_day into v_limit from public.findback_post_limit_for(v_token.user_id) l;
  if coalesce(v_limit,0)<=0 then
    raise exception 'POST_NOT_AVAILABLE: your account cannot post or comment right now' using errcode='P0001';
  end if;
  v_depth:=v_parent_depth+1; v_body:=btrim(p_body);
  if v_actor is not null and length(btrim(v_actor))>0 then v_body:='@'||btrim(v_actor)||' '||v_body; end if;
  insert into public.comments(id,post_id,user_id,parent_id,depth,body,created_at,updated_at)
    values(v_id,v_token.post_id,v_token.user_id,v_token.parent_comment_id,v_depth,v_body,v_now,v_now);
  update public.push_reply_tokens set used_at=v_now where id=v_token.id;
  if v_token.notification_id is not null then
    update public.notifications set read=1 where id=v_token.notification_id and user_id=v_token.user_id;
  end if;
  return query select true,null::text,v_id;
end $$;
revoke all on function public.findback_consume_reply_token_and_add_comment(text,text) from public,anon,authenticated;
grant execute on function public.findback_consume_reply_token_and_add_comment(text,text) to service_role;

comment on function public.findback_consume_reply_token_and_add_comment(text,text) is
  'Service-only public notification reply: token-bound author, post-wait token expiry, participant visibility, canonical author standing, and existing public admission guard. Refusal leaves token/inbox/content unchanged.';
commit;
