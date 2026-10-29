-- CF-050 admission/confirmation behavioral contract.
-- Disposable-local only; no hosted or whole-lifecycle acceptance implied.
-- Every counterexample records exact outcome + post-state, then one final
-- assertion reports all violations so one early defect cannot hide the rest.
begin;

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
values
 ('00000000-0000-4000-9800-000000000001','admission_a','admission_a@example.invalid','+8801980000001',1,now(),now()),
 ('00000000-0000-4000-9800-000000000002','admission_b','admission_b@example.invalid','+8801980000002',1,now(),now()),
 ('00000000-0000-4000-9800-000000000003','admission_c','admission_c@example.invalid','+8801980000003',1,now(),now()),
 ('00000000-0000-4000-9800-000000000004','admission_d','admission_d@example.invalid','+8801980000004',1,now(),now());

insert into public.item_posts(
 id,user_id,type,title,description,category,status,event_date,
 moderation_visibility,created_at,updated_at
) values
 ('ad-main-l','00000000-0000-4000-9800-000000000001','LOST','Wallet','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-main-f','00000000-0000-4000-9800-000000000002','FOUND','Wallet','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-same-l-a','00000000-0000-4000-9800-000000000001','LOST','Bag','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-same-l-b','00000000-0000-4000-9800-000000000002','LOST','Bag','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-own-l','00000000-0000-4000-9800-000000000001','LOST','Keys','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-own-f','00000000-0000-4000-9800-000000000001','FOUND','Keys','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-hidden-l','00000000-0000-4000-9800-000000000001','LOST','Watch','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-hidden-f','00000000-0000-4000-9800-000000000002','FOUND','Watch','Test','Other','OPEN',current_date,'HIDDEN',now(),now()),
 ('ad-foreign-l','00000000-0000-4000-9800-000000000002','LOST','Phone','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-foreign-f','00000000-0000-4000-9800-000000000003','FOUND','Phone','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-block1-l','00000000-0000-4000-9800-000000000001','LOST','Case','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-block1-f','00000000-0000-4000-9800-000000000002','FOUND','Case','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-block2-l','00000000-0000-4000-9800-000000000001','LOST','Cable','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-block2-f','00000000-0000-4000-9800-000000000002','FOUND','Cable','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-suspended-l','00000000-0000-4000-9800-000000000004','LOST','Coat','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-suspended-f','00000000-0000-4000-9800-000000000002','FOUND','Coat','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-probation-l','00000000-0000-4000-9800-000000000003','LOST','Card','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-probation-f','00000000-0000-4000-9800-000000000002','FOUND','Card','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-cancel-l','00000000-0000-4000-9800-000000000001','LOST','Book','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-cancel-f','00000000-0000-4000-9800-000000000002','FOUND','Book','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-occ-l','00000000-0000-4000-9800-000000000001','LOST','Ring','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-occ-f1','00000000-0000-4000-9800-000000000002','FOUND','Ring','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-occ-f2','00000000-0000-4000-9800-000000000003','FOUND','Ring','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('ad-equal','00000000-0000-4000-9800-000000000001','LOST','Equal','Test','Other','OPEN',current_date,'PUBLISHED',now(),now());

insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at) values
 ('00000000-0000-4000-9800-000000000001','00000000-0000-4000-9800-000000000002',now()),
 ('00000000-0000-4000-9800-000000000002','00000000-0000-4000-9800-000000000001',now())
 on conflict do nothing;

insert into public.account_sanctions(
 id,user_id,kind,starts_at,ends_at,reason_code,active,created_at
) values
 ('ad-suspended','00000000-0000-4000-9800-000000000004','SUSPENDED',
  to_char((clock_timestamp()-interval '1 hour') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),null,
  'OTHER',true,to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 ('ad-probation','00000000-0000-4000-9800-000000000003','PROBATION',
  to_char((clock_timestamp()-interval '1 hour') at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),null,
  'OTHER',true,to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

create temp table admission_failures(label text primary key, detail text) on commit drop;
grant insert,select,update on admission_failures to authenticated;

-- Exact refusal oracle. An accepted operation or a different error is a named
-- failure; unrelated SQL errors cannot masquerade as policy enforcement.
create or replace function pg_temp.ad_expect_error(
 p_label text,p_sql text,p_state text,p_message text
) returns void language plpgsql as $$
declare v_state text; v_message text;
begin
  begin
    execute p_sql;
    insert into admission_failures values(p_label,'accepted');
  exception when others then
    get stacked diagnostics v_state=returned_sqlstate,v_message=message_text;
    if v_state is distinct from p_state or v_message is distinct from p_message then
      insert into admission_failures values(p_label,
        'expected '||p_state||' / '||p_message||', got '||v_state||' / '||v_message);
    end if;
  end;
end $$;
grant execute on function pg_temp.ad_expect_error(text,text,text,text) to authenticated;

-- Structural and privacy-safe refusal cases.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000001',true);
select pg_temp.ad_expect_error('same_type',
 $$select public.findback_propose_match('ad-same-l-a','ad-same-l-b')$$,
 'P0002','Match unavailable');
select pg_temp.ad_expect_error('same_owner',
 $$select public.findback_propose_match('ad-own-l','ad-own-f')$$,
 'P0002','Match unavailable');
select pg_temp.ad_expect_error('hidden',
 $$select public.findback_propose_match('ad-hidden-l','ad-hidden-f')$$,
 'P0002','Match unavailable');
select pg_temp.ad_expect_error('foreign',
 $$select public.findback_propose_match('ad-foreign-l','ad-foreign-f')$$,
 'P0002','Match unavailable');
select pg_temp.ad_expect_error('missing',
 $$select public.findback_propose_match('ad-main-l','ad-does-not-exist')$$,
 'P0002','Match unavailable');
select pg_temp.ad_expect_error('equal_ids',
 $$select public.findback_propose_match('ad-equal','ad-equal')$$,
 '22023','Invalid match pair');
select pg_temp.ad_expect_error('blocked_a_to_b',
 $$select public.findback_propose_match('ad-block1-l','ad-block1-f')$$,
 'P0002','Match unavailable');
select pg_temp.ad_expect_error('blocked_b_to_a',
 $$select public.findback_propose_match('ad-block2-l','ad-block2-f')$$,
 'P0002','Match unavailable');
reset role;

-- Both directional rows existed above; remove them after the refusal fixtures
-- so the ordinary two-owner flows below are eligible.
delete from public.user_blocks
 where blocker_user_id in ('00000000-0000-4000-9800-000000000001','00000000-0000-4000-9800-000000000002')
   and blocked_user_id in ('00000000-0000-4000-9800-000000000001','00000000-0000-4000-9800-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000004',true);
select pg_temp.ad_expect_error('serious_standing',
 $$select public.findback_propose_match('ad-suspended-l','ad-suspended-f')$$,
 'P0002','Match unavailable');
reset role;

-- PROBATION is a public-write control, not a private consent ban.
set local role authenticated;
do $$
declare v_match text;
begin
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000003',true);
  begin
    v_match:=public.findback_propose_match('ad-probation-l','ad-probation-f');
    perform set_config('admission.probation_match',v_match,true);
  exception when others then
    insert into admission_failures values('probation_private_flow',sqlstate||' / '||sqlerrm);
  end;
end $$;
reset role;

-- Canonical orientation, proposal-as-acknowledgement and replay authorization.
set local role authenticated;
do $$
declare v_match text; v_retry text;
begin
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000001',true);
  begin
    v_match:=public.findback_propose_match('ad-main-f','ad-main-l');
    perform set_config('admission.main_match',v_match,true);
    v_retry:=public.findback_propose_match('ad-main-l','ad-main-f');
    if v_retry is distinct from v_match then
      insert into admission_failures values('active_pair_retry','returned a different identity');
    end if;
  exception when others then
    insert into admission_failures values('canonical_proposal',sqlstate||' / '||sqlerrm);
  end;
end $$;
reset role;

do $$
declare v_match text:=nullif(current_setting('admission.main_match',true),'');
begin
  if v_match is null then return; end if;
  if not exists(select 1 from public.report_matches m where m.id=v_match
                 and m.lost_report_id='ad-main-l' and m.found_report_id='ad-main-f') then
    insert into admission_failures values('canonical_orientation','wrong stored orientation');
  end if;
  if (select count(*) from public.match_confirmations c
       where c.match_id=v_match and c.owner_id_original='00000000-0000-4000-9800-000000000001')<>1
     or (select count(*) from public.match_confirmations c where c.match_id=v_match)<>1 then
    insert into admission_failures values('proposal_ack','not exactly proposer acknowledgement');
  end if;
end $$;

-- Counterpart replaying propose may discover the same active operation but is
-- not consent. A foreign caller gets the same unavailable answer as no pair.
set local role authenticated;
do $$
declare v_match text:=nullif(current_setting('admission.main_match',true),''); v_retry text;
begin
  if v_match is null then return; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000002',true);
  begin
    v_retry:=public.findback_propose_match('ad-main-l','ad-main-f');
    if v_retry is distinct from v_match then
      insert into admission_failures values('counterpart_replay','different identity');
    end if;
  exception when others then
    insert into admission_failures values('counterpart_replay',sqlstate||' / '||sqlerrm);
  end;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000003',true);
  perform pg_temp.ad_expect_error('foreign_active_replay',
    $sql$select public.findback_propose_match('ad-main-l','ad-main-f')$sql$,
    'P0002','Match unavailable');
end $$;
reset role;

do $$
declare v_match text:=nullif(current_setting('admission.main_match',true),'');
begin
  if v_match is not null and (select count(*) from public.match_confirmations c where c.match_id=v_match)<>1 then
    insert into admission_failures values('counterpart_replay_ack','replay added consent');
  end if;
end $$;

-- Counterpart acceptance establishes MATCHED; committed participant retries
-- return MATCHED without another acknowledgement.
set local role authenticated;
do $$
declare v_match text:=nullif(current_setting('admission.main_match',true),''); v_result text;
begin
  if v_match is null then return; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000002',true);
  begin
    v_result:=public.findback_confirm_match(v_match);
    if v_result<>'MATCHED' then
      insert into admission_failures values('counterpart_accept','returned '||coalesce(v_result,'NULL'));
    end if;
  exception when others then
    insert into admission_failures values('counterpart_accept',sqlstate||' / '||sqlerrm);
  end;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000001',true);
  begin
    v_result:=public.findback_confirm_match(v_match);
    if v_result<>'MATCHED' then
      insert into admission_failures values('confirm_retry','returned '||coalesce(v_result,'NULL'));
    end if;
  exception when others then
    insert into admission_failures values('confirm_retry',sqlstate||' / '||sqlerrm);
  end;
end $$;
reset role;

-- A committed retry rechecks current block eligibility and writes nothing.
insert into public.user_blocks(blocker_user_id,blocked_user_id,created_at)
values('00000000-0000-4000-9800-000000000002','00000000-0000-4000-9800-000000000001',now());
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000002',true);
select pg_temp.ad_expect_error('blocked_confirm_retry',
 format('select public.findback_confirm_match(%L)',nullif(current_setting('admission.main_match',true),'')),
 'P0002','Match unavailable');
reset role;
delete from public.user_blocks where blocker_user_id='00000000-0000-4000-9800-000000000002'
 and blocked_user_id='00000000-0000-4000-9800-000000000001';

-- Cancellation keeps history and a deliberate new proposal gets a new id.
set local role authenticated;
do $$
declare v_old text; v_new text;
begin
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000001',true);
  v_old:=public.findback_propose_match('ad-cancel-l','ad-cancel-f');
  perform public.findback_cancel_match(v_old);
  v_new:=public.findback_propose_match('ad-cancel-f','ad-cancel-l');
  perform set_config('admission.cancel_old',v_old,true);
  perform set_config('admission.cancel_new',v_new,true);
  if v_old=v_new then insert into admission_failures values('cancel_reproposal','identity was reused'); end if;
exception when others then
  insert into admission_failures values('cancel_reproposal',sqlstate||' / '||sqlerrm);
end $$;
reset role;

-- Two pending pairs may share a report. Confirming one atomically occupies both
-- reports and invalidates the conflicting pending attempt without an actor.
set local role authenticated;
do $$
declare v_first text; v_other text; v_result text;
begin
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000001',true);
  v_first:=public.findback_propose_match('ad-occ-l','ad-occ-f1');
  v_other:=public.findback_propose_match('ad-occ-l','ad-occ-f2');
  perform set_config('admission.occ_first',v_first,true);
  perform set_config('admission.occ_other',v_other,true);
  v_result:=public.findback_confirm_match(v_first);
  if v_result<>'PARTIAL' then insert into admission_failures values('same_owner_confirm_retry','returned '||coalesce(v_result,'NULL')); end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-9800-000000000002',true);
  v_result:=public.findback_confirm_match(v_first);
  if v_result<>'MATCHED' then insert into admission_failures values('occupancy_confirm','returned '||coalesce(v_result,'NULL')); end if;
exception when others then
  insert into admission_failures values('occupancy_confirm',sqlstate||' / '||sqlerrm)
  on conflict(label) do update set detail=excluded.detail;
end $$;
reset role;

do $$
declare v_first text:=nullif(current_setting('admission.occ_first',true),'');
        v_other text:=nullif(current_setting('admission.occ_other',true),'');
        v_status text; v_reason text; v_n integer;
begin
  if v_first is null or v_other is null then return; end if;
  select status into v_status from public.report_matches where id=v_other;
  if v_status is distinct from 'CANCELLED' then
    insert into admission_failures values('pending_invalidation','conflict stayed '||coalesce(v_status,'missing'));
  end if;
  begin
    execute 'select cancel_reason from public.report_matches where id=$1' into v_reason using v_other;
    if v_reason is distinct from 'SUPERSEDED_BY_CONFIRMED' then
      insert into admission_failures values('pending_invalidation_reason','got '||coalesce(v_reason,'NULL'));
    end if;
  exception when undefined_column then
    insert into admission_failures values('pending_invalidation_reason','cancel_reason column absent');
  end;
  if to_regclass('public.report_match_occupancy') is null then
    insert into admission_failures values('occupancy_authority','table absent');
  else
    execute 'select count(*) from public.report_match_occupancy where match_id=$1' into v_n using v_first;
    if v_n<>2 then insert into admission_failures values('occupancy_authority','row count '||v_n); end if;
  end if;
end $$;

-- Every rejected scenario must have left no relationship row behind.
do $$
declare v_count integer;
begin
  select count(*) into v_count from public.report_matches m where
    (m.lost_report_id,m.found_report_id) in (
      ('ad-same-l-a','ad-same-l-b'),('ad-own-l','ad-own-f'),
      ('ad-hidden-l','ad-hidden-f'),('ad-foreign-l','ad-foreign-f'),
      ('ad-block1-l','ad-block1-f'),('ad-block2-l','ad-block2-f'),
      ('ad-suspended-l','ad-suspended-f'),('ad-equal','ad-equal')
    );
  if v_count<>0 then insert into admission_failures values('refusal_post_state',v_count||' rows were written'); end if;
end $$;

-- Protected occupancy authority: no direct client privilege or permissive RLS.
do $$
begin
  if to_regclass('public.report_match_occupancy') is not null then
    if has_table_privilege('authenticated','public.report_match_occupancy','SELECT')
       or has_table_privilege('authenticated','public.report_match_occupancy','INSERT')
       or has_table_privilege('service_role','public.report_match_occupancy','SELECT') then
      insert into admission_failures values('occupancy_acl','client privilege present');
    end if;
    if exists(select 1 from pg_policies where schemaname='public' and tablename='report_match_occupancy') then
      insert into admission_failures values('occupancy_rls','policy present');
    end if;
  end if;
end $$;

do $$
declare v_failures text;
begin
  select string_agg(label||'='||detail, E'\n' order by label)
    into v_failures from admission_failures;
  if v_failures is not null then
    raise exception E'ADMISSION REGRESSIONS:\n%',v_failures;
  end if;
end $$;

select 'CF-050 admission/confirmation scenarios passed' as probe;
rollback;
