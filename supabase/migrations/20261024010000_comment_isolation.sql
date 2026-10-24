-- LIVE-PENDING, incomplete local candidate: owner amendment 2026-10-24.
-- Never apply without final integrated review, legacy preflight and a quiescent
-- write window. Historical COMMENT actions really changed POSTs; do not rewrite
-- their effect history. Public probation is a subsequent, separately tested seam.
begin;

lock table public.admin_audit_log, public.content_reports,
  public.moderation_case_audits, public.moderation_case_decisions
  in share row exclusive mode;
do $$
declare v_reports bigint; v_audits bigint; v_links bigint; v_decisions bigint;
begin
  select count(*) into v_reports from public.content_reports r
   where r.target_type='COMMENT'
     and (r.case_type is distinct from 'COMMENT' or r.case_id is distinct from r.target_id);
  select count(*) into v_audits from public.admin_audit_log l where l.target_type='COMMENT';
  select count(*) into v_links from public.moderation_case_audits ca
   left join public.admin_audit_log l on l.id=ca.audit_id
   where ca.case_type='COMMENT' or l.target_type='COMMENT';
  select count(*) into v_decisions from public.moderation_case_decisions d
   where d.target_type='COMMENT'
      or exists(select 1 from public.admin_audit_log l where l.id=d.audit_id and l.target_type='COMMENT')
      or exists(select 1 from public.content_reports r where r.target_type='COMMENT'
           and (r.id=any(d.known_report_ids) or r.id=any(d.closed_report_ids)));
  if v_reports+v_audits+v_links+v_decisions>0 then
    raise exception 'LEGACY_COMMENT_CASE_REMEDIATION_REQUIRED'
      using errcode='P0001', detail=format('reports=%s audits=%s links=%s decisions=%s',v_reports,v_audits,v_links,v_decisions);
  end if;
end $$;

alter table public.comments add column moderation_visibility text not null default 'PUBLISHED'
  check (moderation_visibility in ('PUBLISHED','HIDDEN','REMOVED','PENDING_REVIEW'));
revoke select, insert, update on public.comments from public, anon, authenticated;
grant select(id,post_id,user_id,body,created_at,updated_at) on public.comments to authenticated;
grant insert(id,post_id,user_id,body,created_at,updated_at,parent_id,depth) on public.comments to authenticated;
-- Previous column ACLs survive a table-level REVOKE.
revoke select(parent_id,depth,moderation_visibility), insert(moderation_visibility), update(moderation_visibility)
  on public.comments from public, anon, authenticated;

-- Internal explicit-actor kernels. Never recursively query comments through RLS.
create function public.findback_can_read_post_for(p_post_id text,p_viewer_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select p_viewer_id is not null and p_viewer_id<>''
    and exists(select 1 from public.users u where u.id=p_viewer_id)
    and exists(select 1 from public.item_posts p where p.id=p_post_id
      and (p.user_id=p_viewer_id or p.moderation_visibility='PUBLISHED'));
$$;
create function public.findback_can_read_comment_for(p_comment_id text,p_viewer_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select p_viewer_id is not null and p_viewer_id<>'' and exists(
    select 1 from public.comments c where c.id=p_comment_id
      and public.findback_can_read_post_for(c.post_id,p_viewer_id)
      and (c.user_id=p_viewer_id or c.moderation_visibility='PUBLISHED')
      and not exists(select 1 from public.content_reports r
        where r.reporter_user_id=p_viewer_id and r.target_type='COMMENT'
          and r.target_id=c.id and r.status in ('OPEN','UNDER_REVIEW')));
$$;
revoke all on function public.findback_can_read_post_for(text,text),
  public.findback_can_read_comment_for(text,text) from public,anon,authenticated;
grant execute on function public.findback_can_read_post_for(text,text),
  public.findback_can_read_comment_for(text,text) to service_role;

create function public.findback_can_read_post(p_post_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.findback_can_read_post_for(p_post_id,auth.uid()::text);
$$;
create function public.findback_can_read_comment(p_comment_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.findback_can_read_comment_for(p_comment_id,auth.uid()::text);
$$;
revoke all on function public.findback_can_read_post(text),public.findback_can_read_comment(text) from public,anon;
grant execute on function public.findback_can_read_post(text),public.findback_can_read_comment(text) to authenticated;

drop policy if exists item_posts_select_authenticated on public.item_posts;
create policy item_posts_select_authenticated on public.item_posts for select to authenticated
  using(public.findback_can_read_post(id));
drop policy if exists comments_select_authenticated on public.comments;
create policy comments_select_authenticated on public.comments for select to authenticated
  using(public.findback_can_read_comment(id));

create function public.findback_guard_comment_creation()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_parent_post text; v_depth integer;
begin
  -- Raw INSERT reaches BEFORE triggers before its RLS WITH CHECK. Reject an
  -- untrusted actor before ANY target lookup, otherwise the supplied author
  -- becomes a hidden-parent existence oracle. SET ROLE stays the caller role
  -- even through definer RPCs. Trusted service replies derive new.user_id only
  -- from their locked token; privileged migration fixtures have no client role.
  if (current_setting('role',true) in ('authenticated','anon') or session_user in ('authenticated','anon'))
     and (auth.uid() is null or new.user_id is distinct from auth.uid()::text) then
    raise exception 'Comment actor unavailable' using errcode='42501';
  end if;
  -- Match moderation/deletion's content lock order. A validation that ran
  -- before a FK wait is stale after the hidden parent commits.
  perform 1 from public.item_posts p where p.id=new.post_id for share;
  if new.parent_id is not null then
    perform 1 from public.comments c where c.id=new.parent_id for share;
  end if;
  if not public.findback_can_read_post_for(new.post_id,new.user_id) then
    raise exception 'Comment target unavailable' using errcode='P0002';
  end if;
  new.moderation_visibility:='PUBLISHED';
  if new.parent_id is null then new.depth:=0;
  else
    if not public.findback_can_read_comment_for(new.parent_id,new.user_id) then
      raise exception 'Comment target unavailable' using errcode='P0002';
    end if;
    select c.post_id,c.depth into v_parent_post,v_depth from public.comments c where c.id=new.parent_id;
    if v_parent_post is distinct from new.post_id or v_depth is null or v_depth>=5 or v_depth<0 then
      raise exception 'Comment target unavailable' using errcode='P0002';
    end if;
    new.depth:=v_depth+1;
  end if;
  return new;
end $$;
revoke all on function public.findback_guard_comment_creation() from public,anon,authenticated;
create trigger comments_creation_boundary before insert on public.comments
  for each row execute function public.findback_guard_comment_creation();

create or replace function public.findback_set_report_case()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  new.case_type:=new.target_type;
  new.case_id:=new.target_id;
  return new;
end $$;
create or replace function public.findback_backfill_moderation_case_audits()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer;
begin
  insert into public.moderation_case_audits(audit_id,case_type,case_id,created_at)
    select l.id,l.target_type,l.target_id,l.created_at from public.admin_audit_log l
    where l.target_type in ('POST','COMMENT','USER') on conflict(audit_id) do nothing;
  get diagnostics v_count=row_count;
  return v_count;
end $$;
comment on table public.moderation_case_decisions is
  'One final attributed decider per exact POST, COMMENT or USER case. Same-decider revision and consumer/new-report reopening. COMMENT actions never change the parent POST.';
comment on column public.content_reports.case_type is 'Exact moderation subject type; COMMENT is independent of its parent POST.';
comment on column public.content_reports.case_id is 'Exact original moderation subject identity, retained without a live-row FK.';

-- Retain the accepted POST/USER implementation behind the single public writer.
-- Its legacy COMMENT branch is unreachable: no client may execute this helper.
alter function public.findback_apply_moderation(text,text,text,text,text,text,text)
  rename to findback_apply_post_user_moderation_internal;
revoke all on function public.findback_apply_post_user_moderation_internal(text,text,text,text,text,text,text)
  from public,anon,authenticated,service_role;
create function public.findback_apply_moderation(
  p_target_type text,p_target_id text,p_action text,p_reason_code text,p_note text,
  p_sanction_kind text default null,p_sanction_ends_at text default null
)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare
  v_uid text:=auth.uid()::text;
  v_now text;
  v_author text;
  v_post text;
  v_previous text;
  v_next text;
  v_audit text:=gen_random_uuid()::text;
  v_decision public.moderation_case_decisions%rowtype;
  v_closed text[];
  v_known text[];
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_target_type is null or p_target_type not in ('POST','COMMENT','USER') then
    raise exception 'Unknown moderation target type' using errcode='22023';
  end if;
  if p_target_id is null or btrim(p_target_id)='' then
    raise exception 'A moderation target id is required' using errcode='22023';
  end if;
  if p_target_type<>'COMMENT' then
    -- Acquire before the retained implementation snapshots state. Same lock as
    -- report/appeal/current-decision paths; transaction advisory locks re-enter.
    perform pg_advisory_xact_lock(hashtextextended('findback_moderation:'||p_target_type||':'||p_target_id,0));
    if p_target_type='POST' then perform 1 from public.item_posts p where p.id=p_target_id for update;
    else perform 1 from public.users u where u.id=p_target_id for update; end if;
    return public.findback_apply_post_user_moderation_internal(
      p_target_type,p_target_id,p_action,p_reason_code,p_note,p_sanction_kind,p_sanction_ends_at);
  end if;
  if p_action is null or p_action not in ('NO_ACTION','PUBLISH','HIDE','REMOVE') then
    raise exception 'This action requires a post or comment target' using errcode='22023';
  end if;
  if p_sanction_kind is not null or p_sanction_ends_at is not null then
    raise exception 'Account sanctions require a user target' using errcode='22023';
  end if;
  if p_reason_code is null or p_reason_code<>all(public.findback_report_reasons()) then
    raise exception 'Unknown moderation reason' using errcode='22023';
  end if;
  if char_length(coalesce(p_note,''))>2000 then
    raise exception 'Moderator note is too long' using errcode='22023';
  end if;
  if not public.findback_can(case p_action when 'NO_ACTION' then 'reports_review'
       when 'REMOVE' then 'content_remove' else 'content_hide' end) then
    raise exception 'You may not perform this moderation action' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('findback_moderation:COMMENT:'||p_target_id,0));
  select c.user_id,c.moderation_visibility,c.post_id into v_author,v_previous,v_post
    from public.comments c where c.id=p_target_id for update;
  if not found and p_action<>'NO_ACTION' then
    raise exception 'Moderation target unavailable' using errcode='P0002';
  end if;
  select d.* into v_decision from public.moderation_case_decisions d
    where d.target_type='COMMENT' and d.target_id=p_target_id;
  if v_decision.decider_user_id is not null and v_decision.decider_user_id<>v_uid
     and v_decision.reopened_at is null and not exists(
       select 1 from public.content_reports r where r.case_type='COMMENT' and r.case_id=p_target_id
         and r.status in ('OPEN','UNDER_REVIEW') and not(r.id=any(v_decision.known_report_ids))) then
    raise exception 'MODERATION_DECISION_FINAL' using errcode='P0001';
  end if;
  v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_next:=case p_action when 'PUBLISH' then 'PUBLISHED' when 'HIDE' then 'HIDDEN'
    when 'REMOVE' then 'REMOVED' else v_previous end;
  if p_action<>'NO_ACTION' then
    update public.comments c set moderation_visibility=v_next where c.id=p_target_id;
    if not found then raise exception 'Moderation target unavailable' using errcode='P0002'; end if;
  end if;
  insert into public.admin_audit_log(id,actor_user_id,action,target_type,target_id,
    reason,previous_state,new_state,created_at)
  values(v_audit,v_uid,p_action,'COMMENT',p_target_id,p_reason_code,
    case when v_previous is null then null else jsonb_build_object('moderation_visibility',v_previous) end,
    case when p_action='NO_ACTION' then jsonb_build_object('action','NO_ACTION','decision_generation',coalesce(v_decision.generation,0)+1)
      else jsonb_build_object('moderation_visibility',v_next,'decision_generation',coalesce(v_decision.generation,0)+1) end,v_now);
  insert into public.moderation_case_audits(audit_id,case_type,case_id,created_at)
    values(v_audit,'COMMENT',p_target_id,v_now);
  with closed as(
    update public.content_reports r set status=case when p_action='NO_ACTION' then 'DISMISSED' else 'ACTIONED' end,
      reviewed_at=v_now,reviewed_by=v_uid,updated_at=v_now,internal_note=nullif(btrim(coalesce(p_note,'')),'')
    where r.case_type='COMMENT' and r.case_id=p_target_id and r.status in ('OPEN','UNDER_REVIEW') returning r.id
  ) select coalesce(array_agg(id order by id),'{}'::text[]) into v_closed from closed;
  select coalesce(array_agg(r.id order by r.id),'{}'::text[]) into v_known from public.content_reports r
    where r.case_type='COMMENT' and r.case_id=p_target_id;
  insert into public.moderation_case_decisions(target_type,target_id,generation,decider_user_id,
    decision_action,audit_id,sanction_id,closed_report_ids,known_report_ids,decided_at,reopened_at,reopened_by_appeal_id)
  values('COMMENT',p_target_id,coalesce(v_decision.generation,0)+1,v_uid,p_action,v_audit,null,v_closed,v_known,v_now,null,null)
  on conflict(target_type,target_id) do update set generation=excluded.generation,decider_user_id=excluded.decider_user_id,
    decision_action=excluded.decision_action,audit_id=excluded.audit_id,sanction_id=null,
    closed_report_ids=excluded.closed_report_ids,known_report_ids=excluded.known_report_ids,
    decided_at=excluded.decided_at,reopened_at=null,reopened_by_appeal_id=null;
  if p_action<>'NO_ACTION' and v_author is not null then
    perform public.findback_insert_notification(v_author,null,'MODERATION',null,null,
      public.findback_moderation_outcome_copy(p_action,p_reason_code));
  end if;
  if v_post is not null then
    -- NO_ACTION also closes pending own reports, changing recipient visibility
    -- without updating the comment row. Refetch signals carry no case/body/id.
    perform realtime.send(jsonb_build_object('postId',v_post,'entity','comment','invalidate',true,'op','MODERATION'),
      'comment:invalidate','post:'||v_post,true);
  end if;
  return v_audit;
end $$;
revoke all on function public.findback_apply_moderation(text,text,text,text,text,text,text) from public,anon;
grant execute on function public.findback_apply_moderation(text,text,text,text,text,text,text) to authenticated;

-- Ordinary children must not reveal hidden-comment reaction counts or pointers.
drop policy if exists comment_reactions_select_authenticated on public.comment_reactions;
create policy comment_reactions_select_authenticated on public.comment_reactions for select to authenticated
  using(public.findback_can_read_comment(comment_id));
drop policy if exists comment_reactions_insert_own on public.comment_reactions;
create policy comment_reactions_insert_own on public.comment_reactions for insert to authenticated
  with check(user_id=auth.uid()::text and public.findback_can_read_comment(comment_id));
drop policy if exists comment_attachments_select_own on public.comment_attachments;
-- A report row is readable to any viewer of its comment. `report_post_id` is
-- deliberately nullable (the referenced report may be deleted, ON DELETE SET
-- NULL): the surviving row is a content-free tombstone the client renders as
-- "Report unavailable", so a NULL pointer must not make the row disappear.
create policy comment_attachments_select_own on public.comment_attachments for select to authenticated using(
  (kind<>'report' and user_id=auth.uid()::text)
  or (kind='report' and public.findback_can_read_comment(comment_id)
      and (report_post_id is null or public.findback_can_read_post(report_post_id))));

create or replace function public.findback_react_comment_client(p_comment_id text,p_type text)
returns table(comment_id text,my_reaction text,reaction_counts jsonb)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_id text; v_available boolean;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_type is not null and p_type not in ('LIKE','DISLIKE','LOVE','HELPFUL','SUPPORT','WOW') then
    raise exception 'Invalid reaction type' using errcode='22023';
  end if;
  v_available:=public.findback_can_read_comment_for(p_comment_id,v_uid);
  if not v_available and p_type is not null then
    raise exception 'Comment not found' using errcode='P0002';
  end if;
  delete from public.comment_reactions cr where cr.comment_id=p_comment_id and cr.user_id=v_uid;
  if p_type is not null then
    v_id:=md5('comment_reaction|'||p_comment_id||'|'||v_uid);
    insert into public.comment_reactions(id,comment_id,user_id,type,created_at)
    values(v_id,p_comment_id,v_uid,p_type,to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  end if;
  if not v_available then
    return query select p_comment_id,null::text,'{}'::jsonb;
  else
    return query select p_comment_id,p_type,coalesce((
      select jsonb_object_agg(x.type,x.cnt) from(
        select cr.type,count(*)::integer cnt from public.comment_reactions cr where cr.comment_id=p_comment_id group by cr.type
      )x),'{}'::jsonb);
  end if;
end $$;

-- Keep the existing OUT contract; never expose hidden ancestry through it.
create or replace function public.findback_list_comments_client(p_post_id text)
returns table(id text,post_id text,parent_id text,depth integer,body text,created_at text,updated_at text,
  author_id text,author_username text,author_email_verified integer,author_phone_verified integer,
  author_avatar_url text,author_created_at text,reaction_counts jsonb,my_reaction text,attachments jsonb,blocked_author boolean)
language sql stable security definer set search_path=public,pg_temp as $$
  with recursive visible as materialized(
    select c.id,c.post_id,c.parent_id,c.body,c.created_at,c.updated_at,c.user_id
    from public.comments c where c.post_id=p_post_id and public.findback_can_read_comment_for(c.id,auth.uid()::text)
    order by c.created_at,c.id limit 500
  ), ancestry(start_id,ancestor_id,next_id,hops,visited) as(
    select c.id,p.id,p.parent_id,1,array[c.id,p.id] from visible c
    join public.comments p on p.id=c.parent_id and p.post_id=c.post_id and p.id<>c.id
    union all
    select a.start_id,p.id,p.parent_id,a.hops+1,a.visited||p.id from ancestry a
    join public.comments p on p.id=a.next_id and p.post_id=p_post_id
    where a.hops<64 and not(p.id=any(a.visited))
  ), mapped as materialized(
    select c.*, (select a.ancestor_id from ancestry a join visible v on v.id=a.ancestor_id
      where a.start_id=c.id order by a.hops limit 1) as safe_parent from visible c
  ), tree(node_id,node_parent,node_depth) as(
    select m.id,m.safe_parent,0 from mapped m where m.safe_parent is null
    union all
    select m.id,m.safe_parent,t.node_depth+1 from mapped m join tree t on m.safe_parent=t.node_id where t.node_depth<64
  )
  select c.id,c.post_id,t.node_parent,coalesce(t.node_depth,0),c.body,c.created_at,c.updated_at,
    c.user_id,u.username,u.email_verified,u.phone_verified,u.avatar_url,u.created_at,
    coalesce((select jsonb_object_agg(x.kind,x.cnt) from(
      select case when cr.type='LIKE' then 'LOVE' else cr.type end as kind,count(*)::integer cnt
      from public.comment_reactions cr where cr.comment_id=c.id group by 1)x),'{}'::jsonb),
    (select cr.type from public.comment_reactions cr
      where cr.id=md5('comment_reaction|'||c.id||'|'||auth.uid()::text)),
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'kind',a.kind,'provider',a.provider,'display_order',a.display_order,
      'report_post_id',a.report_post_id,'remote_url',a.remote_url,'preview_url',a.preview_url,
      'mime_type',a.mime_type,'file_name',a.file_name,'file_size',a.file_size,'width',a.width,
      'height',a.height,'created_at',a.created_at) order by a.display_order,a.created_at,a.id)
      from public.comment_attachments a where a.comment_id=c.id
        and (a.kind<>'report' or a.report_post_id is null
          or public.findback_can_read_post_for(a.report_post_id,auth.uid()::text))),'[]'::jsonb),
    public.findback_is_blocked_with_me(c.user_id)
  from mapped c join public.users u on u.id=c.user_id left join tree t on t.node_id=c.id
  order by c.created_at,c.id;
$$;

create or replace function public.findback_add_comment_client(p_post_id text,p_body text,p_parent_id text default null)
returns table(id text,post_id text,parent_id text,depth integer,body text,created_at text,updated_at text,
  author_id text,author_username text,author_email_verified integer,author_phone_verified integer,
  author_avatar_url text,author_created_at text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_id text:=gen_random_uuid()::text;
  v_now text:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 1000 then
    raise exception 'Comment must be 1-1000 characters' using errcode='22023';
  end if;
  -- The creation trigger performs the same neutral eligibility/topology check
  -- for this RPC, attachment RPC, raw INSERT and trusted notification reply.
  insert into public.comments(id,post_id,user_id,parent_id,depth,body,created_at,updated_at)
    values(v_id,p_post_id,v_uid,nullif(btrim(p_parent_id),''),0,btrim(p_body),v_now,v_now);
  return query select c.id,c.post_id,c.parent_id,c.depth,c.body,c.created_at,c.updated_at,
    c.user_id,u.username,u.email_verified,u.phone_verified,u.avatar_url,u.created_at
    from public.comments c join public.users u on u.id=c.user_id where c.id=v_id;
end $$;
-- Preserve the canonical attachment validation/storage path, but place caller
-- eligibility ahead of its older raw existence/topology diagnostics. Clients
-- cannot call the retained implementation directly.
alter function public.findback_add_comment_with_attachments(text,text,text,jsonb)
  rename to findback_add_comment_attachments_internal;
revoke all on function public.findback_add_comment_attachments_internal(text,text,text,jsonb)
  from public,anon,authenticated,service_role;
create function public.findback_add_comment_with_attachments(
  p_post_id text,p_body text,p_parent_id text default null,p_attachments jsonb default '[]'::jsonb
)
returns table(id text,post_id text,parent_id text,depth integer,body text,created_at text,updated_at text,
  author_id text,author_username text,author_email_verified integer,author_phone_verified integer,
  author_avatar_url text,author_created_at text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_parent text:=nullif(btrim(coalesce(p_parent_id,'')),''); d jsonb; v_report text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not public.findback_can_read_post_for(p_post_id,v_uid) then
    raise exception 'Comment target unavailable' using errcode='P0002';
  end if;
  if v_parent is not null and (not public.findback_can_read_comment_for(v_parent,v_uid)
    or not exists(select 1 from public.comments c where c.id=v_parent and c.post_id=p_post_id and c.depth between 0 and 4)) then
    raise exception 'Comment target unavailable' using errcode='P0002';
  end if;
  if p_attachments is not null and jsonb_typeof(p_attachments)<>'array' then
    raise exception 'Invalid attachment descriptors' using errcode='22023';
  end if;
  for d in select * from jsonb_array_elements(coalesce(p_attachments,'[]'::jsonb)) loop
    if lower(btrim(coalesce(d->>'kind','')))='report' then
      v_report:=nullif(btrim(coalesce(d->>'report_post_id','')),'');
      if v_report is not null and not public.findback_can_read_post_for(v_report,v_uid) then
        raise exception 'Report target unavailable' using errcode='P0002';
      end if;
    end if;
  end loop;
  return query select * from public.findback_add_comment_attachments_internal(p_post_id,p_body,v_parent,p_attachments);
end $$;
revoke all on function public.findback_add_comment_with_attachments(text,text,text,jsonb) from public,anon;
grant execute on function public.findback_add_comment_with_attachments(text,text,text,jsonb) to authenticated;

create or replace function public.findback_delete_comment_client(p_comment_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  delete from public.comments c where c.id=p_comment_id and(c.user_id=v_uid or exists(
    select 1 from public.item_posts p where p.id=c.post_id and p.user_id=v_uid));
  if not found then raise exception 'Comment not found or not allowed' using errcode='42501'; end if;
  return true;
end $$;

create or replace function public.findback_submit_report(p_target_type text,p_target_id text,p_reason text,p_detail text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_detail text:=nullif(btrim(coalesce(p_detail,'')),'');
  v_now text; v_limit integer; v_burst integer; v_count integer; v_last text; v_existing text; v_snapshot jsonb; v_id text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if p_target_type is null or p_target_type not in ('POST','COMMENT','USER') then
    raise exception 'Unknown report target type' using errcode='22023'; end if;
  if p_target_id is null or btrim(p_target_id)='' then
    raise exception 'A report target id is required' using errcode='22023'; end if;
  if p_reason is null or p_reason<>all(public.findback_report_reasons()) then
    raise exception 'Unknown report reason' using errcode='22023'; end if;
  if char_length(v_detail)>2000 then raise exception 'Report detail is too long' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('findback_report:'||v_uid,0));
  select r.id into v_existing from public.content_reports r
    where r.reporter_user_id=v_uid and r.target_type=p_target_type and r.target_id=p_target_id;
  -- Only COMMENT retry moves ahead of visibility: its first report conceals
  -- the subject for this reporter. Preserve existing POST/USER availability.
  if p_target_type='COMMENT' and v_existing is not null then return v_existing; end if;
  perform pg_advisory_xact_lock(hashtextextended('findback_moderation:'||p_target_type||':'||p_target_id,0));
  if(p_target_type='POST' and not public.findback_can_read_post_for(p_target_id,v_uid))
    or(p_target_type='COMMENT' and not public.findback_can_read_comment_for(p_target_id,v_uid))
    or(p_target_type='USER' and not exists(select 1 from public.users u where u.id=p_target_id)) then
    raise exception 'Report target unavailable' using errcode='P0002'; end if;
  if v_existing is not null then return v_existing; end if;
  v_now:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  select l.limit_per_day,l.burst_cooldown_seconds into v_limit,v_burst from public.findback_report_limit()l;
  select count(*),max(r.created_at) into v_count,v_last from public.content_reports r where r.reporter_user_id=v_uid
    and r.created_at>=to_char((clock_timestamp() at time zone 'utc')-interval '24 hours','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  if v_count>=v_limit or(v_last is not null and v_last>to_char((clock_timestamp() at time zone 'utc')-
    make_interval(secs=>v_burst),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) then
    raise exception 'REPORT_LIMIT_REACHED' using errcode='P0001'; end if;
  v_snapshot:=public.findback_capture_report_evidence(p_target_type,p_target_id);
  if v_snapshot is null then raise exception 'Report target unavailable' using errcode='P0002'; end if;
  insert into public.content_reports(id,reporter_user_id,target_type,target_id,
    target_post_id,target_comment_id,target_user_id,reason,detail,status,
    evidence_snapshot,evidence_captured_at,evidence_expires_at,created_at,updated_at)
  values(gen_random_uuid()::text,v_uid,p_target_type,p_target_id,
    case when p_target_type='POST' then p_target_id end,
    case when p_target_type='COMMENT' then p_target_id end,
    case when p_target_type='USER' then p_target_id end,
    p_reason,v_detail,'OPEN',v_snapshot,v_now,
    to_char((clock_timestamp() at time zone 'utc')+interval '90 days','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),v_now,v_now)
    returning id into v_id;
  if p_target_type='COMMENT' then
    -- Reporting is recipient-local, not a shared wrongdoing announcement.
    perform realtime.send(jsonb_build_object('postId',v_snapshot->>'post_id','entity','comment','invalidate',true),
      'comment:invalidate','notification:'||v_uid,true);
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime: shared rooms are authorization-blind, so nothing shared may carry
-- body, author, comment id or reaction counts. Clients refetch through the
-- authorized list. The same invalidation fires for INSERT, UPDATE and DELETE.
--
-- "Private channel" is only private if the subscriber is authorized. The
-- 2026-09-14 policy was `using (true)` for every authenticated account, so any
-- account could subscribe to another account's `notification:<uid>` room. This
-- wave emits a caller-private receipt there (the reporter's own report
-- invalidation), which would disclose "this account reported a comment on post
-- P" to a stranger. Authorize exactly the three product topic shapes: the
-- shared feed, one post room, and the caller's own notification room. The row's
-- own `topic` is compared (not a request GUC) so the local PG17 probe can prove
-- the outcome row by row, and hosted authorization - which asks for one topic
-- at a time - reaches the identical decision.
-- ---------------------------------------------------------------------------
drop policy if exists findback_realtime_receive_authenticated on realtime.messages;
create policy findback_realtime_receive_authenticated on realtime.messages for select to authenticated
  using(
    topic='feed'
    or topic like 'post:%'
    or topic='notification:'||auth.uid()::text);
create or replace function public.findback_broadcast_comment_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_post text;
begin
  v_post := case when tg_op='DELETE' then old.post_id else new.post_id end;
  perform realtime.send(
    jsonb_build_object('postId',v_post,'entity','comment','invalidate',true,'op',tg_op),
    'comment:invalidate','post:'||v_post,true);
  perform realtime.send(
    jsonb_build_object('postId',v_post,'entity','comment','invalidate',true),
    'post:changed','feed',true);
  return null;
end $$;
revoke all on function public.findback_broadcast_comment_change() from public,anon,authenticated;
drop trigger if exists trg_findback_broadcast_comment on public.comments;
create trigger trg_findback_broadcast_comment
  after insert or update or delete on public.comments
  for each row execute function public.findback_broadcast_comment_change();

create or replace function public.findback_broadcast_comment_reaction_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_comment text; v_post text;
begin
  v_comment := case when tg_op='DELETE' then old.comment_id else new.comment_id end;
  select c.post_id into v_post from public.comments c where c.id=v_comment;
  if v_post is null then return null; end if;
  perform realtime.send(
    jsonb_build_object('postId',v_post,'entity','comment_reaction','invalidate',true),
    'reaction:invalidate','post:'||v_post,true);
  perform realtime.send(
    jsonb_build_object('postId',v_post,'change','REACTION_CHANGE'),
    'post:changed','feed',true);
  return null;
end $$;
revoke all on function public.findback_broadcast_comment_reaction_change() from public,anon,authenticated;

-- Notification inbox: a stored row about a now-hidden comment must not reveal
-- an actionable hidden target. Recipient and target are server-owned rows.
create or replace function public.findback_list_notifications_client(p_deleted boolean default false)
returns table(id text,type text,preview text,read integer,created_at text,actor_id text,
  actor_username text,post_id text,post_title text,comment_id text,reaction_kind text,blocked_actor boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  return query
    select n.id,n.type,n.preview,n.read,n.created_at,n.actor_id,u.username,n.post_id,p.title,
      n.comment_id,n.reaction_kind,public.findback_is_blocked_with_me(n.actor_id)
    from public.notifications n
    left join public.users u on u.id=n.actor_id
    left join public.item_posts p on p.id=n.post_id
    where n.user_id=v_uid
      and (n.post_id is null or public.findback_can_read_post_for(n.post_id,v_uid))
      and (n.comment_id is null or public.findback_can_read_comment_for(n.comment_id,v_uid))
      and ((p_deleted and n.deleted_at is not null) or (not p_deleted and n.deleted_at is null))
    order by case when p_deleted then n.deleted_at else n.created_at end desc,n.id desc
    limit 100;
end $$;
revoke all on function public.findback_list_notifications_client(boolean) from public,anon;
grant execute on function public.findback_list_notifications_client(boolean) to authenticated;

-- Notification creation uses recipient eligibility too, not just inbox filtering.
-- The exact reaction-kind dedupe and NULL-actor system outcomes are retained.
create or replace function public.findback_insert_notification(
  p_user_id text,p_actor_id text,p_type text,p_post_id text,p_comment_id text,
  p_preview text,p_reaction_kind text default null
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_now text:=to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_user_id is null or p_user_id=p_actor_id then return; end if;
  if p_actor_id is null and p_type not in ('STATUS','MODERATION') then return; end if;
  if p_post_id is not null and not public.findback_can_read_post_for(p_post_id,p_user_id) then return; end if;
  if p_comment_id is not null and (not public.findback_can_read_comment_for(p_comment_id,p_user_id)
     or not exists(select 1 from public.comments c where c.id=p_comment_id and c.post_id=p_post_id)) then return; end if;
  if p_actor_id is not null and public.findback_is_blocked_pair(p_user_id,p_actor_id) then return; end if;
  if p_comment_id is null and exists(
    select 1 from public.notifications n where n.user_id=p_user_id
      and n.actor_id is not distinct from p_actor_id and n.type=p_type
      and n.post_id is not distinct from p_post_id and n.comment_id is null and n.deleted_at is null
      and (p_type<>'REACTION' or n.reaction_kind is not distinct from p_reaction_kind)
  ) then return; end if;
  insert into public.notifications(id,user_id,actor_id,type,post_id,comment_id,preview,read,created_at,deleted_at,reaction_kind)
  values(gen_random_uuid()::text,p_user_id,p_actor_id,p_type,p_post_id,p_comment_id,
    left(nullif(p_preview,''),200),0,v_now,null,p_reaction_kind);
end $$;
revoke all on function public.findback_insert_notification(text,text,text,text,text,text,text) from public,anon,authenticated;

-- Privileged dispatch rechecks an existing row. No caller-supplied recipient or
-- target can borrow another user's visibility; consumers cannot call this RPC.
create function public.findback_notification_delivery_allowed(p_notification_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.notifications n where n.id=p_notification_id
    and n.deleted_at is null and n.pushed_at is null
    and n.type in ('LIKE','DISLIKE','REACTION','COMMENT','MENTION','STATUS')
    and n.post_id is not null and public.findback_can_read_post_for(n.post_id,n.user_id)
    and (n.comment_id is null or (public.findback_can_read_comment_for(n.comment_id,n.user_id)
      and exists(select 1 from public.comments c where c.id=n.comment_id and c.post_id=n.post_id)))
    and (n.actor_id is null or not public.findback_is_blocked_pair(n.user_id,n.actor_id)));
$$;
revoke all on function public.findback_notification_delivery_allowed(text) from public,anon,authenticated;
grant execute on function public.findback_notification_delivery_allowed(text) to service_role;

-- Trusted notification reply: the token row owns the actor; an unavailable post
-- or parent returns a neutral failure and leaves the token unused.
create or replace function public.findback_consume_reply_token_and_add_comment(p_token_hash text,p_body text)
returns table(ok boolean,reason text,comment_id text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_token public.push_reply_tokens%rowtype; v_now text;
  v_hint_post text; v_hint_parent text;
  v_parent_post text; v_parent_depth integer; v_actor text; v_author_id text; v_depth integer:=0; v_body text; v_id text:=gen_random_uuid()::text;
begin
  if p_token_hash is null or length(p_token_hash) not between 32 and 128 then
    return query select false,'missing',null::text; return; end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 1000 then
    return query select false,'invalid_body',null::text; return; end if;
  -- Content before credential lock: deleting a parent cascades to its tokens.
  -- Never hold a token and then wait for that deletion's parent row. Re-read
  -- the locked token afterwards; the initial hint is not authority.
  select t.post_id,t.parent_comment_id into v_hint_post,v_hint_parent
    from public.push_reply_tokens t where t.token_hash=p_token_hash;
  if not found then return query select false,'missing',null::text; return; end if;
  perform 1 from public.item_posts p where p.id=v_hint_post for share;
  perform 1 from public.comments c where c.id=v_hint_parent for share;
  select t.* into v_token from public.push_reply_tokens t where t.token_hash=p_token_hash for update;
  if not found then return query select false,'missing',null::text; return; end if;
  if v_token.post_id is distinct from v_hint_post or v_token.parent_comment_id is distinct from v_hint_parent then
    return query select false,'parent_unavailable',null::text; return; end if;
  -- The row lock may wait across credential expiry; entry/transaction time is
  -- not authority after that wait. Use fresh time for both expiry and writes.
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

-- ---------------------------------------------------------------------------
-- Staff readers use the exact subject identity, including a deleted COMMENT.
-- Historical incompatible carriers are rejected by the preflight above, never
-- silently re-keyed to a parent. Queue visibility describes the exact subject.
-- ---------------------------------------------------------------------------
create or replace function public.findback_moderation_queue(p_limit integer default 50)
returns table(target_type text,target_id text,report_count bigint,reasons text[],
  first_reported_at text,last_reported_at text,current_visibility text,target_exists boolean,status text)
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not public.findback_can('reports_review') then
    raise exception 'You may not read the moderation queue' using errcode='42501';
  end if;
  return query
    with report_cases as (
      select r.case_type as target_type,r.case_id as target_id,count(*) as report_count,
        array_agg(distinct r.reason order by r.reason) as reasons,
        min(r.created_at) as first_reported_at,max(r.created_at) as last_reported_at,
        case when bool_or(r.status='OPEN') then 'OPEN' else 'UNDER_REVIEW' end as status
      from public.content_reports r where r.status in ('OPEN','UNDER_REVIEW') and r.case_id is not null
      group by r.case_type,r.case_id
    ), reopened_cases as (
      select d.target_type,d.target_id,
        (select count(*) from public.content_reports r
          where r.case_type=d.target_type and r.case_id=d.target_id) as report_count,
        coalesce((select array_agg(distinct r.reason order by r.reason) from public.content_reports r
          where r.case_type=d.target_type and r.case_id=d.target_id),'{}'::text[]) as reasons,
        coalesce((select min(r.created_at) from public.content_reports r
          where r.case_type=d.target_type and r.case_id=d.target_id),d.decided_at) as first_reported_at,
        coalesce((select max(r.created_at) from public.content_reports r
          where r.case_type=d.target_type and r.case_id=d.target_id),d.reopened_at) as last_reported_at,
        'OPEN'::text as status
      from public.moderation_case_decisions d where d.reopened_at is not null
    ), cases as (
      select * from report_cases
      union all
      select x.* from reopened_cases x where not exists(select 1 from report_cases g
        where g.target_type=x.target_type and g.target_id=x.target_id)
    )
    select g.target_type,g.target_id,g.report_count,g.reasons,g.first_reported_at,g.last_reported_at,
      case g.target_type
        when 'POST' then (select p.moderation_visibility from public.item_posts p where p.id=g.target_id)
        when 'COMMENT' then (select c.moderation_visibility from public.comments c where c.id=g.target_id)
        else null end,
      case g.target_type
        when 'POST' then exists(select 1 from public.item_posts p where p.id=g.target_id)
        when 'COMMENT' then exists(select 1 from public.comments c where c.id=g.target_id)
        else exists(select 1 from public.users u where u.id=g.target_id) end,
      g.status from cases g
    order by g.first_reported_at,g.target_type,g.target_id
    limit least(greatest(coalesce(p_limit,50),1),200);
end $$;
revoke all on function public.findback_moderation_queue(integer) from public,anon;
grant execute on function public.findback_moderation_queue(integer) to authenticated;
comment on function public.findback_moderation_queue(integer) is
  'Actionable exact POST/COMMENT/USER cases and consumer-reopened cases. A comment has its own visibility, evidence and final decider; it never inherits the parent post case.';

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
             'moderation_visibility', c.moderation_visibility,
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

  -- No live-row or expiring snapshot is needed to identify the exact case.
  v_case_type := p_target_type;
  v_case_id := p_target_id;

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
    -- Exact-case evidence only. Snapshot expiry also bounds cleanup lag.
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
    -- The canonical case's decision history for this exact atom.
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

revoke all on function public.findback_moderation_target(text,text) from public,anon,authenticated;
grant execute on function public.findback_moderation_target(text,text) to authenticated;


commit;
