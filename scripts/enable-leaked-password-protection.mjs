// Scoped Management API operation. Credentials/config bodies never reach output.
import { pathToFileURL } from 'node:url';

export async function enableProtection({ env=process.env, transport=fetch }={}) {
  const ref=env.PROJECT_REF;
  const token=env.SUPABASE_ACCESS_TOKEN;
  if (!/^[a-z]{20}$/.test(ref??'') || !token) return { status:'blocked', reason:'credential capability unavailable' };
  const url=`https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers={ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' };
  const options={headers,redirect:'error',signal:AbortSignal.timeout(30000)};
  try {
    const before=await transport(url,options);
    if (!before.ok) { await before.body?.cancel(); return {status:'blocked',http:before.status}; }
    if ((await before.json()).password_hibp_enabled!==true) {
      const patched=await transport(url,{...options,method:'PATCH',body:JSON.stringify({password_hibp_enabled:true})});
      if (!patched.ok) {
        // Classify a plan refusal without printing a Management API body.
        const text=await patched.text();
        const reason=/pro plan|paid plan|upgrade.*plan|plan.*required|requires.*pro/i.test(text)
          ? 'SUPABASE_PRO_PLAN_REQUIRED: upgrade in owner console, then rerun this action'
          : 'EXTERNAL OWNER-CONSOLE / ELIGIBLE PLAN ACTION REQUIRED';
        return {status:'blocked',http:patched.status,reason};
      }
      await patched.body?.cancel();
    }
    const after=await transport(url,{...options,signal:AbortSignal.timeout(30000)});
    if (!after.ok) { await after.body?.cancel(); return {status:'unverified',http:after.status}; }
    return (await after.json()).password_hibp_enabled===true
      ? {status:'verified',leaked_password_protection:true}
      : {status:'blocked',reason:'EXTERNAL OWNER-CONSOLE / ELIGIBLE PLAN ACTION REQUIRED'};
  } catch { return {status:'unverified',reason:'management request failed'}; }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const result=await enableProtection();console.log(JSON.stringify(result));
  process.exitCode=result.status==='verified'?0:1;
}
