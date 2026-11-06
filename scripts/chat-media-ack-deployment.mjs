// Narrow deployment guard and credential-brokered schema-only readback.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const FILE = '20261106020000_chat_media_ack_void.sql';
export function assertMediaAckPlan(text) {
  const files = [...new Set(text.match(/\d{14}_[a-zA-Z0-9_]+\.sql/g) ?? [])];
  if (files.some(file => file !== FILE) || (!files.length && !/Remote database is up to date/i.test(text))) {
    throw Error('Pending migration set is not the accepted media ACK repair');
  }
  return files;
}
export function assertMediaAckSnapshot(row, source) {
  const body = source.match(/\$\$([\s\S]*?)\$\$/)?.[1];
  if (!body || !row || row.body?.trim() !== body.trim() || row.result !== 'void' || !row.migrated
    || !row.security_definer || !row.authenticated_execute || row.anon_execute || row.service_execute
    || !row.config?.includes('search_path=public, pg_temp')) throw Error('Live media ACK contract mismatch');
}
async function main(args) {
  if (args[0] === '--plan') {
    const files = assertMediaAckPlan(readFileSync(args[1], 'utf8'));
    console.log(`PASS narrow migration plan: ${files.length ? FILE : 'already applied'}`); return;
  }
  if (args[0] !== '--verify') throw Error('Expected --plan <output> or --verify');
  const ref = process.env.PROJECT_REF, token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!/^[a-z]{20}$/.test(ref ?? '') || !token) throw Error('Missing backend deployment broker configuration');
  const query = `select p.prosrc as body,p.prosecdef as security_definer,p.proconfig as config,
    pg_get_function_result(p.oid) as result,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute,
    exists(select 1 from supabase_migrations.schema_migrations where version='20261106020000') as migrated
    from pg_proc p where p.oid='public.findback_ack_chat_media_delivery(text,text,text)'::regprocedure`;
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Error('Schema readback failed');
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('Unexpected schema readback shape');
  assertMediaAckSnapshot(rows[0], readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), 'utf8'));
  console.log('PASS live media ACK migration tracked; exact admitted void body, security-definer/search-path/authenticated-only ACL verified');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => {
  console.error('Media ACK deployment guard/readback failed; no other migration is authorized'); process.exitCode = 1;
});
