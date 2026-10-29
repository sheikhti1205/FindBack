-- M1 deletion/retention fix-forward. Report-only deletion must not erase a
-- recovery or either participant's ratings. Account identity references become
-- NULL; the existing account-rating erasure policy is deliberately unchanged.
-- Local RED: verify_beta_m1_deletion.sql (18 named violations).
begin;

-- Strict consent-cardinality check supplements, never edits, applied010000.
-- Fail closed with counts only; no silent adoption/deletion of old consent.
do $$ declare v_bad integer; begin
  select count(*) into v_bad from public.report_matches m
    join public.item_posts lp on lp.id=m.lost_report_id
    join public.item_posts fp on fp.id=m.found_report_id
   where m.status='CONFIRMED' and (
     (select count(*) from public.match_confirmations c where c.match_id=m.id)<>2
     or (select count(distinct c.owner_id_original) from public.match_confirmations c
          where c.match_id=m.id and c.owner_id_original in (lp.user_id,fp.user_id)
            and c.owner_id=c.owner_id_original)<>2);
  if v_bad>0 then
    raise exception 'M1 preflight failed closed: confirmed_consent_cardinality=%',v_bad using errcode='P0001';
  end if;
end $$;

-- Nullable live references + private original report identifiers. Tables stay
-- ungranted/RLS protected; retained identifiers are never a consumer projection.
alter table public.report_matches
  add column lost_report_id_original text,
  add column found_report_id_original text,
  add column lost_owner_user_id text,
  add column found_owner_user_id text;
update public.report_matches m set lost_report_id_original=m.lost_report_id,
  found_report_id_original=m.found_report_id,
  lost_owner_user_id=(select user_id from public.item_posts where id=m.lost_report_id),
  found_owner_user_id=(select user_id from public.item_posts where id=m.found_report_id);
alter table public.report_matches
  alter column lost_report_id_original set not null,
  alter column found_report_id_original set not null,
  alter column lost_report_id drop not null,
  alter column found_report_id drop not null,
  alter column proposed_by drop not null,
  drop constraint report_matches_lost_report_id_fkey,
  drop constraint report_matches_found_report_id_fkey,
  drop constraint report_matches_proposed_by_fkey;
alter table public.report_matches
  add constraint report_matches_lost_report_id_fkey foreign key(lost_report_id)
    references public.item_posts(id) on delete set null deferrable initially deferred,
  add constraint report_matches_found_report_id_fkey foreign key(found_report_id)
    references public.item_posts(id) on delete set null deferrable initially deferred,
  add constraint report_matches_proposed_by_fkey foreign key(proposed_by)
    references public.users(id) on delete set null deferrable initially deferred,
  add constraint report_matches_lost_owner_fk foreign key(lost_owner_user_id)
    references public.users(id) on delete set null deferrable initially deferred,
  add constraint report_matches_found_owner_fk foreign key(found_owner_user_id)
    references public.users(id) on delete set null deferrable initially deferred;
create index ix_report_matches_lost_owner on public.report_matches(lost_owner_user_id);
create index ix_report_matches_found_owner on public.report_matches(found_owner_user_id);

alter table public.successful_returns
  add column lost_post_id_original text,
  add column found_post_id_original text;
update public.successful_returns set lost_post_id_original=lost_post_id,found_post_id_original=found_post_id;
alter table public.successful_returns
  alter column lost_post_id_original set not null,
  alter column lost_post_id drop not null,
  drop constraint successful_returns_lost_post_id_fkey,
  drop constraint successful_returns_found_post_id_fkey;
alter table public.successful_returns
  add constraint successful_returns_lost_post_id_fkey foreign key(lost_post_id)
    references public.item_posts(id) on delete set null deferrable initially deferred,
  add constraint successful_returns_found_post_id_fkey foreign key(found_post_id)
    references public.item_posts(id) on delete set null deferrable initially deferred;

create function public.findback_retain_match_references()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_table_name='report_matches' then
    new.lost_report_id_original:=new.lost_report_id;
    new.found_report_id_original:=new.found_report_id;
    select user_id into new.lost_owner_user_id from public.item_posts where id=new.lost_report_id;
    select user_id into new.found_owner_user_id from public.item_posts where id=new.found_report_id;
  else
    new.lost_post_id_original:=new.lost_post_id;
    new.found_post_id_original:=new.found_post_id;
  end if;
  return new;
end $$;
revoke all on function public.findback_retain_match_references() from public,anon,authenticated,service_role;
create trigger trg_report_matches_retain_refs before insert on public.report_matches
  for each row execute function public.findback_retain_match_references();
create trigger trg_successful_returns_retain_refs before insert on public.successful_returns
  for each row execute function public.findback_retain_match_references();

-- Rare deletion is deliberately coarse: ordered prelocking BEFORE target rows,
-- not peer locks discovered in a row trigger. The lifecycle key precedes report
-- locks in proposal/confirm/handover/status/cancellation. The090000 statement
-- guards extend it to bulk UPDATE, declared-helper recovery and fence writes.
create function public.findback_prepare_report_deletion()
returns trigger language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
  if tg_table_name='users' then
    -- Existing role/deletion D1 family first, before either account row is held.
    perform pg_catalog.pg_advisory_xact_lock(20261022143000);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  perform 1 from public.item_posts order by id for update;
  perform 1 from public.report_matches order by id for update;
  return null;
end $$;
revoke all on function public.findback_prepare_report_deletion() from public,anon,authenticated,service_role;
create trigger trg_item_posts_prepare_match_deletion before delete on public.item_posts
  for each statement execute function public.findback_prepare_report_deletion();
create trigger trg_users_prepare_match_deletion before delete on public.users
  for each statement execute function public.findback_prepare_report_deletion();
create trigger trg_auth_users_prepare_match_deletion before delete on auth.users
  for each statement execute function public.findback_prepare_report_deletion();

-- A direct zero-row client DELETE would still invoke the statement prelocker.
-- Narrow deletion to the owner-checked seam so foreign/missing requests cannot
-- use that trigger to lock every report. Real service/auth cascades stay covered.
revoke delete on public.item_posts from public,anon,authenticated;
create or replace function public.findback_delete_post_client(p_post_id text)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid text:=auth.uid()::text; v_count integer;
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not exists(select 1 from public.item_posts where id=p_post_id and user_id=v_uid) then
    raise exception 'Post not found or you do not own it' using errcode='42501';
  end if;
  -- No target row is prelocked out of order. The statement trigger establishes
  -- the canonical lexical set before DELETE acquires its target-row locks.
  delete from public.item_posts where id=p_post_id and user_id=v_uid;
  get diagnostics v_count=row_count;
  if v_count=0 then raise exception 'Post not found or you do not own it' using errcode='42501'; end if;
  return true;
end $$;
revoke all on function public.findback_delete_post_client(text) from public,anon;
grant execute on function public.findback_delete_post_client(text) to authenticated;

-- Keep the applied admission implementation intact as a private delegate. The
-- single public seam adds ordering, not another matching algorithm/authority.
alter function public.findback_propose_match(text,text) rename to findback_propose_match_admission;
revoke all on function public.findback_propose_match_admission(text,text) from public,anon,authenticated,service_role;
create function public.findback_propose_match(p_lost_id text,p_found_id text)
returns text language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  perform pg_catalog.pg_advisory_xact_lock(20261029060000);
  return public.findback_propose_match_admission(p_lost_id,p_found_id);
end $$;
revoke all on function public.findback_propose_match(text,text) from public,anon;
grant execute on function public.findback_propose_match(text,text) to authenticated;

-- A service INSERT is also ordered against deletion. It cannot acquire this key
-- after holding a report row through the public proposal seam: that seam already
-- acquired it before invoking the unchanged admission implementation.
create function public.findback_order_match_insert()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin perform pg_catalog.pg_advisory_xact_lock(20261029060000); return null; end $$;
revoke all on function public.findback_order_match_insert() from public,anon,authenticated,service_role;
create trigger trg_report_matches_order_insert before insert on public.report_matches
  for each statement execute function public.findback_order_match_insert();

alter table public.report_matches drop constraint report_matches_cancel_reason_check;
alter table public.report_matches add constraint report_matches_cancel_reason_check
  check(cancel_reason is null or cancel_reason in
    ('USER_CANCELLED','SUPERSEDED_BY_CONFIRMED','REPORT_CHANGED','REPORT_DELETED'));

create function public.findback_repair_deleted_report_match()
returns trigger language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare m record; peer text;
begin
  -- Statement prelocker owns every existing report and relationship lock.
  -- This row cleanup NEVER reaches for an arbitrarily ordered peer lock.
  -- AFTER DELETE prevents changing another tuple that this same multirow
  -- DELETE still intends to remove. FK SET NULL may already have fired, so
  -- bind by the private original report ids, not disappearing live references.
  for m in select * from public.report_matches
    where status<>'CANCELLED' and (lost_report_id_original=old.id or found_report_id_original=old.id) order by id
  loop
    if exists(select 1 from public.successful_returns r
               where (r.lost_post_id_original=m.lost_report_id_original and r.found_post_id_original=m.found_report_id_original)
                  or r.lost_post_id_original=old.id or r.found_post_id_original=old.id) then
      continue; -- Past recovery is not undone by removal of its report content.
    end if;
    peer:=case when m.lost_report_id_original=old.id then m.found_report_id else m.lost_report_id end;
    update public.report_matches set status='CANCELLED',cancel_reason='REPORT_DELETED',
      cancelled_at=clock_timestamp(),cancelled_by=null where id=m.id;
    if m.status='CONFIRMED' then
      update public.item_posts set status='OPEN',
        updated_at=to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        where id=peer and status='MATCHED';
    end if;
    perform public.findback_write_audit('MATCH_CANCELLED','REPORT_MATCH',m.id,'Report deleted',
      jsonb_build_object('status',m.status),jsonb_build_object('status','CANCELLED'));
  end loop;
  return old;
end $$;
revoke all on function public.findback_repair_deleted_report_match() from public,anon,authenticated,service_role;
create trigger trg_item_posts_repair_match_deletion after delete on public.item_posts
  for each row execute function public.findback_repair_deleted_report_match();

comment on function public.findback_prepare_report_deletion() is
  'Rare-deletion ordered prelocker for report, profile and auth cascade roads. D1 before account row locks; lifecycle key, lexical report set then relationships. No consumer bypass flag.';
comment on function public.findback_delete_post_client(text) is
  'Owner-only deletion seam. Authenticates ownership before ordered statement prelocking; missing/foreign requests refuse without entering deletion. Direct authenticated DELETE is revoked.';
comment on column public.report_matches.lost_report_id_original is 'Private retained history identifier; never a consumer projection.';
comment on column public.report_matches.found_report_id_original is 'Private retained history identifier; never a consumer projection.';
comment on column public.successful_returns.lost_post_id_original is 'Private durable recovery identifier; survives report removal, never a consumer projection.';
comment on column public.successful_returns.found_post_id_original is 'Private durable recovery identifier; survives report removal, never a consumer projection.';
commit;
