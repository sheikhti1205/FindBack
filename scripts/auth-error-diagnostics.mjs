/** Owner-only, read-only Auth log classification. Never returns raw log text. */
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const repo='sheikhti1205/Norfold',owner='sheikhti1205',project='nfjhpigbsyyoaaktfaev';
const categories=['invalid_client','invalid_grant','redirect_mismatch','pkce_failure','oauth_state_failure','database_failure','identity_conflict','provider_exchange_failure','other_auth_error'];
const sql=`select category, count(*) as count, max(timestamp) as latest from (
 select timestamp, case
 when positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'invalid_client') > 0 then 'invalid_client'
 when positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'invalid_grant') > 0 then 'invalid_grant'
 when positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'redirect_uri_mismatch') > 0 then 'redirect_mismatch'
 when positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'code verifier') > 0 or positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'pkce') > 0 then 'pkce_failure'
 when positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'flow state') > 0 or positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'bad_oauth_state') > 0 then 'oauth_state_failure'
 when positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'database error') > 0 or positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'duplicate key') > 0 then 'database_failure'
 when positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'identity_already_exists') > 0 or positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'email_exists') > 0 then 'identity_conflict'
 when positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'exchange external code') > 0 then 'provider_exchange_failure'
 else 'other_auth_error' end as category
 from logs where source = 'auth_logs' and (
 positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'error') > 0 or
 positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'failure') > 0 or
 positionCaseInsensitive(concat(event_message,toString(log_attributes)), 'unable to exchange') > 0)
) group by category order by latest desc limit 20`;
class Refused extends Error { constructor(code){super(code);this.code=code;} }
const requireThat=(ok,code)=>{if(!ok)throw new Refused(code);};
export async function runAuthDiagnostics({env,headSha,fetchImpl=fetch,emit=r=>console.log(JSON.stringify(r))}) {
 try {
  requireThat(env.GITHUB_ACTIONS==='true'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REPOSITORY===repo&&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_ACTOR===owner&&env.GITHUB_TRIGGERING_ACTOR===owner&&env.GITHUB_WORKFLOW_REF===`${repo}/.github/workflows/auth-diagnostics.yml@refs/heads/main`&&/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??'')&&headSha===env.GITHUB_SHA,'CONTEXT_REJECTED');
  const token=env.SUPABASE_ACCESS_TOKEN;
  requireThat(typeof token==='string'&&token.length>0&&!/\s/.test(token),'CREDENTIAL_UNAVAILABLE');
  const end=new Date(),start=new Date(end.getTime()-2*60*60*1000);
  const url=new URL(`https://api.supabase.com/v1/projects/${project}/analytics/endpoints/logs`);
  url.searchParams.set('sql',sql);url.searchParams.set('iso_timestamp_start',start.toISOString());url.searchParams.set('iso_timestamp_end',end.toISOString());
  const response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok){await response.body?.cancel();throw new Refused(`HTTP_${response.status}`);}
  const body=await response.json();requireThat(!body.error&&Array.isArray(body.result),'QUERY_REJECTED');
  const errors=body.result.map(row=>{
   requireThat(categories.includes(row.category)&&/^[0-9]+$/.test(String(row.count))&&Number.isSafeInteger(Number(row.count))&&typeof row.latest==='string'&&/^[0-9TZ:. +-]+$/.test(row.latest)&&Number.isFinite(Date.parse(row.latest)),'RESULT_REJECTED');
   return {category:row.category,count:Number(row.count),latest:row.latest};
  });
  emit({status:'observed',source_sha:headSha,window_start:start.toISOString(),window_end:end.toISOString(),errors});return 0;
 }catch(error){emit({status:'failed',error:error instanceof Refused?error.code:'REQUEST_FAILED'});return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let headSha='';try{headSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* Context check refuses a missing checkout. */}
 process.exitCode=await runAuthDiagnostics({env:process.env,headSha});
}
