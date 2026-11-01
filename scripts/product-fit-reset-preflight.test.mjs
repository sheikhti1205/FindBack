import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {runPreflight} from './product-fit-reset-preflight.mjs';

const SHA='a'.repeat(40),REF='nfjhpigbsyyoaaktfaev';
const TABLES=`users item_posts attachments comments reactions ratings verification_challenges uploads notifications device_tokens notification_preferences push_reply_tokens comment_reactions comment_attachments comment_media_cleanup_queue account_deletion_fences user_blocks post_saves user_roles user_role_capabilities admin_audit_log content_reports account_sanctions appeals successful_returns return_ratings feedback moderation_case_decisions moderation_case_audits public_action_admissions report_matches chat_conversations chat_messages chat_devices chat_mailbox appeal_notifications match_confirmations match_handovers chat_message_audience chat_state_events chat_state_audience chat_external_wakes chat_external_wake_devices chat_media_attachments chat_media_cleanup_queue chat_media_report_sources chat_media_report_evidence chat_media_delivery_receipts report_match_occupancy chat_member_state chat_preferences bootstrap_admins role_invitations`.split(' ');
function fixture(){
 const f={env:{GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'sheikhti1205/FindBack',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'sheikhti1205',GITHUB_TRIGGERING_ACTOR:'sheikhti1205',GITHUB_SHA:SHA,GITHUB_WORKFLOW_REF:'sheikhti1205/FindBack/.github/workflows/product-fit-reset.yml@refs/heads/main',SUPABASE_ACCESS_TOKEN:'synthetic_access_token',SUPABASE_SECRET_KEY:'sb_secret_'+'synthetic_project_key'},headSha:SHA,
  row:{session_role:'supabase_read_only_user',effective_role:'supabase_read_only_user',selected_role:'none',transaction_read_only:'on',public_tables:TABLES,auth_users:10,profiles:10,reports:6,messages:9,assigned_roles:2,bootstrap_offers:1,pending_offers:1,storage_objects:18,storage_buckets:4,versioning_disabled:true,versioned_objects:0,archived_objects:0,delete_markers:0,multipart_uploads:0,multipart_parts:0,role_acceptance_present:false},
  buckets:[{id:'findback-images',public:true},{id:'findback-comment-media',public:true},{id:'findback-chat-media',public:false},{id:'findback-chat-moderation-evidence',public:false}],
  version:'1.84.25',authHeader:'10',authReads:0,requests:[],output:[],override:undefined};
 f.fetchImpl=async(url,options)=>{
  f.requests.push({url,options});
  const override=await f.override?.(url,options);if(override)return override;
  if(url==='https://api.supabase.com/v1/projects/'+REF+'/database/query/read-only')return Response.json([f.row]);
  if(url===`https://${REF}.supabase.co/auth/v1/admin/users?page=1&per_page=1`){
   const r=new Response('synthetic private account metadata',{headers:f.authHeader===null?{}:{'X-Total-Count':f.authHeader}});
   r.json=r.text=async()=>{f.authReads++;throw Error('Auth body must not be decoded');};f.authResponse=r;return r;
  }
  if(url===`https://${REF}.supabase.co/storage/v1/bucket`)return Response.json(f.buckets);
  if(url===`https://${REF}.supabase.co/storage/v1/version`)return new Response(f.version);
  assert.fail('Unexpected endpoint');
 };
 f.emit=report=>f.output.push(report);return f;
}
test('preflight observes only read-only capability and reports no destructive readiness',async()=>{
 const f=fixture();assert.equal(await runPreflight(f),0);assert.equal(f.authReads,0);assert.equal(f.authResponse.bodyUsed,true);assert.equal(f.output.length,1);
 const r=f.output[0];assert.equal(r.status,'capabilities_observed');assert.equal(r.destructive_ready,false);assert.equal(r.source_sha,SHA);
 assert.deepEqual(r.counts,{public_tables:53,auth_users:10,profiles:10,reports:6,messages:9,assigned_roles:2,bootstrap_offers:1,pending_offers:1,storage_objects:18,storage_buckets:4,versioned_objects:0,archived_objects:0,delete_markers:0,multipart_uploads:0,multipart_parts:0});
 assert.deepEqual(r.gates,['DESTRUCTIVE_COMMAND_NOT_IMPLEMENTED','MAINTENANCE_IDENTITY_UNVERIFIED','STORAGE_DRAIN_UNVERIFIED','ROLE_ACCEPTANCE_NOT_APPLIED']);
 assert.deepEqual(r.capabilities,{management_sql:true,auth_admin_list:true,storage_bucket_list:true});
 assert.equal(f.requests.length,4);
 for(const {url,options} of f.requests){
  assert.equal(options.redirect,'error');assert.ok(options.signal);assert.equal(options.signal.aborted,false);
  if(url.startsWith('https://api.supabase.com/')){
   assert.equal(url,`https://api.supabase.com/v1/projects/${REF}/database/query/read-only`);
   assert.equal(options.method,'POST');const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['query']);assert.equal(typeof body.query,'string');assert.match(body.query,/^select\s/i);
   assert.doesNotMatch(body.query,/\b(?:insert|update|delete|truncate|alter|drop|create|set)\b/i);
   assert.equal(options.headers.Authorization,'Bearer '+f.env.SUPABASE_ACCESS_TOKEN);assert.equal(options.headers.apikey,undefined);
  }else{assert.equal(options.method,'GET');assert.equal(options.headers.apikey,f.env.SUPABASE_SECRET_KEY);assert.equal(options.headers.Authorization,undefined);assert.equal(options.body,undefined);}
 }
 assert.doesNotMatch(JSON.stringify(r),/synthetic|sb_secret_|private account|access_token/);
});
test('a present role prerequisite still cannot enable deletion or establish upload drain',async()=>{
 const f=fixture();f.row.role_acceptance_present=true;assert.equal(await runPreflight(f),0);
 assert.equal(f.output[0].destructive_ready,false);assert.deepEqual(f.output[0].gates,['DESTRUCTIVE_COMMAND_NOT_IMPLEMENTED','MAINTENANCE_IDENTITY_UNVERIFIED','STORAGE_DRAIN_UNVERIFIED']);
});
for(const [key,value] of Object.entries({GITHUB_ACTIONS:'false',GITHUB_EVENT_NAME:'push',GITHUB_REPOSITORY:'other/repo',GITHUB_REF:'refs/heads/other',GITHUB_ACTOR:'other',GITHUB_TRIGGERING_ACTOR:'other',GITHUB_SHA:'not-a-sha',GITHUB_WORKFLOW_REF:'other-workflow'})){
 test(`rejects ${key} before accessing credentials or network`,async()=>{
  const f=fixture();f.env[key]=value;Object.defineProperty(f.env,'SUPABASE_SECRET_KEY',{get(){return assert.fail('Credential accessed before context gate');}});
  assert.equal(await runPreflight(f),1);assert.equal(f.requests.length,0);assert.deepEqual(f.output,[{status:'failed',destructive_ready:false,error:'CONTEXT_REJECTED'}]);
 });
}
test('rejects a checkout that differs from the dispatched source',async()=>{const f=fixture();f.headSha='b'.repeat(40);assert.equal(await runPreflight(f),1);assert.equal(f.requests.length,0);});
for(const [key,value] of [['SUPABASE_ACCESS_TOKEN',''],['SUPABASE_SECRET_KEY',''],['SUPABASE_SECRET_KEY','sb_publishable_not_admin'],['SUPABASE_SECRET_KEY','sb_secret_ with whitespace']]){
 test(`refuses unavailable or wrong-kind ${key}`,async()=>{const f=fixture();f.env[key]=value;assert.equal(await runPreflight(f),1);assert.equal(f.requests.length,0);assert.equal(f.output[0].error,'CREDENTIALS_UNAVAILABLE');});
}
for(const [key,value] of [['session_role','authenticator'],['effective_role','service_role'],['session_role','postgres'],['effective_role','postgres'],['selected_role','authenticated'],['transaction_read_only','off'],['public_tables',[...TABLES,'unexpected']],['storage_buckets',5],['auth_users',-1],['profiles',1.5],['role_acceptance_present','true']]){
 test(`fails closed on SQL ${key} drift`,async()=>{const f=fixture();f.row[key]=value;assert.equal(await runPreflight(f),1);assert.equal(f.output[0].error,'SQL_CONTRACT_REJECTED');assert.equal(f.requests.length,1);});
}
for(const header of [null,'','ten','-1','10.5','9']){
 test(`rejects ambiguous or inconsistent Auth total ${header}`,async()=>{const f=fixture();f.authHeader=header;assert.equal(await runPreflight(f),1);assert.equal(f.authReads,0);assert.equal(f.output[0].error,'AUTH_COUNT_REJECTED');assert.equal(f.requests.length,2);});
}
for(const status of [302,401,403,429,500]){
 test(`sanitizes HTTP ${status} and never starts dependent requests`,async()=>{const f=fixture();f.override=()=>new Response('synthetic_email@example.invalid '+f.env.SUPABASE_SECRET_KEY,{status});assert.equal(await runPreflight(f),1);assert.deepEqual(f.output,[{status:'failed',destructive_ready:false,error:'HTTP_REJECTED'}]);assert.equal(f.requests.length,1);});
}
test('rejects malformed JSON without exposing the API body',async()=>{const f=fixture();f.override=()=>new Response('synthetic private SQL error');assert.equal(await runPreflight(f),1);assert.equal(f.output[0].error,'RESPONSE_REJECTED');assert.doesNotMatch(JSON.stringify(f.output),/private|SQL error/);});
test('sanitizes network exception including credentials and PII',async()=>{const f=fixture();f.override=()=>{throw Error('synthetic_email@example.invalid '+f.env.SUPABASE_SECRET_KEY);};assert.equal(await runPreflight(f),1);assert.equal(f.output[0].error,'REQUEST_FAILED');assert.doesNotMatch(JSON.stringify(f.output),/synthetic|sb_secret_|example.invalid/);});
test('rejects additional SQL rows and nonboolean capability responses',async()=>{const f=fixture();f.override=()=>Response.json([f.row,f.row]);assert.equal(await runPreflight(f),1);assert.equal(f.output[0].error,'SQL_CONTRACT_REJECTED');});
test('SQL rejection identifies the failed invariant using booleans only,without relaxing it',async()=>{
 const f=fixture();f.row.transaction_read_only='off';assert.equal(await runPreflight(f),1);
 assert.deepEqual(f.output,[{status:'failed',destructive_ready:false,error:'SQL_CONTRACT_REJECTED',checks:{
  session_role:true,effective_role:true,selected_role:true,transaction_read_only:false,public_tables:true,counts:true,bucket_count:true,versioning_flag:true,role_flag:true,
 }}]);assert.equal(f.requests.length,1);
});
test('untrusted SQL values cannot become diagnostic keys or values',async()=>{
 const f=fixture();f.row.session_role='synthetic_email@example.invalid';f.row.public_tables=[['sb','secret','private'].join('_')];f.row.auth_users='private-token';
 assert.equal(await runPreflight(f),1);assert.ok(Object.values(f.output[0].checks).every(v=>typeof v==='boolean'));
 assert.doesNotMatch(JSON.stringify(f.output),/synthetic|sb_secret_|private-token|example.invalid/);
});
for(const mutate of [f=>f.buckets.push({id:'unexpected',public:false}),f=>f.buckets[0].public=false,f=>f.buckets[0].id=f.buckets[1].id]){
 test('refuses unexpected,duplicate or privacy-drifted Storage bucket inventory',async()=>{const f=fixture();mutate(f);assert.equal(await runPreflight(f),1);assert.equal(f.output[0].error,'STORAGE_CONTRACT_REJECTED');});
}
test('refuses unsupported Storage version rather than assuming pinned source parity',async()=>{const f=fixture();f.version='1.99.0';assert.equal(await runPreflight(f),1);assert.equal(f.output[0].error,'STORAGE_CONTRACT_REJECTED');});
test('versioned or pending-upload counts stay visible and do not become destructive readiness',async()=>{const f=fixture();f.row.versioning_disabled=false;f.row.versioned_objects=1;f.row.multipart_uploads=1;assert.equal(await runPreflight(f),0);assert.equal(f.output[0].destructive_ready,false);assert.equal(f.output[0].counts.versioned_objects,1);assert.equal(f.output[0].counts.multipart_uploads,1);});
test('manual workflow is pinned,least-privileged and has no destructive/auto-deploy mode',async()=>{
 const w=await readFile(new URL('../.github/workflows/product-fit-reset.yml',import.meta.url),'utf8');
 assert.match(w,/on:\n {2}workflow_dispatch:\n/);assert.doesNotMatch(w,/^ {2}(?:push|pull_request|schedule|workflow_run|workflow_call|inputs):/m);
 assert.match(w,/permissions:\n {2}contents: read/);assert.match(w,/cancel-in-progress: false/);assert.match(w,/timeout-minutes: 5/);
 assert.match(w,/actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);assert.match(w,/actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
 assert.match(w,/persist-credentials: false/);assert.match(w,/ref: \$\{\{ github.sha \}\}/);assert.match(w,/node-version: ['"]22['"]/);
 assert.match(w,/github.actor/);assert.match(w,/github.triggering_actor/);assert.match(w,/github.ref/);assert.match(w,/github.repository/);assert.match(w,/github.event_name/);
 assert.equal((w.match(/secrets\.SUPABASE_ACCESS_TOKEN/g)??[]).length,1);assert.equal((w.match(/secrets\.SUPABASE_SECRET_KEY/g)??[]).length,1);
 const executor=w.indexOf('- name: Read-only capability and aggregate probe');assert.ok(executor>0);assert.doesNotMatch(w.slice(0,executor),/secrets\./);
 assert.match(w,/run: node scripts\/product-fit-reset-preflight\.mjs/);
 assert.doesNotMatch(w,/npm |npx |db push|apply_migration|deploy|--execute|upload-artifact/);
});
test('actual workflow shell admission refuses each wrong context before the secret step',async()=>{
 const w=await readFile(new URL('../.github/workflows/product-fit-reset.yml',import.meta.url),'utf8');
 const step=w.split('- name: Refuse unexpected dispatch context')[1].split('- name: Check out exact dispatch source')[0];
 const shell=step.split('run: |\n')[1].split('\n').map(line=>line.trim()).join('\n');
 const valid={event_name:'workflow_dispatch',repository:'sheikhti1205/FindBack',ref:'refs/heads/main',actor:'sheikhti1205',triggering_actor:'sheikhti1205'};
 const bindings=[...step.matchAll(/([A-Z_]+): \$\{\{ github\.([a-z_]+) \}\}/g)];assert.equal(bindings.length,5);
 const execute=context=>spawnSync('bash',['-e','-c',shell],{env:Object.fromEntries(bindings.map(([,envKey,contextKey])=>[envKey,context[contextKey]])),encoding:'utf8'}).status;
 assert.equal(execute(valid),0);
 for(const key of Object.keys(valid))assert.notEqual(execute({...valid,[key]:'unexpected'}),0,key);
});
test('no optional caller endpoint or SQL is used even when supplied',async()=>{
 const f=fixture();f.url='https://not-the-project.invalid';f.sql='truncate public.users';f.env.SUPABASE_URL=f.url;
 assert.equal(await runPreflight(f),0);assert.ok(f.requests.every(r=>!r.url.includes('not-the-project')));
 assert.doesNotMatch(f.requests[0].options.body,/truncate/);
});
for(const suffix of ['/auth/v1/admin/users?page=1&per_page=1','/storage/v1/bucket','/storage/v1/version']){
 test(`a downstream failure at ${suffix} cannot emit raw response data`,async()=>{
  const f=fixture();f.override=url=>url.endsWith(suffix)?new Response('synthetic_email@example.invalid',{status:403}):undefined;
  assert.equal(await runPreflight(f),1);assert.deepEqual(f.output,[{status:'failed',destructive_ready:false,error:'HTTP_REJECTED'}]);
 });
}
