-- CF-050 linked recovery: RECOVERED must be a durable relationship row, not a
-- status write; confirmation/handover history must survive deletion of the
-- match row or the participant; the generic status writer must not fabricate a
-- linked lifecycle; and a confirmed link with no recovery must stay correctable.
--
-- Scope note: this probe covers the recovery/lifecycle seam only. Per-report
-- occupancy, audited correction of a completed recovery, direct `type` edits on
-- a linked report, concurrency/deadlock behaviour and the client integration of
-- propose/confirm/handover remain separate gates and are NOT accepted here.
--
-- RED expectation on the pre-fix chain: L1, L2, L6, L6b, L6c, L8, L8b, L9b,
-- L11, L11b, L12, L12b, L13, L13b, L16, L16b, L17, L17b, L18, L18b, L19, L19b,
-- L21b and L22 are EMPTY, and the participant account delete errors on
-- report_matches_proposed_by_fkey. L3/L4/L5/L5b/L7a/L7b/L9/L10/L10b/L13c/L13d/
-- L14/L19c/L20/L21 pass before and after: they are regression guards, not
-- evidence of a fix. L19c holds pre-fix for the wrong reason (the update matched
-- no row); it exists to keep a foreign report answering 42501 after the fix,
-- not to demonstrate the defect. L13c passes pre-fix because the pre-fix seam ignored links
-- entirely; it guards the post-fix behaviour, it does not demonstrate the
-- defect. L21 is the recovery itself (it must keep working); L21b is the
-- assertion about what it leaves behind.
begin;

insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
values
  ('00000000-0000-4000-9700-000000000001','cflr_owner_a','cflr_a@example.invalid','+8801970000001',1,'2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  ('00000000-0000-4000-9700-000000000002','cflr_owner_b','cflr_b@example.invalid','+8801970000002',1,'2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  ('00000000-0000-4000-9700-000000000003','cflr_outsider','cflr_c@example.invalid','+8801970000003',1,'2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z');

insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
values
  ('cflr-lost','00000000-0000-4000-9700-000000000001','LOST','Wallet','Synthetic wallet','Other','OPEN','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  ('cflr-found','00000000-0000-4000-9700-000000000002','FOUND','Wallet','Synthetic wallet','Other','OPEN','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  ('cflr2-lost','00000000-0000-4000-9700-000000000001','LOST','Bag','Synthetic bag','Other','OPEN','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  ('cflr2-found','00000000-0000-4000-9700-000000000002','FOUND','Bag','Synthetic bag','Other','OPEN','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  -- The hosted legacy shape: MATCHED with no report_matches row at all.
  ('cflr3-lost','00000000-0000-4000-9700-000000000001','LOST','Umbrella','Synthetic umbrella','Other','MATCHED','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  ('cflr5-lost','00000000-0000-4000-9700-000000000001','LOST','Charger','Synthetic charger','Other','OPEN','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  ('cflr7-lost','00000000-0000-4000-9700-000000000001','LOST','Keys','Synthetic keys','Other','OPEN','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z'),
  ('cflr7-found','00000000-0000-4000-9700-000000000002','FOUND','Keys','Synthetic keys','Other','OPEN','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z');

create temp table cflr_guard(label text, outcome text) on commit drop;
-- The capture blocks run as `authenticated`, so the temp table needs the grant.
grant insert, select on cflr_guard to authenticated;

-- Scenario A: mutual confirmation, then mutual handover.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select set_config('cflr.match_a', public.findback_propose_match('cflr-lost','cflr-found'), true);
select 'L0 owner A confirmation is PARTIAL' as probe
where public.findback_confirm_match(current_setting('cflr.match_a'))='PARTIAL';
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
select 'L0b owner B confirmation is MATCHED' as probe
where public.findback_confirm_match(current_setting('cflr.match_a'))='MATCHED';
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select 'L0c owner A handover is PARTIAL' as probe
where public.findback_handover_match(current_setting('cflr.match_a'))='PARTIAL';
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
select 'L0d owner B handover is RECOVERED' as probe
where public.findback_handover_match(current_setting('cflr.match_a'))='RECOVERED';
reset role;

-- L1/L2: the handover must leave a canonical successful_returns relationship.
select 'L1 handover records exactly one canonical successful_returns row' as probe
where (select count(*) from public.successful_returns where lost_post_id='cflr-lost')=1;

select 'L2 the recovery row names both posts and the finder as helper' as probe
where exists (
  select 1 from public.successful_returns r
   where r.lost_post_id='cflr-lost'
     and r.found_post_id='cflr-found'
     and r.lost_owner_user_id='00000000-0000-4000-9700-000000000001'
     and r.helper_user_id='00000000-0000-4000-9700-000000000002'
     and r.external_helper=false
     and r.confirmed_by is not null
);

select 'L3 both linked reports are RECOVERED' as probe
where (select count(*) from public.item_posts
        where id in ('cflr-lost','cflr-found') and status='RECOVERED')=2;

select 'L4 two confirmations and two handovers exist for the match' as probe
where (select count(*) from public.match_confirmations where match_id=current_setting('cflr.match_a'))=2
  and (select count(*) from public.match_handovers where match_id=current_setting('cflr.match_a'))=2;

-- L9: a retry of a committed handover is idempotent.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select 'L9 a repeated handover still answers RECOVERED' as probe
where public.findback_handover_match(current_setting('cflr.match_a'))='RECOVERED';
reset role;

select 'L9b the repeat added no second recovery row' as probe
where (select count(*) from public.successful_returns where lost_post_id='cflr-lost')=1;

-- L10: a completed recovery is not cancellable.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$
begin
  perform public.findback_cancel_match(current_setting('cflr.match_a'));
  insert into cflr_guard values ('L10','succeeded');
exception when others then
  insert into cflr_guard values ('L10', sqlstate);
end $$;
reset role;

select 'L10 cancelling a completed recovery is refused' as probe
where (select outcome from cflr_guard where label='L10')='P0001';

select 'L10b the refusal left the match and both reports untouched' as probe
where (select status from public.report_matches where id=current_setting('cflr.match_a'))='CONFIRMED'
  and (select count(*) from public.item_posts
        where id in ('cflr-lost','cflr-found') and status='RECOVERED')=2;

-- Scenario C: a confirmed link that has not been handed over.
insert into public.report_matches(id,lost_report_id,found_report_id,proposed_by)
values ('cflr2-match','cflr2-lost','cflr2-found','00000000-0000-4000-9700-000000000001');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select 'L7a first confirmation on the second pair is PARTIAL' as probe
where public.findback_confirm_match('cflr2-match')='PARTIAL';
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
select 'L7b second confirmation on the second pair is MATCHED' as probe
where public.findback_confirm_match('cflr2-match')='MATCHED';

-- L8: D25 must not desynchronize a linked report.
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$
begin
  perform public.findback_mark_recovered('cflr2-lost','OUTSIDE');
  insert into cflr_guard values ('L8','succeeded');
exception when others then
  insert into cflr_guard values ('L8', sqlstate);
end $$;
reset role;

select 'L8 D25 refuses a report inside a confirmed link' as probe
where (select outcome from cflr_guard where label='L8')='P0001';

select 'L8b the refused call left the linked pair MATCHED with no recovery row' as probe
where (select count(*) from public.item_posts
        where id in ('cflr2-lost','cflr2-found') and status='MATCHED')=2
  and not exists (select 1 from public.successful_returns where lost_post_id='cflr2-lost');

-- L11: the shipped status RPC must not fabricate a linked lifecycle.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$
begin
  perform public.findback_change_post_status_client('cflr2-lost','RECOVERED');
  insert into cflr_guard values ('L11','succeeded');
exception when others then
  insert into cflr_guard values ('L11', sqlstate);
end $$;
reset role;

select 'L11 the generic status writer refuses a linked report' as probe
where (select outcome from cflr_guard where label='L11')='P0001';

select 'L11b the refused status write changed nothing' as probe
where (select count(*) from public.item_posts
        where id in ('cflr2-lost','cflr2-found') and status='MATCHED')=2
  and not exists (select 1 from public.successful_returns where lost_post_id='cflr2-lost');

-- L12: the status column must not be writable behind the RPC's back.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$
declare v_count integer;
begin
  update public.item_posts set status='RECOVERED' where id='cflr2-lost';
  get diagnostics v_count = row_count;
  insert into cflr_guard values ('L12', 'rows=' || v_count);
exception when others then
  insert into cflr_guard values ('L12', sqlstate);
end $$;
reset role;

select 'L12 a direct status update is refused' as probe
where (select outcome from cflr_guard where label='L12')='42501';

select 'L12b the refused direct update changed nothing' as probe
where (select status from public.item_posts where id='cflr2-lost')='MATCHED'
  and not exists (select 1 from public.successful_returns where lost_post_id='cflr2-lost');

-- L17: an API-created report cannot start matched or recovered.
--
-- Owner A already holds four reports dated today, so the daily interaction
-- limit would refuse a fifth with P0001 before the lifecycle guard ran. The
-- outsider account has no reports, which makes the lifecycle guard the only
-- possible refusal, and the assertion checks the guard's own message rather
-- than just the SQLSTATE.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000003',true);
do $$
begin
  insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
  values ('cflr6-born-recovered','00000000-0000-4000-9700-000000000003','LOST','Born','Synthetic','Other','RECOVERED','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z');
  insert into cflr_guard values ('L17','inserted');
exception when others then
  insert into cflr_guard values ('L17', sqlstate || ' / ' || sqlerrm);
end $$;
do $$
begin
  insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
  values ('cflr6-born-matched','00000000-0000-4000-9700-000000000003','LOST','Born','Synthetic','Other','MATCHED','2026-10-25','2026-10-25T00:00:00.000Z','2026-10-25T00:00:00.000Z');
  insert into cflr_guard values ('L17b','inserted');
exception when others then
  insert into cflr_guard values ('L17b', sqlstate || ' / ' || sqlerrm);
end $$;
reset role;

select 'L17 an API-created report cannot start recovered' as probe
where (select outcome from cflr_guard where label='L17')
        like '22023 / A report cannot be created already matched or recovered%'
  and not exists (select 1 from public.item_posts where id='cflr6-born-recovered');

select 'L17b an API-created report cannot start matched' as probe
where (select outcome from cflr_guard where label='L17b')
        like '22023 / A report cannot be created already matched or recovered%'
  and not exists (select 1 from public.item_posts where id='cflr6-born-matched');

-- L18: RECOVERED is never a status write, even on an unlinked report.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$
begin
  perform public.findback_change_post_status_client('cflr5-lost','RECOVERED');
  insert into cflr_guard values ('L18','succeeded');
exception when others then
  insert into cflr_guard values ('L18', sqlstate);
end $$;
reset role;

select 'L18 the status seam refuses RECOVERED on an unlinked report' as probe
where (select outcome from cflr_guard where label='L18')='P0001';

select 'L18b the refused RECOVERED left no recovery row and no status change' as probe
where (select status from public.item_posts where id='cflr5-lost')='OPEN'
  and not exists (select 1 from public.successful_returns where lost_post_id='cflr5-lost');

-- L13: the Wrong match action reopens a confirmed link before recovery.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$
begin
  perform public.findback_cancel_match('cflr2-match');
  insert into cflr_guard values ('L13','cancelled');
exception when others then
  insert into cflr_guard values ('L13', sqlstate);
end $$;
reset role;

select 'L13 a confirmed link can be cancelled before recovery' as probe
where (select outcome from cflr_guard where label='L13')='cancelled';

select 'L13b cancelling reopens both reports and keeps the consent history' as probe
where (select status from public.report_matches where id='cflr2-match')='CANCELLED'
  and (select count(*) from public.item_posts
        where id in ('cflr2-lost','cflr2-found') and status='OPEN')=2
  and (select count(*) from public.match_confirmations where match_id='cflr2-match')=2;

-- L16: a cancelled pair can be proposed again with a new identity.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$
begin
  perform public.findback_propose_match('cflr2-lost','cflr2-found');
  insert into cflr_guard values ('L16','ok');
exception when others then
  insert into cflr_guard values ('L16', sqlstate);
end $$;
reset role;

select 'L16 a cancelled pair can be proposed again' as probe
where (select outcome from cflr_guard where label='L16')='ok';

select 'L16b the new proposal is a distinct active row' as probe
where (select count(*) from public.report_matches
        where lost_report_id='cflr2-lost' and found_report_id='cflr2-found')=2
  and (select count(*) from public.report_matches
        where lost_report_id='cflr2-lost' and found_report_id='cflr2-found' and status='PENDING')=1;

-- L13c: with the link gone, ordinary status changes work again.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select 'L13c ordinary close works with only a pending proposal' as probe
where public.findback_change_post_status_client('cflr2-lost','CLOSED')=true;
reset role;

select 'L13d the ordinary close was applied' as probe
where (select status from public.item_posts where id='cflr2-lost')='CLOSED';

-- L20: a non-status edit of a legacy MATCHED report still works.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select 'L20 editing a legacy MATCHED report still works' as probe
where public.findback_update_post_client('cflr3-lost', p_title => 'Umbrella edited')=true;
reset role;

select 'L20b the edit changed the title and left the status alone' as probe
where (select title from public.item_posts where id='cflr3-lost')='Umbrella edited'
  and (select status from public.item_posts where id='cflr3-lost')='MATCHED';

-- Scenario B: the hosted legacy shape — MATCHED, no match row — still recovers.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select 'L5 a legacy MATCHED report with no match row still recovers' as probe
where public.findback_mark_recovered('cflr3-lost','SELF_OR_PRIVATE') is not null;
reset role;

select 'L5b the legacy recovery wrote its row and status' as probe
where (select count(*) from public.successful_returns where lost_post_id='cflr3-lost')=1
  and (select status from public.item_posts where id='cflr3-lost')='RECOVERED';

-- L19: a completed D25 recovery cannot be reopened through the status seam.
-- The seam used to accept OPEN/CLOSED on a report that already had a recovery
-- row, which made the recovery relationship describe a report reading OPEN and
-- left RECOVERED unreachable afterwards (23505 from the recovery writer).
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
do $$
begin
  perform public.findback_change_post_status_client('cflr3-lost','OPEN');
  insert into cflr_guard values ('L19','succeeded');
exception when others then
  insert into cflr_guard values ('L19', sqlstate);
end $$;
reset role;

select 'L19 the status seam refuses to reopen a recovered report' as probe
where (select outcome from cflr_guard where label='L19')='P0001';

select 'L19b the refused reopen left the recovery and its status intact' as probe
where (select status from public.item_posts where id='cflr3-lost')='RECOVERED'
  and (select count(*) from public.successful_returns where lost_post_id='cflr3-lost')=1;

-- L19c: the terminal guard must not tell a stranger that a report was recovered.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000003',true);
do $$
begin
  perform public.findback_change_post_status_client('cflr3-lost','OPEN');
  insert into cflr_guard values ('L19c','succeeded');
exception when others then
  insert into cflr_guard values ('L19c', sqlstate);
end $$;
reset role;

select 'L19c a foreign report answers like any other foreign report' as probe
where (select outcome from cflr_guard where label='L19c')='42501';


-- L21: a D25 recovery closes a pending proposal on that report.
--
-- A proposal can never be confirmed once the report is RECOVERED, so leaving it
-- PENDING made confirm fail with an unrelated reason and left dead state on the
-- pair. The acknowledgement stays as CANCELLED history.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
select set_config('cflr.match_c', public.findback_propose_match('cflr7-lost','cflr7-found'), true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000001',true);
select 'L21 the owner recovers a report that has a pending proposal' as probe
where public.findback_mark_recovered('cflr7-lost','SELF_OR_PRIVATE') is not null;
reset role;

select 'L21b the pending proposal was closed, not left dangling' as probe
where (select status from public.report_matches where id=current_setting('cflr.match_c'))='CANCELLED'
  and (select count(*) from public.match_confirmations where match_id=current_setting('cflr.match_c'))=0
  and (select status from public.item_posts where id='cflr7-lost')='RECOVERED';

-- Scenario D: history survives deletion of the match row.
delete from public.report_matches where id=current_setting('cflr.match_a');

-- The retention columns do not exist before the repair. Read them through
-- dynamic SQL so a missing column is a reported failure (-1) instead of an
-- aborted transaction that would hide every later assertion.
create temp table cflr_durable(label text, n integer) on commit drop;

do $$
declare v integer;
begin
  execute 'select count(*) from public.match_confirmations
            where match_id_original = $1 and match_id is null'
    into v using current_setting('cflr.match_a');
  insert into cflr_durable values ('confirmations', v);
exception when undefined_column then
  insert into cflr_durable values ('confirmations', -1);
end $$;

do $$
declare v integer;
begin
  execute 'select count(*) from public.match_handovers
            where match_id_original = $1 and match_id is null'
    into v using current_setting('cflr.match_a');
  insert into cflr_durable values ('handovers', v);
exception when undefined_column then
  insert into cflr_durable values ('handovers', -1);
end $$;

do $$
declare v integer;
begin
  execute 'select (select count(distinct owner_id_original) from public.match_confirmations
                    where match_id_original = $1)
                + (select count(distinct owner_id_original) from public.match_handovers
                    where match_id_original = $1)'
    into v using current_setting('cflr.match_a');
  insert into cflr_durable values ('owners', v);
exception when undefined_column then
  insert into cflr_durable values ('owners', -1);
end $$;

select 'L6 confirmation history survives deletion of the match row' as probe
where (select n from cflr_durable where label='confirmations')=2;

select 'L6b handover history survives deletion of the match row' as probe
where (select n from cflr_durable where label='handovers')=2;

select 'L6c retained history keeps both original owner identifiers' as probe
where (select n from cflr_durable where label='owners')=4;

-- L22: the found side of a completed linked recovery stays terminal even after
-- the match row is deleted (the guard must not depend on the link).
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-9700-000000000002',true);
do $$
begin
  perform public.findback_change_post_status_client('cflr-found','OPEN');
  insert into cflr_guard values ('L22','succeeded');
exception when others then
  -- Record the message, not only the SQLSTATE: P0001 is also the link guard's
  -- code, and this assertion must be about the recovery guard.
  insert into cflr_guard values ('L22', sqlstate || ' / ' || sqlerrm);
end $$;
reset role;

select 'L22 the found side stays terminal without a match row' as probe
where (select outcome from cflr_guard where label='L22')
        like 'P0001 / This report is already recorded as recovered%'
  and (select status from public.item_posts where id='cflr-found')='RECOVERED'
  and (select count(*) from public.successful_returns where lost_post_id='cflr-lost')=1;

-- Scenario E: history survives deletion of a participant account.
--
-- Both set-null actions converge on the same row, so the foreign keys are
-- deferred: an immediate check re-validates match_id while the match row is
-- already gone and aborts the whole account deletion.
delete from public.users where id='00000000-0000-4000-9700-000000000001';

select 'L15 the participant account delete completed' as probe
where not exists (select 1 from public.users where id='00000000-0000-4000-9700-000000000001');

select 'L15b consent and handover history survived the account delete' as probe
where (select count(*) from public.match_confirmations where match_id_original=current_setting('cflr.match_a'))=2
  and (select count(*) from public.match_handovers where match_id_original=current_setting('cflr.match_a'))=2;

select 'L15c the surviving participant keeps a live owner reference' as probe
where (select count(*) from public.match_confirmations
        where match_id_original='cflr2-match' and match_id is null)=2
  and (select count(*) from public.match_confirmations
        where match_id_original='cflr2-match'
          and owner_id='00000000-0000-4000-9700-000000000002')=1
  and (select count(*) from public.match_confirmations
        where match_id_original='cflr2-match' and owner_id is null)=1;

rollback;
