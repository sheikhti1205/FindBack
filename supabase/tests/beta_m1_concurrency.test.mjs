// Exact local PostgreSQL two-session proofs. No network broker credentials,
// install, simulated locks or passing source-text assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLocalDatabase, runPsql, splitSql } from '../../scripts/sql-behavior.mjs';

assertLocalDatabase(process.env);
const A='00000000-0000-4000-9863-000000000001';
const B='00000000-0000-4000-9863-000000000002';
const quote=(s)=>`'${String(s).replaceAll("'","''")}'`;
function sql(command) {
  const r=spawnSync('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-f','-'],
    {input:command,encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr); return r.stdout.trim();
}
function owner(uid,command) {
  if(uid===null)return `begin;${command};commit;`; // local service/profile deletion road
  return `begin; set local role authenticated; select set_config('request.jwt.claim.sub',${quote(uid)},true); ${command}; commit;`;
}
function start(command,applicationName) {
  const child=spawn('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-f','-'],
    {stdio:['pipe','pipe','pipe'],timeout:15000,env:{...process.env,PGAPPNAME:applicationName}});
  let out='',err=''; let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  // Consume a rejection even if process fails before the caller waits on ready.
  ready.catch(()=>{});
  child.stdout.on('data',(data)=>{out+=data.toString();if(out.includes('LOCK_HELD'))readyResolve();});
  child.stderr.on('data',(data)=>{err+=data.toString();});
  const done=new Promise((resolve,reject)=>{
    child.on('error',(error)=>{readyReject(error);reject(error);});
    child.on('close',(code,signal)=>{
      if(!out.includes('LOCK_HELD'))readyReject(new Error(err||'Leader exited before marker'));
      resolve({code,signal,out,err});
    });
  });
  child.stdin.end(command); return {ready,done};
}
let raceNumber=0;
async function race(uid,leaderCommand,otherUid,otherCommand) {
  const name=`beta-m1-race-${++raceNumber}`;
  const leader=start(owner(uid,`${leaderCommand};\n\\echo LOCK_HELD\nselect pg_sleep(1)`),`${name}-leader`);
  await leader.ready;
  const follower=start(owner(otherUid,otherCommand),`${name}-follower`);
  // Bounded test synchronization, not completion polling: independently observe
  // PostgreSQL reporting the actual follower blocked by THIS leader. Merely
  // starting two processes or a later refusal would not prove a race occurred.
  let witnessed=false;
  for(let attempt=0;attempt<25;attempt++){
    if(sql(`select exists(select 1 from pg_stat_activity f join pg_stat_activity l
      on l.pid=any(pg_blocking_pids(f.pid)) where f.application_name=${quote(`${name}-follower`)}
      and l.application_name=${quote(`${name}-leader`)} and f.wait_event_type='Lock')`)==='t'){
      witnessed=true;break;
    }
    await delay(20);
  }
  const [first,second]=await Promise.all([leader.done,follower.done]);
  assert.ok(witnessed,'No PostgreSQL lock-wait witness: scenario is inconclusive');
  assert.equal(first.code,0,first.err);
  assert.equal(first.signal,null);
  assert.equal(second.signal,null,second.err);
  return second;
}
function pair(lane,{handover=false,owners=[A,B]}={}) {
  const [lostOwner,foundOwner]=owners;
  sql(`insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,moderation_visibility,created_at,updated_at)
    values('m1c-${lane}-l',${quote(lostOwner)},'LOST','Wallet','Wallet test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
          ('m1c-${lane}-f',${quote(foundOwner)},'FOUND','Wallet','Wallet test','Other','OPEN',current_date,'PUBLISHED',now(),now());`);
  const mid=sql(owner(lostOwner,`select public.findback_propose_match('m1c-${lane}-l','m1c-${lane}-f')`)).split('\n').at(-1);
  if(handover){
    sql(owner(foundOwner,`select public.findback_confirm_match(${quote(mid)})`));
    sql(owner(lostOwner,`select public.findback_handover_match(${quote(mid)})`));
  }
  return mid;
}
sql(`insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
 select '00000000-0000-4000-9863-'||lpad(n::text,12,'0'),
        'm1_race_'||n,'m1_race_'||n||'@example.invalid','+880198630000'||n,1,now(),now()
 from generate_series(1,6) n;`);

test('negative control: legacy unlocked status overwrites a concurrent confirmed pair',async()=>{
  const legacy=splitSql(readFileSync('supabase/migrations/20261025020000_cf050_linked_recovery.sql','utf8'))
    .find((s)=>/^create or replace function public.findback_change_post_status_client\(/i.test(s));
  const current=splitSql(readFileSync('supabase/migrations/20261029040000_beta_m1_lifecycle.sql','utf8'))
    .find((s)=>/^create or replace function public.findback_change_post_status_client\(/i.test(s));
  assert.ok(legacy&&current);
  runPsql(`${legacy};`);
  try {
    const mid=pair('negative');
    const follower=await race(B,`select public.findback_confirm_match(${quote(mid)})`,A,
      "select public.findback_change_post_status_client('m1c-negative-l','CLOSED')");
    assert.equal(follower.code,0,follower.err);
    assert.equal(sql("select status from public.item_posts where id='m1c-negative-l'"),'CLOSED');
    assert.equal(sql(`select status from public.report_matches where id=${quote(mid)}`),'CONFIRMED');
  } finally {
    runPsql(`${current};`);
    sql("delete from public.item_posts where id in ('m1c-negative-l','m1c-negative-f')");
  }
});

test('locked status sees committed confirmation and refuses overwrite',async()=>{
  const mid=pair('status');
  const follower=await race(B,`select public.findback_confirm_match(${quote(mid)})`,A,
    "select public.findback_change_post_status_client('m1c-status-l','CLOSED')");
  assert.equal(follower.code,3,follower.err);
  assert.match(follower.err,/part of a match/);
  assert.equal(sql("select count(*) from public.item_posts where id in ('m1c-status-l','m1c-status-f') and status='MATCHED'"),'2');
});

test('opposing participant deletes preserve cancelled history without deadlock',async()=>{
  const mid=pair('opposing');
  sql(owner(B,`select public.findback_confirm_match(${quote(mid)})`));
  const follower=await race(A,"select public.findback_delete_post_client('m1c-opposing-l')",B,
    "select public.findback_delete_post_client('m1c-opposing-f')");
  assert.equal(follower.code,0,follower.err);
  assert.equal(sql(`select status from public.report_matches where id=${quote(mid)}`),'CANCELLED');
  assert.equal(sql(`select count(*) from public.report_match_occupancy where match_id=${quote(mid)}`),'0');
  assert.equal(sql(`select count(*) from public.match_confirmations where match_id=${quote(mid)}`),'2');
});

test('confirm then delete reopens only surviving matched report',async()=>{
  const mid=pair('confirmdelete');
  const follower=await race(B,`select public.findback_confirm_match(${quote(mid)})`,A,
    "select public.findback_delete_post_client('m1c-confirmdelete-l')");
  assert.equal(follower.code,0,follower.err);
  assert.equal(sql("select status from public.item_posts where id='m1c-confirmdelete-f'"),'OPEN');
  assert.equal(sql(`select cancel_reason from public.report_matches where id=${quote(mid)}`),'REPORT_DELETED');
});

test('delete then confirm refuses stale consent without resurrecting report',async()=>{
  const mid=pair('deleteconfirm');
  const follower=await race(A,"select public.findback_delete_post_client('m1c-deleteconfirm-l')",B,
    `select public.findback_confirm_match(${quote(mid)})`);
  assert.equal(follower.code,3,follower.err); assert.match(follower.err,/Match unavailable/);
  assert.equal(sql("select status from public.item_posts where id='m1c-deleteconfirm-f'"),'OPEN');
});

test('completed handover then delete preserves one return and recovered survivor',async()=>{
  const mid=pair('handoverdelete',{handover:true});
  const follower=await race(B,`select public.findback_handover_match(${quote(mid)})`,A,
    "select public.findback_delete_post_client('m1c-handoverdelete-l')");
  assert.equal(follower.code,0,follower.err);
  assert.equal(sql("select status from public.item_posts where id='m1c-handoverdelete-f'"),'RECOVERED');
  assert.equal(sql("select count(*) from public.successful_returns where found_post_id='m1c-handoverdelete-f'"),'1');
});

test('delete then handover refuses completion and preserves no false return',async()=>{
  const mid=pair('deletehandover',{handover:true});
  const follower=await race(A,"select public.findback_delete_post_client('m1c-deletehandover-l')",B,
    `select public.findback_handover_match(${quote(mid)})`);
  assert.equal(follower.code,3,follower.err); assert.match(follower.err,/Match unavailable/);
  assert.equal(sql("select status from public.item_posts where id='m1c-deletehandover-f'"),'OPEN');
  assert.equal(sql("select count(*) from public.successful_returns where found_post_id='m1c-deletehandover-f'"),'0');
});

test('account deletion wins against final handover with no false return or stale identity',async()=>{
  const c='00000000-0000-4000-9863-000000000003';
  const d='00000000-0000-4000-9863-000000000004';
  const mid=pair('account',{handover:true,owners:[c,d]});
  const follower=await race(null,`delete from public.users where id=${quote(c)}`,d,
    `select public.findback_handover_match(${quote(mid)})`);
  assert.equal(follower.code,3,follower.err);assert.match(follower.err,/Match unavailable/);
  assert.equal(sql("select status from public.item_posts where id='m1c-account-f'"),'OPEN');
  assert.equal(sql("select count(*) from public.successful_returns where found_post_id='m1c-account-f'"),'0');
  assert.equal(sql(`select count(*) from public.report_matches where id=${quote(mid)}
    and status='CANCELLED' and lost_owner_user_id is null and found_owner_user_id=${quote(d)}`),'1');
});

test('opposing account deletions retain relationship and acknowledgements without deadlock',async()=>{
  const e='00000000-0000-4000-9863-000000000005';
  const f='00000000-0000-4000-9863-000000000006';
  const mid=pair('accounts',{owners:[e,f]});
  sql(owner(f,`select public.findback_confirm_match(${quote(mid)})`));
  const follower=await race(null,`delete from public.users where id=${quote(e)}`,null,
    `delete from public.users where id=${quote(f)}`);
  assert.equal(follower.code,0,follower.err);
  assert.equal(sql(`select count(*) from public.report_matches where id=${quote(mid)}
    and status='CANCELLED' and lost_owner_user_id is null and found_owner_user_id is null`),'1');
  assert.equal(sql(`select count(*) from public.match_confirmations where match_id=${quote(mid)} and owner_id is null`),'2');
});
