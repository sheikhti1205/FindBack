import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAuthDiagnostics} from './auth-error-diagnostics.mjs';
const sha='a'.repeat(40);
const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'sheikhti1205/Norfold',GITHUB_REF:'refs/heads/main',GITHUB_ACTOR:'sheikhti1205',GITHUB_TRIGGERING_ACTOR:'sheikhti1205',GITHUB_SHA:sha,GITHUB_WORKFLOW_REF:'sheikhti1205/Norfold/.github/workflows/auth-diagnostics.yml@refs/heads/main',SUPABASE_ACCESS_TOKEN:'disposable-fixture-only'};
test('queries only categorized recent Auth errors and emits no raw fields',async()=>{
 const reports=[];
 const code=await runAuthDiagnostics({env,headSha:sha,emit:r=>reports.push(r),fetchImpl:async(url,options)=>{
  const target=new URL(url);assert.equal(target.origin,'https://api.supabase.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  const sql=target.searchParams.get('sql');assert.match(sql,/source = 'auth_logs'/);assert.match(sql,/case/i);assert.doesNotMatch(sql,/select\s+\*/i);
  return Response.json({result:[{category:'invalid_client',count:2,latest:'2026-11-02T18:35:00Z',raw:'NEVER-EMIT-THIS'}]});
 }});
 assert.equal(code,0);assert.deepEqual(reports[0].errors,[{category:'invalid_client',count:2,latest:'2026-11-02T18:35:00Z'}]);assert(!JSON.stringify(reports).includes('NEVER-EMIT'));
});
test('refuses wrong context before accessing credentials or HTTP',async()=>{
 const reports=[];const wrong={...env,GITHUB_REF:'refs/heads/other'};Object.defineProperty(wrong,'SUPABASE_ACCESS_TOKEN',{get(){throw Error('credential accessed');}});
 assert.equal(await runAuthDiagnostics({env:wrong,headSha:sha,emit:r=>reports.push(r),fetchImpl:()=>{throw Error('HTTP reached');}}),1);
 assert.equal(reports[0].error,'CONTEXT_REJECTED');
});
test('query errors and unknown categories never print raw API responses',async()=>{
 for(const body of [{error:'SENSITIVE-RAW'},{result:[{category:'SENSITIVE-RAW',count:1,latest:'2026-11-02T18:35:00Z'}]}]){
  const reports=[];assert.equal(await runAuthDiagnostics({env,headSha:sha,emit:r=>reports.push(r),fetchImpl:async()=>Response.json(body)}),1);
  assert(!JSON.stringify(reports).includes('SENSITIVE'));
 }
});
