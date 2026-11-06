import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertHistoryPeerPlan, assertHistoryPeerSnapshot, historyPeerContracts } from './history-peer-deployment.mjs';
test('deployment authorizes only both accepted history migrations or an already-applied retry', () => {
  assert.equal(assertHistoryPeerPlan(historyPeerContracts.map(c => c.file).join('\n')).length, 2);
  assert.equal(assertHistoryPeerPlan('Remote database is up to date').length, 0);
  assert.throws(() => assertHistoryPeerPlan('20261106020000_chat_media_ack_void.sql'));
  assert.throws(() => assertHistoryPeerPlan('unrecognized CLI output'));
});
test('live acceptance requires exact bodies, migration tracking and endpoint/internal grants', () => {
  const rows=historyPeerContracts.map(c => {
    const source=readFileSync(new URL(`../supabase/migrations/${c.file}`, import.meta.url),'utf8');
    const body=source.split(`create function public.${c.name}(`)[1].match(/\$\$([\s\S]*?)\$\$/)[1];
    return {name:c.name,body,migrated:true,security_definer:true,config:['search_path=public, pg_temp'],
      authenticated_execute:c.public,anon_execute:false,service_execute:false};
  });
  assertHistoryPeerSnapshot(rows);
  for(const field of ['body','migrated','security_definer','authenticated_execute','anon_execute','service_execute']){
    const bad=structuredClone(rows);bad[0][field]=field==='body'?'different':!bad[0][field];
    assert.throws(() => assertHistoryPeerSnapshot(bad));
  }
  assert.throws(()=>assertHistoryPeerSnapshot(rows.slice(1)));
});
