/** READ-ONLY capability probe. This file deliberately has no reset/execute mode. */
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const PROJECT='nfjhpigbsyyoaaktfaev';
const REPOSITORY='sheikhti1205/Norfold';
const OWNER='sheikhti1205';
const TABLES=`account_deletion_fences account_sanctions admin_audit_log appeal_notifications appeals attachments bootstrap_admins chat_conversations chat_devices chat_external_wake_devices chat_external_wakes chat_mailbox chat_media_attachments chat_media_cleanup_queue chat_media_delivery_receipts chat_media_report_evidence chat_media_report_sources chat_member_state chat_message_audience chat_messages chat_preferences chat_state_audience chat_state_events comment_attachments comment_media_cleanup_queue comment_reactions comments content_reports device_tokens feedback item_posts match_confirmations match_handovers moderation_case_audits moderation_case_decisions notification_preferences notifications post_saves public_action_admissions push_reply_tokens ratings reactions report_match_occupancy report_matches return_ratings role_invitations successful_returns uploads user_blocks user_role_capabilities user_roles users verification_challenges`.split(' ');
const BUCKETS=new Map([['findback-images',true],['findback-comment-media',true],['findback-chat-media',false],['findback-chat-moderation-evidence',false]]);
const COUNTS=['auth_users','profiles','reports','messages','assigned_roles','bootstrap_offers','pending_offers','storage_objects','storage_buckets','versioned_objects','archived_objects','delete_markers','multipart_uploads','multipart_parts'];
const SQL=`select session_user as session_role,current_user as effective_role,
 current_setting('role') as selected_role,current_setting('transaction_read_only') as transaction_read_only,
 (select jsonb_agg(tablename order by tablename) from pg_catalog.pg_tables where schemaname='public') as public_tables,
 (select count(*) from auth.users) as auth_users,
 (select count(*) from public.users) as profiles,
 (select count(*) from public.item_posts) as reports,
 (select count(*) from public.chat_messages) as messages,
 (select count(*) from public.user_roles) as assigned_roles,
 (select count(*) from public.bootstrap_admins) as bootstrap_offers,
 (select count(*) from public.role_invitations where accepted_at is null and revoked_at is null) as pending_offers,
 (select count(*) from storage.objects) as storage_objects,
 (select count(*) from storage.buckets) as storage_buckets,
 not exists(select 1 from storage.buckets b where to_jsonb(b)->>'versioning_status' is distinct from 'DISABLED') as versioning_disabled,
 (select count(*) from storage.objects o where to_jsonb(o)->>'is_versioned'='true') as versioned_objects,
 (select count(*) from storage.objects o where to_jsonb(o)->>'archived_at' is not null) as archived_objects,
 (select count(*) from storage.objects o where to_jsonb(o)->>'is_delete_marker'='true') as delete_markers,
 (select count(*) from storage.s3_multipart_uploads) as multipart_uploads,
 (select count(*) from storage.s3_multipart_uploads_parts) as multipart_parts,
 (to_regprocedure('public.findback_accept_role_offer(text)') is not null
  and (select count(*) from information_schema.columns where table_schema='public' and table_name='bootstrap_admins' and column_name in ('claimed_by','claimed_at'))=2
  and not exists(select 1 from pg_catalog.pg_trigger where not tgisinternal and tgname in ('on_role_invitation_auth_user_created','on_role_invitation_auth_user_confirmed','on_role_invitation_profile_created')))
 as role_acceptance_present`;

class Rejected extends Error {constructor(code,checks){super(code);this.code=code;this.checks=checks;}}
const requireContract=(ok,code)=>{if(!ok)throw new Rejected(code);};
const count=n=>Number.isSafeInteger(n)&&n>=0;
function validContext(env,headSha){
 return env.GITHUB_ACTIONS==='true'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&
  env.GITHUB_REPOSITORY===REPOSITORY&&env.GITHUB_REF==='refs/heads/main'&&
  env.GITHUB_ACTOR===OWNER&&env.GITHUB_TRIGGERING_ACTOR===OWNER&&
  env.GITHUB_WORKFLOW_REF===`${REPOSITORY}/.github/workflows/product-fit-reset.yml@refs/heads/main`&&
  typeof env.GITHUB_SHA==='string'&&/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)&&headSha===env.GITHUB_SHA;
}
function validateSql(body){
 requireContract(Array.isArray(body)&&body.length===1&&body[0]&&typeof body[0]==='object','SQL_CONTRACT_REJECTED');
 const row=body[0];
 // Fixed keys/boolean comparisons only:diagnose refusals without relaying SQL values.
 const checks={session_role:row.session_role==='supabase_read_only_user',effective_role:row.effective_role==='supabase_read_only_user',
  selected_role:row.selected_role==='none',transaction_read_only:row.transaction_read_only==='on',
  public_tables:Array.isArray(row.public_tables)&&row.public_tables.length===TABLES.length&&[...row.public_tables].sort().every((name,i)=>name===TABLES[i]),
  counts:COUNTS.every(key=>count(row[key])),bucket_count:row.storage_buckets===4,
  versioning_flag:typeof row.versioning_disabled==='boolean',role_flag:typeof row.role_acceptance_present==='boolean'};
 if(!Object.values(checks).every(Boolean))throw new Rejected('SQL_CONTRACT_REJECTED',checks);
 return row;
}
async function json(response){try{return await response.json();}catch{throw new Rejected('RESPONSE_REJECTED');}}

/** Testable real gate/parser/reporting code; only HTTP is substituted by tests. */
export async function runPreflight({env,headSha,fetchImpl=fetch,emit=report=>console.log(JSON.stringify(report))}){
 try{
  requireContract(validContext(env,headSha),'CONTEXT_REJECTED');
  // Context is validated BEFORE any privileged environment reference is read.
  const token=env.SUPABASE_ACCESS_TOKEN,key=env.SUPABASE_SECRET_KEY;
  requireContract(typeof token==='string'&&token.length>0&&!/\s/.test(token)&&typeof key==='string'&&/^sb_secret_\S+$/.test(key),'CREDENTIALS_UNAVAILABLE');
  const request=async(url,options)=>{
   const response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!response.ok){await response.body?.cancel();throw new Rejected('HTTP_REJECTED');}
   return response;
  };
  const row=validateSql(await json(await request(`https://api.supabase.com/v1/projects/${PROJECT}/database/query/read-only`,{
   method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query:SQL}),
  })));
  const headers={apikey:key};
  const auth=await request(`https://${PROJECT}.supabase.co/auth/v1/admin/users?page=1&per_page=1`,{method:'GET',headers});
  // Count header is documented by Auth Admin. Do not decode user metadata.
  const total=auth.headers.get('X-Total-Count');
  await auth.body?.cancel();
  requireContract(total!==null&&/^(?:0|[1-9][0-9]*)$/.test(total)&&count(Number(total))&&Number(total)===row.auth_users,'AUTH_COUNT_REJECTED');
  const buckets=await json(await request(`https://${PROJECT}.supabase.co/storage/v1/bucket`,{method:'GET',headers}));
  requireContract(Array.isArray(buckets)&&buckets.length===4&&new Set(buckets.map(b=>b?.id)).size===4&&buckets.every(b=>b&&BUCKETS.has(b.id)&&b.public===BUCKETS.get(b.id)),'STORAGE_CONTRACT_REJECTED');
  const version=(await (await request(`https://${PROJECT}.supabase.co/storage/v1/version`,{method:'GET',headers})).text()).trim();
  requireContract(version==='1.84.25','STORAGE_CONTRACT_REJECTED');
  emit({status:'capabilities_observed',project:PROJECT,source_sha:env.GITHUB_SHA,destructive_ready:false,
   counts:{public_tables:53,...Object.fromEntries(COUNTS.map(name=>[name,row[name]]))},
   capabilities:{management_sql:true,auth_admin_list:true,storage_bucket_list:true},
   prerequisites:{role_acceptance_present:row.role_acceptance_present,storage_version:version,storage_versioning_disabled:row.versioning_disabled,storage_drain_verified:false},
   gates:['DESTRUCTIVE_COMMAND_NOT_IMPLEMENTED','MAINTENANCE_IDENTITY_UNVERIFIED','STORAGE_DRAIN_UNVERIFIED',...row.role_acceptance_present?[]:['ROLE_ACCEPTANCE_NOT_APPLIED']],
  });return 0;
 }catch(error){
  // Never serialize exceptions,API bodies,headers,environment or stack traces.
  emit({status:'failed',destructive_ready:false,error:error instanceof Rejected?error.code:'REQUEST_FAILED',
   ...error instanceof Rejected&&error.checks?{checks:error.checks}:{}});return 1;
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let headSha='';
 try{headSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* gate below refuses checkout failure */}
 process.exitCode=await runPreflight({env:process.env,headSha});
}
