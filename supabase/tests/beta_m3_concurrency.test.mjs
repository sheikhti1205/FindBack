// heavy-run only. Real disposable PostgreSQL, two bounded sessions per race;
// no hosted credentials, remote writes or source-text assertions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {assertLocalDatabase} from '../../scripts/sql-behavior.mjs';
assertLocalDatabase(process.env);
const uid=n=>`00000000-0000-4000-9703-${String(n).padStart(12,'0')}`;
const ADMIN=uid(1),REVIEWER=uid(2),OWNER=uid(3),OTHER=uid(4);
const q=s=>`'${String(s).replaceAll("'","''")}'`;
function sql(command){const r=spawnSync('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-f','-'],{input:command,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function asUser(user,command){return `begin; set local statement_timeout='10s'; ${user===null?'set local role service_role;':`set local role authenticated; select set_config('request.jwt.claim.sub',${q(user)},true);`} ${command};commit;`;}
function start(command,name){
  const child=spawn('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-f','-'],{stdio:['pipe','pipe','pipe'],timeout:15000,env:{...process.env,PGAPPNAME:name}});
  let out='',err='',readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
  child.stdout.on('data',data=>{out+=data;if(out.includes('LOCK_HELD'))readyResolve();});child.stderr.on('data',data=>{err+=data;});
  const done=new Promise((resolve,reject)=>{child.on('error',error=>{readyReject(error);reject(error);});child.on('close',(code,signal)=>{if(!out.includes('LOCK_HELD'))readyReject(new Error(err||'No leader marker'));resolve({code,signal,out,err});});});
  child.stdin.end(command);return {ready,done};
}
let count=0;
async function race(user,command,otherUser,otherCommand){
  const name=`beta-m3-race-${++count}`;
  const leader=start(asUser(user,`${command};\n\\echo LOCK_HELD\nselect pg_sleep(1)`),`${name}-leader`);await leader.ready;
  const follower=start(asUser(otherUser,otherCommand),`${name}-follower`);
  // This bounded synchronization observes actual PostgreSQL lock contention;
  // launching two processes alone or sequential stale refusal is insufficient.
  let witnessed=false;
  for(let attempt=0;attempt<25;attempt++){
    if(sql(`select exists(select 1 from pg_stat_activity f join pg_stat_activity l on l.pid=any(pg_blocking_pids(f.pid)) where f.application_name=${q(`${name}-follower`)} and l.application_name=${q(`${name}-leader`)} and f.wait_event_type='Lock')`)==='t'){witnessed=true;break;}await delay(20);
  }
  const [first,second]=await Promise.all([leader.done,follower.done]);
  assert.ok(witnessed,`${name}: no actual lock-wait witness (inconclusive)`);assert.equal(first.code,0,first.err);assert.equal(first.signal,null);assert.equal(second.signal,null,second.err);
  console.log(`${name}: witnessed follower lock blocked by leader`);return second;
}
function appeal(lane,owner=OWNER){
  const post=`m3c-${lane}`;
  sql(`insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at) values(${q(post)},${q(owner)},'LOST','Synthetic concurrent appeal','Synthetic fixture','Other','OPEN',current_date,now(),now());`);
  const audit=sql(asUser(ADMIN,`select public.findback_apply_moderation('POST',${q(post)},'HIDE','OTHER','Fixture')`)).split('\n').at(-1);
  const id=sql(asUser(owner,`select public.findback_submit_appeal('MODERATION_ACTION',${q(audit)},'Please review synthetic context')`)).split('\n').at(-1);
  return {id,post};
}
function feedback(lane,owner=OWNER){return sql(asUser(owner,`select public.findback_submit_feedback('BUG',${q(`Synthetic concurrent support ${lane}`)},false,null,null,null,null)`)).split('\n').at(-1);}
function assertOutcome(id,decision,visibility,post){
  assert.equal(sql(`select status||':'||decision from public.appeals where id=${q(id)}`),`RESOLVED:${decision}`);
  assert.equal(sql(`select count(*) from public.admin_audit_log where target_id=${q(id)} and action in ('APPEAL_RESOLVED','APPEAL_EXPIRED')`),'1');
  assert.equal(sql(`select count(*) from public.appeal_notifications where appeal_id=${q(id)}`),'1');
  assert.equal(sql(`select moderation_visibility from public.item_posts where id=${q(post)}`),visibility);
}
sql(`insert into public.users(id,username,email,phone,email_verified,created_at,updated_at) select '00000000-0000-4000-9703-'||lpad(n::text,12,'0'),'m3race'||n,'m3race'||n||'@example.invalid','+880197030000'||n,1,now(),now() from generate_series(1,6)n;
insert into public.user_roles(user_id,role,granted_at) values(${q(ADMIN)},'ADMIN',now()),(${q(REVIEWER)},'MODERATOR',now()),(${q(OTHER)},'MODERATOR',now());
insert into public.user_role_capabilities(user_id,capability,granted_at) select user_id,capability,now() from unnest(array[${q(REVIEWER)},${q(OTHER)}])user_id cross join unnest(array['appeals_review','feedback_read'])capability;`);

test('opposing appeal resolutions serialize and cannot reverse or notify twice',async()=>{
  const {id,post}=appeal('opposing');const before=Number(sql(`select count(*) from public.notifications where user_id=${q(OWNER)} and preview='Your appeal was granted.'`));
  const r=await race(REVIEWER,`select public.findback_resolve_appeal(${q(id)},'GRANTED','Original reversed')`,OTHER,`select public.findback_resolve_appeal(${q(id)},'DENIED','Opposing decision')`);
  assert.equal(r.code,3,r.err);assert.match(r.err,/APPEAL_ALREADY_RESOLVED/);assertOutcome(id,'GRANTED','PUBLISHED',post);
  assert.equal(Number(sql(`select count(*) from public.notifications where user_id=${q(OWNER)} and preview='Your appeal was granted.'`)),before+1);
});
test('expiry wins a waiting resolution with one system outcome and no reversal',async()=>{
  const {id,post}=appeal('expiry');sql(`update public.appeals set expires_at=clock_timestamp()-interval '1 day' where id=${q(id)}`);
  const r=await race(null,'select public.findback_expire_stale_appeals()',REVIEWER,`select public.findback_resolve_appeal(${q(id)},'GRANTED','Too late')`);
  assert.equal(r.code,3,r.err);assert.match(r.err,/APPEAL_ALREADY_RESOLVED/);assertOutcome(id,'EXPIRED','HIDDEN',post);
});
test('two expiry workers serialize without duplicated audits or notifications',async()=>{
  const {id,post}=appeal('expiryworkers');sql(`update public.appeals set expires_at=clock_timestamp()-interval '1 day' where id=${q(id)}`);
  const r=await race(null,'select public.findback_expire_stale_appeals()',null,'select public.findback_expire_stale_appeals()');
  assert.equal(r.code,0,r.err);assert.equal(r.out.trim(),'0');assertOutcome(id,'EXPIRED','HIDDEN',post);
});
test('feedback expected-status conflict retains one atomic transition and text-free audit',async()=>{
  const id=feedback('opposing');const r=await race(REVIEWER,`select public.findback_review_feedback(${q(id)},'REVIEWING','NEW','Private note A')`,OTHER,`select public.findback_review_feedback(${q(id)},'RESOLVED','NEW','Private note B')`);
  assert.equal(r.code,3,r.err);assert.match(r.err,/FEEDBACK_CHANGED/);
  assert.equal(sql(`select status||':'||admin_note from public.feedback where id=${q(id)}`),'REVIEWING:Private note A');
  assert.equal(sql(`select count(*) from public.admin_audit_log where target_id=${q(id)} and action='FEEDBACK_REVIEWED'`),'1');
  assert.equal(sql(`select count(*) from public.admin_audit_log where target_id=${q(id)} and (coalesce(reason,'')||previous_state::text||new_state::text)~'Private|Synthetic'`),'0');
});
test('role revocation is reauthorized after a waiting resolver acquires serialization',async()=>{
  const {id,post}=appeal('revoked');const r=await race(ADMIN,"select public.findback_role_revoke('m3race4@example.invalid')",OTHER,`select public.findback_resolve_appeal(${q(id)},'GRANTED','Revoked writer')`);
  assert.equal(r.code,3,r.err);assert.match(r.err,/may not review appeals/);
  assert.equal(sql(`select status from public.appeals where id=${q(id)}`),'SUBMITTED');assert.equal(sql(`select moderation_visibility from public.item_posts where id=${q(post)}`),'HIDDEN');
  assert.equal(sql(`select count(*) from public.admin_audit_log where target_id=${q(id)} and action='APPEAL_RESOLVED'`),'0');
});
test('notification failure rolls the whole grant back, then a real retry commits once',()=>{
  const {id,post}=appeal('fault');
  sql(`create function public.m3_fixture_fail_notice() returns trigger language plpgsql as $$begin if new.preview='Your appeal was granted.' then raise exception 'M3_FIXTURE_NOTICE_FAILURE'; end if;return new;end$$;create trigger m3_fixture_notice_failure before insert on public.notifications for each row execute function public.m3_fixture_fail_notice();`);
  try{
    const r=spawnSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-f','-'],{input:asUser(REVIEWER,`select public.findback_resolve_appeal(${q(id)},'GRANTED','Retryable fixture')`),encoding:'utf8',timeout:15000});
    assert.equal(r.status,3,r.stderr);assert.match(r.stderr,/M3_FIXTURE_NOTICE_FAILURE/);
    assert.equal(sql(`select status from public.appeals where id=${q(id)}`),'SUBMITTED');assert.equal(sql(`select moderation_visibility from public.item_posts where id=${q(post)}`),'HIDDEN');
    assert.equal(sql(`select count(*) from public.appeal_notifications where appeal_id=${q(id)}`),'0');assert.equal(sql(`select count(*) from public.admin_audit_log where target_id=${q(id)} and action='APPEAL_RESOLVED'`),'0');
  }finally{sql('drop trigger m3_fixture_notice_failure on public.notifications;drop function public.m3_fixture_fail_notice()');}
  sql(asUser(REVIEWER,`select public.findback_resolve_appeal(${q(id)},'GRANTED','Retry after delivery failure')`));assertOutcome(id,'GRANTED','PUBLISHED',post);
});
