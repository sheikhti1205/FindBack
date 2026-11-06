// Narrow accepted migration plan + brokered schema-only readback. No user data.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const AUTH='20261107010000_norfold_history_authority.sql';
const PEER='20261107020000_norfold_scoped_history_peers.sql';
export const historyPeerContracts=[
  {file:AUTH,name:'findback_chat_history_authority',args:'text,text,text,jsonb',public:true},
  {file:PEER,name:'findback_history_peer_context_internal',args:'uuid',public:false},
  {file:PEER,name:'findback_history_peer',args:'text,jsonb',public:true},
  {file:PEER,name:'findback_peer_history_authority',args:'uuid,jsonb',public:true},
];
export function assertHistoryPeerPlan(text){
  const files=[...new Set(text.match(/\d{14}_[a-zA-Z0-9_]+\.sql/g)??[])];
  if(files.some(f=>![AUTH,PEER].includes(f)) || (!files.length && !/Remote database is up to date/i.test(text)))
    throw Error('Pending migration set is not the accepted history repair');
  return files;
}
export function assertHistoryPeerSnapshot(rows){
  if(!Array.isArray(rows) || rows.length!==historyPeerContracts.length)throw Error('Incomplete schema readback');
  for(const c of historyPeerContracts){
    const row=rows.find(r=>r.name===c.name);
    const source=readFileSync(new URL(`../supabase/migrations/${c.file}`,import.meta.url),'utf8');
    const body=source.split(`create function public.${c.name}(`)[1]?.match(/\$\$([\s\S]*?)\$\$/)?.[1];
    if(!body || row?.body?.trim()!==body.trim() || !row.migrated || !row.security_definer
      || row.authenticated_execute!==c.public || row.anon_execute || row.service_execute
      || !row.config?.includes('search_path=public, pg_temp'))throw Error('Live history authority mismatch');
  }
}
async function main(args){
  if(args[0]==='--plan'){
    console.log(`PASS narrow history migration plan: ${assertHistoryPeerPlan(readFileSync(args[1],'utf8')).length} pending`);return;
  }
  if(args[0]!=='--verify')throw Error('Expected --plan <output> or --verify');
  const ref=process.env.PROJECT_REF,token=process.env.SUPABASE_ACCESS_TOKEN;
  if(!/^[a-z]{20}$/.test(ref??'') || !token)throw Error('Missing broker configuration');
  const query=historyPeerContracts.map(c=>`select '${c.name}' as name,p.prosrc as body,p.prosecdef as security_definer,p.proconfig as config,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute,
    exists(select 1 from supabase_migrations.schema_migrations where version='${c.file.slice(0,14)}') as migrated
    from pg_proc p where p.oid='public.${c.name}(${c.args})'::regprocedure`).join(' union all ');
  const response=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({query}),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw Error('Schema readback failed');
  assertHistoryPeerSnapshot(await response.json());
  console.log('PASS live history migrations tracked; all four exact function bodies, search paths and public/internal grants verified');
}
if(process.argv[1]===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(()=>{
  console.error('History deployment guard/readback failed; no other migration authorized');process.exitCode=1;
});
