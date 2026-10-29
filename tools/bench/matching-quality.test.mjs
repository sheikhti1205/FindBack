import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {symlink} from 'node:fs/promises';

const runner = new URL('./run-matching-quality.mjs', import.meta.url);
const item = (id, title = 'black umbrella') => ({id, title, description: 'wooden handle', category: 'Clothing', eventDate: null, locationLat: null, locationLng: null});
function dataset() {
  return {version: 'matching-quality-v1', cases: [{
    id: 'ordinary', language: 'en', origin: 'synthetic', labelSource: 'authored',
    target: item('lost'), candidates: [item('same'), item('noise', 'red scarf')], relevantIds: ['same'],
  }]};
}
async function run(doc, setup = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'matching-quality-test-'));
  try {
    await writeFile(join(dir, 'dataset.json'), JSON.stringify(doc));
    await setup(dir);
    const result = spawnSync(process.execPath, [runner.pathname, join(dir, 'dataset.json'), join(dir, 'report.json'), '--iterations=2'], {encoding: 'utf8'});
    const report = result.status === 0 ? JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) : null;
    return {...result, report};
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

test('runs the production text ranker and reports measured host resources, not model/device claims', async () => {
  const result = await run(dataset());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.groups[0].metrics.recallAt1, 1);
  assert.equal(result.report.groups[0].metrics.recallAt3, 1);
  assert.equal(result.report.groups[0].metrics.recallAt5, 1);
  assert.equal(result.report.rows[0].rankedIds[0], 'same');
  assert.equal(result.report.engine, 'text-structured');
  assert.equal(result.report.visualMatchingMeasured, false);
  assert.equal(result.report.realWorldEvidencePresent, false);
  assert.ok(result.report.resources.latencyMs.p95 >= 0);
  assert.ok(result.report.resources.sampledPeakRssBytes > 0);
  assert.equal(result.report.storage.photoBytes, 0);
});

test('reports unanswered queries as misses and keeps empty-ground-truth queries out of recall', async () => {
  const doc = dataset();
  doc.cases[0].target = item('lost', 'silver pen');
  doc.cases[0].target.description = 'engraved cap';
  doc.cases.push({...doc.cases[0], id: 'none-relevant', relevantIds: []});
  const result = await run(doc);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.groups[0].recallQueries, 1);
  assert.equal(result.report.groups[0].metrics.recallAt5, 0);
  assert.deepEqual(result.report.rows[0].rankedIds, []);
});

test('does not blend provenance or languages into a flattering combined quality score', async () => {
  const doc = dataset();
  doc.cases.push({...doc.cases[0], id: 'bangla', language: 'bn'});
  const result = await run(doc);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.groups.map(g => [g.origin, g.language]), [['synthetic', 'en'], ['synthetic', 'bn']]);
  assert.equal(result.report.metrics, undefined);
});

test('rejects duplicate/referenced-missing labels instead of inflating or silently lowering recall', async () => {
  for (const relevantIds of [['same', 'same'], ['missing']]) {
    const doc = dataset(); doc.cases[0].relevantIds = relevantIds;
    const result = await run(doc);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /relevantIds/);
  }
});

test('refuses fabricated phone/recovery provenance without verified item photo refs and label source', async () => {
  for (const origin of ['phone-observation', 'confirmed-recovery']) {
    const doc = dataset(); doc.cases[0].origin = origin;
    const result = await run(doc);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /labelSource|photos/);
  }
});

test('refuses remote/escaping photo paths before reading or sending any image', async () => {
  for (const path of ['../outside.jpg', '/etc/passwd', 'https://example.com/photo.jpg']) {
    const doc = dataset();
    doc.cases[0].photos = [{path, sha256: 'a'.repeat(64), sanitized: true, source: 'phone-camera'}];
    const result = await run(doc);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /photo path/);
  }
});

test('rejects empty datasets, invalid text fields and synthetic mapped scores', async () => {
  for (const change of [d => {d.cases = [];}, d => {d.cases[0].target.title = 12;}, d => {d.cases[0].candidates[0].mappedScore = .9;}]) {
    const doc = dataset(); change(doc);
    const result = await run(doc);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cases|title|mappedScore/);
  }
});

// Tiny test-only PNG, not a real phone photo or an evaluation-ground-truth case.
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const digest = createHash('sha256').update(image).digest('hex');
function photo(reportId, path = 'item.png', sha256 = digest) {
  return {reportId, path, sha256, sanitized: true, source: 'phone-camera'};
}
test('hash-checks supplied photo bytes, deduplicates storage, and retains attested provenance separately', async () => {
  const doc = dataset();
  doc.cases[0].origin = 'phone-observation';
  doc.cases[0].labelSource = 'observed-same-object';
  doc.cases[0].labelReference = 'test-only-label-not-a-real-observation';
  doc.cases[0].photos = ['lost','same','noise'].map(id => photo(id));
  const result = await run(doc, dir => writeFile(join(dir, 'item.png'), image));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.storage.photoFiles, 1);
  assert.equal(result.report.storage.photoBytes, image.length);
  assert.equal(result.report.groups[0].origin, 'phone-observation');
  assert.match(result.report.scope, /attestations/);
  assert.equal(result.report.visualMatchingMeasured, false);
});

test('refuses changed image bytes and symlinks escaping the private dataset root', async () => {
  const doc = dataset();
  doc.cases[0].photos = [photo('lost', 'item.png', 'a'.repeat(64))];
  let result = await run(doc, dir => writeFile(join(dir, 'item.png'), image));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sha256 mismatch/);
  doc.cases[0].photos = [photo('lost', 'link.png')];
  result = await run(doc, dir => symlink(process.execPath, join(dir, 'link.png')));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside dataset root/);
});
