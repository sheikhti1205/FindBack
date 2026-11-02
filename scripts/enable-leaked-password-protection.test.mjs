import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enableProtection } from './enable-leaked-password-protection.mjs';
const env={PROJECT_REF:'nfjhpigbsyyoaaktfaev',SUPABASE_ACCESS_TOKEN:'synthetic-management'};
test('patches only leaked-password configuration and requires independent readback',async()=>{
  const calls=[];let enabled=false;
  const result=await enableProtection({env,transport:async(url,options)=>{
    calls.push({url,method:options.method??'GET'});
    if(options.method==='PATCH'){assert.deepEqual(JSON.parse(options.body),{password_hibp_enabled:true});enabled=true;}
    return Response.json({password_hibp_enabled:enabled,other_private_config:'never emitted'});
  }});
  assert.deepEqual(calls.map(c=>c.method),['GET','PATCH','GET']);
  assert.deepEqual(result,{status:'verified',leaked_password_protection:true});
});
test('plan/access rejection is a blocker, never a passing configuration',async()=>{
  let calls=0;
  const result=await enableProtection({env,transport:async()=>{
    calls++;return calls===1?Response.json({password_hibp_enabled:false}):new Response('private error',{status:403});
  }});
  assert.equal(result.status,'blocked');assert.equal(result.http,403);
  assert.equal(JSON.stringify(result).includes('private'),false);
});
