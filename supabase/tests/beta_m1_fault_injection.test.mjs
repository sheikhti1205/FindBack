// Execute the actual migration preflights and real unique-violation rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertLocalDatabase, runPsql, splitSql } from '../../scripts/sql-behavior.mjs';
assertLocalDatabase(process.env);
const A='00000000-0000-4000-9864-000000000001';
const B='00000000-0000-4000-9864-000000000002';
const C='00000000-0000-4000-9864-000000000003';
const q=(value)=>`'${String(value).replaceAll("'","''")}'`;
function sql(command){
  const r=spawnSync('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-f','-'],
    {input:command,encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr);return r.stdout.trim();
}
function owner(uid,command){
  return `begin;set local role authenticated;select set_config('request.jwt.claim.sub',${q(uid)},true);${command};commit;`;
}
sql(`insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
  values(${q(A)},'m1_fault_a','m1_fault_a@example.invalid','+8801986400001',1,now(),now()),
        (${q(B)},'m1_fault_b','m1_fault_b@example.invalid','+8801986400002',1,now(),now()),
        (${q(C)},'m1_fault_c','m1_fault_c@example.invalid','+8801986400003',1,now(),now());`);
function pair(lane){
  sql(`insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,moderation_visibility,created_at,updated_at)
    values('m1f-${lane}-l',${q(A)},'LOST','Wallet','Wallet test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
          ('m1f-${lane}-f',${q(B)},'FOUND','Wallet','Wallet test','Other','OPEN',current_date,'PUBLISHED',now(),now());`);
  return sql(owner(A,`select public.findback_propose_match('m1f-${lane}-l','m1f-${lane}-f')`)).split('\n').at(-1);
}

test('strict legacy consent preflight rejects an extra foreign acknowledgement without rewriting history',()=>{
  const mid=pair('legacy');
  sql(owner(B,`select public.findback_confirm_match(${q(mid)})`));
  const legacy=splitSql(readFileSync('supabase/migrations/20261029010000_cf050_admission_occupancy.sql','utf8'))
    .find((s)=>/^do \$\$/i.test(s)&&s.includes('v_msg text'));
  const strict=splitSql(readFileSync('supabase/migrations/20261029060000_beta_m1_deletion_retention.sql','utf8'))
    .find((s)=>/^do \$\$/i.test(s)&&s.includes('confirmed_consent_cardinality'));
  assert.ok(legacy&&strict);
  const injected=`insert into public.match_confirmations(match_id,match_id_original,owner_id,owner_id_original)
    values(${q(mid)},${q(mid)},${q(C)},${q(C)});`;
  // Old admission predates nullable historical report references. Constrain
  // BOTH preflights to this live test pair inside rollback-only transactions;
  // unrelated retained history must not decide the consent-cardinality result.
  const scope=`update public.report_matches set status='CANCELLED' where id<>${q(mid)};`;
  // Negative control: old preflight accepts both current owners PLUS foreign row.
  runPsql(`begin;${scope}${injected}${legacy};rollback;`);
  assert.throws(()=>runPsql(`begin;${scope}${injected}${strict};rollback;`),
    /M1 preflight failed closed: confirmed_consent_cardinality=1/);
  assert.equal(sql(`select count(*) from public.match_confirmations where match_id=${q(mid)}`),'2');
  assert.equal(sql(`select status from public.report_matches where id=${q(mid)}`),'CONFIRMED');
});

test('occupancy insert conflict rolls back tentative consent, first occupancy insert and report status',()=>{
  const target=pair('rollback'); const other=pair('occupier');
  // Inject a real unique-key collision on the SECOND occupancy row. The first
  // tentative occupancy and the accepting owner's acknowledgement must roll back.
  sql(`insert into public.report_match_occupancy(report_id,match_id) values('m1f-rollback-l',${q(other)});`);
  // Lexically the -f report is inserted first, then -l collides.
  assert.throws(()=>runPsql(owner(B,`select public.findback_confirm_match(${q(target)})`)),/MATCH_STATUS_CONFLICT/);
  assert.equal(sql(`select count(*) from public.match_confirmations where match_id=${q(target)}`),'1');
  assert.equal(sql(`select status from public.report_matches where id=${q(target)}`),'PENDING');
  assert.equal(sql(`select count(*) from public.report_match_occupancy where match_id=${q(target)}`),'0');
  assert.equal(sql("select count(*) from public.item_posts where id in ('m1f-rollback-l','m1f-rollback-f') and status='OPEN'"),'2');
  assert.equal(sql(`select match_id from public.report_match_occupancy where report_id='m1f-rollback-l'`),other);
  sql(`delete from public.report_match_occupancy where report_id='m1f-rollback-l';`);
  // Removing the injection must permit the SAME operation to complete exactly
  // once; otherwise a stale consent/status leak could be hidden by a refusal.
  assert.equal(sql(owner(B,`select public.findback_confirm_match(${q(target)})`)).split('\n').at(-1),'MATCHED');
  assert.equal(sql(`select count(*) from public.report_match_occupancy where match_id=${q(target)}`),'2');
});
