import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertMediaAckPlan, assertMediaAckSnapshot } from './chat-media-ack-deployment.mjs';
const file = '20261106020000_chat_media_ack_void.sql';
const source = readFileSync(`supabase/migrations/${file}`, 'utf8');
test('only the tested media ACK migration may be pending', () => {
  assert.deepEqual(assertMediaAckPlan(`Would push: ${file}`), [file]);
  assert.deepEqual(assertMediaAckPlan('Remote database is up to date'), []);
  assert.throws(() => assertMediaAckPlan(`${file}\n20261106010000_norfold_device_list.sql`));
  assert.throws(() => assertMediaAckPlan('connection refused'));
});
test('live receipt requires the exact admitted void wrapper and authenticated-only ACL', () => {
  const row = { body: source.match(/\$\$([\s\S]*?)\$\$/)[1], result: 'void', migrated: true,
    security_definer: true, authenticated_execute: true, anon_execute: false, service_execute: false,
    config: ['search_path=public, pg_temp'] };
  assert.doesNotThrow(() => assertMediaAckSnapshot(row, source));
  for (const bad of [{ result: 'integer' }, { body: 'different' }, { migrated: false },
    { authenticated_execute: false }, { anon_execute: true }, { service_execute: true }, { config: [] }]) {
    assert.throws(() => assertMediaAckSnapshot({ ...row, ...bad }, source));
  }
});
