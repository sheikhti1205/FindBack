import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitSql } from '../../scripts/sql-behavior.mjs';

const source = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const norm = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const baseline = source('20261011010000_reaction_notification_fix.sql');
const candidate = source('20261022173000_moderation_reports_sanctions_appeals.sql');
const helper = (sql) => splitSql(sql).find((s) => norm(s).startsWith('create or replace function public.findback_insert_notification('));
const expected = norm(helper(baseline)).replace("p_type <> 'status'", "p_type not in ('status', 'moderation')");
function guard(sql) {
  assert.notEqual(expected, norm(helper(baseline)), 'baseline actor predicate matched');
  assert.equal(norm(helper(sql)), expected, 'the sole executable delta is NULL-actor MODERATION support');
  assert.ok(splitSql(sql).map(norm).includes('revoke all on function public.findback_insert_notification(text, text, text, text, text, text, text) from public, anon, authenticated'));
}

describe('D2 preserves the effective notification helper', () => {
  it('retains kind-keyed REACTION dedupe and the internal-only ACL', () => guard(candidate));
  for (const [label, before, after] of [
    ['kind-keyed dedupe removed', "p_type <> 'REACTION'", 'true'],
    ['NULL-actor LIKE allowed', "('STATUS', 'MODERATION')", "('STATUS', 'MODERATION', 'LIKE')"],
    ['self notification guard removed', 'p_user_id is null or p_user_id = p_actor_id', 'p_user_id is null'],
  ]) it(`rejects ${label}`, () => {
    const mutated = candidate.replace(before, after);
    assert.notEqual(mutated, candidate, 'mutation matched');
    assert.throws(() => guard(mutated));
  });
});
