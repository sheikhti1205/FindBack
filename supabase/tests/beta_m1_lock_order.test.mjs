// Local, real PostgreSQL locks: fence acquisition and an interleaved two-lock
// bulk edit/delete. A later refusal without a witnessed wait is not evidence.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {assertLocalDatabase} from '../../scripts/sql-behavior.mjs';
assertLocalDatabase(process.env);
const A='00000000-0000-4000-9872-000000000001';
const B='00000000-0000-4000-9872-000000000002';
const q=s=>`'${String(s).replaceAll("'","''")}'`;
function sql(command){
 const r=spawnSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-f','-'],{input:command,encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);return r.stdout.trim();
}
function tx(uid,command){return `begin;set local statement_timeout='10s';set local deadlock_timeout='200ms';${uid?`set local role authenticated;select set_config('request.jwt.claim.sub',${q(uid)},true);`:''}${command};commit;`;}
function start(command,name,marker='LOCK_HELD'){
 const child=spawn('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-f','-'],{stdio:['pipe','pipe','pipe'],timeout:15000,env:{...process.env,PGAPPNAME:name}});
 let out='',err='',resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
 child.stdout.on('data',d=>{out+=d;if(out.includes(marker))resolveReady();});
 child.stderr.on('data',d=>{err+=d;if(err.includes(marker))resolveReady();});
 const done=new Promise((resolve,reject)=>{
  child.on('error',e=>{rejectReady(e);reject(e);});
  child.on('close',(code,signal)=>{if(!out.includes(marker)&&!err.includes(marker))rejectReady(new Error(err||'marker absent'));resolve({code,signal,out,err});});
 });child.stdin.end(command);return {ready,done};
}
let sequence=0;
async function contend(uid,first,other,second,{marker='LOCK_HELD',pauseAfter=true}={}){
 const name=`beta-m1-order-${++sequence}`;
 const leader=start(tx(uid,`${first}${pauseAfter?';\n\\echo LOCK_HELD\nselect pg_sleep(1)':''}`),`${name}-leader`,marker);
 await leader.ready;
 const follower=start(tx(other,second),`${name}-follower`);
 let witnessed=false;
 for(let i=0;i<25;i++){
  if(sql(`select exists(select 1 from pg_stat_activity f join pg_stat_activity l on l.pid=any(pg_blocking_pids(f.pid))
   where f.application_name=${q(`${name}-follower`)} and l.application_name=${q(`${name}-leader`)} and f.wait_event_type='Lock')`)==='t'){witnessed=true;break;}
  await delay(20);
 }
 const [one,two]=await Promise.all([leader.done,follower.done]);
 assert.equal(one.signal,null,one.err);assert.equal(two.signal,null,two.err);
 return {one,two,witnessed};
}
sql(`insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
 values(${q(A)},'m1_order_a','m1_order_a@example.invalid','+8801987200001',1,now(),now()),
 (${q(B)},'m1_order_b','m1_order_b@example.invalid','+8801987200002',1,now(),now());`);
function pair(lane,{confirmed=false,handover=false}={}){
 sql(`insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,moderation_visibility,created_at,updated_at)
 values('m1order-${lane}-l',${q(A)},'LOST','Wallet','Blue wallet near station','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('m1order-${lane}-f',${q(B)},'FOUND','Wallet','Blue wallet near station','Other','OPEN',current_date,'PUBLISHED',now(),now());`);
 const mid=sql(tx(A,`select public.findback_propose_match('m1order-${lane}-l','m1order-${lane}-f')`)).split('\n').at(-1);
 if(confirmed||handover)sql(tx(B,`select public.findback_confirm_match(${q(mid)})`));
 if(handover)sql(tx(A,`select public.findback_handover_match(${q(mid)})`));
 return mid;
}
for(const operation of ['proposal','confirm','handover']){
 test(`begin-deletion acquisition wins against ${operation}, with a real lock-wait witness`,async()=>{
  let mid;
  if(operation==='proposal'){
   mid=pair('fence-proposal');sql(tx(A,`select public.findback_cancel_match(${q(mid)})`));
  }else mid=pair(`fence-${operation}`,{handover:operation==='handover'});
  const command=operation==='proposal'?"select public.findback_propose_match('m1order-fence-proposal-l','m1order-fence-proposal-f')":
   `select public.findback_${operation==='confirm'?'confirm':'handover'}_match(${q(mid)})`;
  try{
   const r=await contend(null,`select public.findback_begin_account_deletion(${q(A)})`,B,command);
   assert.equal(r.one.code,0,r.one.err);
   assert.ok(r.witnessed,`fence acquisition did not serialize ${operation}; follower outcome: ${r.two.code} ${r.two.err}`);
   assert.equal(r.two.code,3,r.two.err);assert.match(r.two.err,/Match unavailable/);
   if(operation==='confirm')assert.equal(sql(`select count(*) from public.match_confirmations where match_id=${q(mid)}`),'1');
   if(operation==='handover'){
    assert.equal(sql(`select count(*) from public.match_handovers where match_id=${q(mid)}`),'1');
    assert.equal(sql("select count(*) from public.successful_returns where lost_post_id='m1order-fence-handover-l'"),'0');
   }
  }finally{sql(`delete from public.account_deletion_fences where user_id=${q(A)}`);}
 });
}
test('direct service fence insertion also serializes final handover',async()=>{
 const mid=pair('direct-fence',{handover:true});
 try{
  const r=await contend(null,`set local role service_role;insert into public.account_deletion_fences(user_id) values(${q(A)})`,B,
   `select public.findback_handover_match(${q(mid)})`);
  assert.equal(r.one.code,0,r.one.err);assert.ok(r.witnessed,'legacy service fence insertion skipped lifecycle serialization');
  assert.equal(r.two.code,3,r.two.err);assert.match(r.two.err,/Match unavailable/);
  assert.equal(sql("select count(*) from public.successful_returns where lost_post_id='m1order-direct-fence-l'"),'0');
 }finally{sql(`delete from public.account_deletion_fences where user_id=${q(A)}`);}
});
test('begin-deletion wins against the declared-helper recovery writer',async()=>{
 pair('d25-fence');
 try{
  const r=await contend(null,`select public.findback_begin_account_deletion(${q(A)})`,A,
   "select public.findback_mark_recovered('m1order-d25-fence-l','SELF_OR_PRIVATE')");
  assert.equal(r.one.code,0,r.one.err);assert.ok(r.witnessed,'declared-helper recovery skipped acquisition fence');
  assert.equal(r.two.code,3,r.two.err);assert.match(r.two.err,/Recovery unavailable/);
  assert.equal(sql("select count(*) from public.successful_returns where lost_post_id='m1order-d25-fence-l'"),'0');
 }finally{sql(`delete from public.account_deletion_fences where user_id=${q(A)}`);}
});
for(const operation of ['status','cancel','handover','d25','edit','moderation']){
 test(`${operation} takes the lifecycle gate BEFORE any target report lock`,async()=>{
  const lane=`gate-${operation}`;
  const mid=pair(lane,{handover:operation==='handover'});
  if(operation==='moderation')sql(`insert into public.user_roles(user_id,role,granted_by,granted_at)
   values(${q(B)},'MODERATOR',${q(B)},now());insert into public.user_role_capabilities(user_id,capability,granted_by,granted_at)
   values(${q(B)},'content_hide',${q(B)},now());`);
  sql(`insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,moderation_visibility,created_at,updated_at)
   values('m1order-${lane}-z',${q(A)},'LOST','Gate witness','A witness report','Other','OPEN',current_date,'PUBLISHED',now(),now());`);
  const target=`m1order-${lane}-l`;
  const command=operation==='status'?`select public.findback_change_post_status_client(${q(target)},'CLOSED')`:
   operation==='cancel'?`select public.findback_cancel_match(${q(mid)})`:
   operation==='handover'?`select public.findback_handover_match(${q(mid)})`:
   operation==='d25'?`select public.findback_mark_recovered(${q(target)},'SELF_OR_PRIVATE')`:
   operation==='moderation'?`select public.findback_apply_moderation('POST',${q(target)},'HIDE','OTHER','Lock ordering proof')`:
   `select public.findback_update_post_client(${q(target)},p_title=>'Edited wallet')`;
  // The leader has a real unrelated report lock first; its second UPDATE must
  // not meet a follower already holding the target while waiting for the gate.
  const r=await contend(null,`update public.item_posts set title='First edit' where id='m1order-${lane}-z';
   \n\\echo LOCK_HELD\nselect pg_sleep(1);update public.item_posts set title='Second edit' where id=${q(target)}`,
   ['handover','moderation'].includes(operation)?B:A,command,{pauseAfter:false});
  assert.equal(r.one.code,0,r.one.err);assert.equal(r.two.code,0,r.two.err);
  assert.ok(r.witnessed,`${operation} did not wait for the unrelated report mutation gate`);
  if(operation==='moderation')assert.equal(sql(`select moderation_visibility from public.item_posts where id=${q(target)}`),'HIDDEN');
 });
}
test('negative control: removing the statement guard lets the invoker edit skip the lifecycle gate',async()=>{
 const lane='edit-negative';pair(lane);
 sql('alter table public.item_posts disable trigger trg_item_posts_order_lifecycle_update');
 try{
  const r=await contend(null,"update public.item_posts set title='Leader edit' where id='m1order-edit-negative-f'",A,
   "select public.findback_update_post_client('m1order-edit-negative-l',p_title=>'Follower edit')");
  assert.equal(r.one.code,0,r.one.err);assert.equal(r.two.code,0,r.two.err);
  assert.equal(r.witnessed,false,'negative control unexpectedly serialized unrelated edits');
  assert.equal(sql("select title from public.item_posts where id='m1order-edit-negative-l'"),'Follower edit');
 }finally{sql('alter table public.item_posts enable trigger trg_item_posts_order_lifecycle_update');}
});
test('final handover wins before begin-deletion, preserving one durable return and serialization',async()=>{
 const mid=pair('handover-first',{handover:true});
 try{
  const r=await contend(B,`select public.findback_handover_match(${q(mid)})`,null,`select public.findback_begin_account_deletion(${q(A)})`);
  assert.equal(r.one.code,0,r.one.err);assert.equal(r.two.code,0,r.two.err);
  assert.ok(r.witnessed,'fence acquired without waiting for in-flight handover');
  assert.equal(sql("select count(*) from public.successful_returns where lost_post_id='m1order-handover-first-l'"),'1');
 }finally{sql(`delete from public.account_deletion_fences where user_id=${q(A)}`);}
});
test('physical Z-before-A bulk type update and lexical deletion do not deadlock',async()=>{
 // Insert Z first to witness actual executor order, not assume a plan's order.
 sql(`insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,moderation_visibility,created_at,updated_at)
 values('m1order-bulk-z',${q(A)},'LOST','Z wallet','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()),
 ('m1order-bulk-a',${q(A)},'LOST','A wallet','Test','Other','OPEN',current_date,'PUBLISHED',now(),now());
 create function public.m1_order_pause_z() returns trigger language plpgsql as $$
 begin if new.id='m1order-bulk-z' then raise notice 'ROW_Z_LOCKED';perform pg_sleep(1);end if;return new;end $$;
 create trigger aa_m1_order_pause before update of type on public.item_posts for each row execute function public.m1_order_pause_z();`);
 try{
  const r=await contend(A,"set local enable_indexscan=off;set local enable_bitmapscan=off;update public.item_posts set type='FOUND' where id like 'm1order-bulk-%'",A,
   "select public.findback_delete_post_client('m1order-bulk-a')",{marker:'ROW_Z_LOCKED',pauseAfter:false});
  assert.ok(r.witnessed,'bulk edit/delete had no observed overlap');
  assert.equal(r.one.code,0,r.one.err);assert.equal(r.two.code,0,r.two.err);
  assert.equal(sql("select count(*) from public.item_posts where id='m1order-bulk-a'"),'0');
  assert.equal(sql("select type from public.item_posts where id='m1order-bulk-z'"),'FOUND');
 }finally{sql('drop trigger aa_m1_order_pause on public.item_posts;drop function public.m1_order_pause_z();');}
});
