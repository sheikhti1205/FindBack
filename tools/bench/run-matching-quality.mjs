/** Offline Node >=22.18 text/structured quality harness; no model, network or build.
 * Inputs/photos are private, consented and sanitized. Never commit real reports.
 * Provenance/labels are supplied attestations, not independently verified events.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {rankTextMatches, recallAtK, MATCH_RESULT_LIMIT} from '../../apps/mobile/src/services/similarity.ts';

const [input, output, option = '--iterations=100'] = process.argv.slice(2);
assert.ok(input && output, 'usage: node tools/bench/run-matching-quality.mjs <private-dataset.json> <private-report.json> [--iterations=100]');
assert.match(option, /^--iterations=\d+$/, 'invalid iterations option');
const iterations = Number(option.split('=')[1]);
assert.ok(iterations >= 1 && iterations <= 1000, 'iterations must be 1..1000');
assert.notEqual(resolve(input), resolve(output), 'output cannot overwrite input');
const raw = await readFile(input);
const doc = JSON.parse(raw);
assert.equal(doc.version, 'matching-quality-v1', 'unsupported dataset version');
assert.ok(Array.isArray(doc.cases) && doc.cases.length > 0 && doc.cases.length <= 1000, 'cases must contain 1..1000 queries');

function nonempty(value) {return typeof value === 'string' && value.trim().length > 0 && value.length <= 20000;}
function validateItem(item) {
  assert.ok(item && nonempty(item.id), 'report id required');
  assert.ok(nonempty(item.title), 'title must be nonempty text');
  assert.ok(item.description == null || typeof item.description === 'string', 'description must be text');
  assert.ok(nonempty(item.category), 'category required');
  assert.ok(!('mappedScore' in item), 'mappedScore is not accepted: this harness computes actual text scores');
  if (item.eventDate != null) assert.ok(typeof item.eventDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.eventDate) && Number.isFinite(Date.parse(item.eventDate)), 'eventDate invalid');
  for (const [field, limit] of [['locationLat', 90], ['locationLng', 180]]) {
    assert.ok(item[field] == null || (Number.isFinite(item[field]) && Math.abs(item[field]) <= limit), `${field} invalid`);
  }
}
function localPhotoPath(path) {
  assert.ok(nonempty(path) && !isAbsolute(path) && !path.includes('\\') &&
    !path.split('/').includes('..') && !/^[a-z][a-z\d+.-]*:/i.test(path), 'photo path must be relative and local, without traversal');
}

const caseIds = new Set();
for (const row of doc.cases) {
  assert.ok(row && nonempty(row.id) && !caseIds.has(row.id), 'case ids must be unique');
  caseIds.add(row.id);
  assert.ok(['en', 'bn', 'banglish', 'mixed'].includes(row.language), 'language must be en/bn/banglish/mixed');
  assert.ok(['synthetic', 'phone-observation', 'confirmed-recovery'].includes(row.origin), 'invalid origin');
  validateItem(row.target);
  assert.ok(Array.isArray(row.candidates) && row.candidates.length > 0 && row.candidates.length <= 1000, 'candidates required, maximum 1000');
  const ids = new Set([row.target.id]);
  for (const item of row.candidates) {
    validateItem(item);
    assert.ok(!ids.has(item.id), 'duplicate report id within query');
    ids.add(item.id);
  }
  assert.ok(Array.isArray(row.relevantIds) && new Set(row.relevantIds).size === row.relevantIds.length &&
    row.relevantIds.every(id => id !== row.target.id && ids.has(id)), 'relevantIds must be unique candidate ids');
  assert.ok(row.photos == null || Array.isArray(row.photos), 'photos must be an array');
  for (const photo of row.photos ?? []) {
    localPhotoPath(photo.path);
    assert.match(photo.sha256 ?? '', /^[a-f0-9]{64}$/, 'photo sha256 required');
    assert.equal(photo.sanitized, true, 'photos must be sanitized item-only derivatives');
    assert.equal(photo.source, 'phone-camera', 'photo source must be attested phone-camera');
    assert.ok(ids.has(photo.reportId), 'photo reportId must name a report in this query');
  }
  if (row.origin === 'synthetic') {
    assert.equal(row.labelSource, 'authored', 'synthetic labelSource must be authored');
  } else {
    assert.equal(row.labelSource, row.origin === 'confirmed-recovery' ? 'successful-return' : 'observed-same-object', 'labelSource does not establish the declared origin');
    assert.ok(nonempty(row.labelReference), 'private labelReference required for observed cases');
    assert.ok([...ids].every(id => row.photos?.some(p => p.reportId === id)), 'photos required for each report in observed cases');
  }
}

// Verify all photo bytes before ranking. Resolve symlinks and enforce the same
// private dataset root; a relative filename alone does not establish confinement.
const root = await realpath(dirname(resolve(input)));
const seenPhotos = new Map();
for (const row of doc.cases) {
  for (const photo of row.photos ?? []) {
    const actual = await realpath(resolve(root, photo.path));
    const inside = relative(root, actual);
    assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), 'photo path resolves outside dataset root');
    const bytes = await readFile(actual);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), photo.sha256, 'photo sha256 mismatch');
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    assert.ok(jpeg || png || webp, 'photo must be a PNG/JPEG/WebP derivative');
    seenPhotos.set(actual, bytes.length);
  }
}

const rank = row => rankTextMatches(row.target, row.candidates, MATCH_RESULT_LIMIT);
const baseline = process.memoryUsage();
let sampledPeakRssBytes = baseline.rss, sampledPeakHeapUsedBytes = baseline.heapUsed;
for (const row of doc.cases) rank(row); // one untimed warm-up per query
const timings = [], rows = [];
for (const row of doc.cases) {
  let ranked;
  const queryTimes = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const start = performance.now();
    ranked = rank(row);
    queryTimes.push(performance.now() - start);
    const memory = process.memoryUsage();
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, memory.rss);
    sampledPeakHeapUsedBytes = Math.max(sampledPeakHeapUsedBytes, memory.heapUsed);
  }
  timings.push(...queryTimes);
  const rankedIds = ranked.map(match => match.post.id);
  rows.push({id: row.id, origin: row.origin, language: row.language,
    candidateCount: row.candidates.length,
    hardSameCategoryNegatives: row.candidates.filter(c => c.category === row.target.category && !row.relevantIds.includes(c.id)).length,
    relevantCount: row.relevantIds.length, rankedIds,
    metrics: row.relevantIds.length ? Object.fromEntries([1, 3, 5].map(k => [`recallAt${k}`, recallAtK(rankedIds, row.relevantIds, k)])) : null,
    meanLatencyMs: queryTimes.reduce((sum, value) => sum + value, 0) / iterations});
}
const groups = [];
for (const key of new Set(rows.map(row => `${row.origin}:${row.language}`))) {
  const group = rows.filter(row => `${row.origin}:${row.language}` === key);
  const labelled = group.filter(row => row.metrics !== null);
  groups.push({origin: group[0].origin, language: group[0].language, queries: group.length, recallQueries: labelled.length,
    noRelevantQueries: group.length - labelled.length,
    noRelevantQueriesWithSuggestions: group.filter(row => row.metrics === null && row.rankedIds.length > 0).length,
    metrics: labelled.length ? Object.fromEntries([1, 3, 5].map(k => [`recallAt${k}`, labelled.reduce((sum, row) => sum + row.metrics[`recallAt${k}`], 0) / labelled.length])) : null});
}
timings.sort((a, b) => a - b);
const quantile = p => timings[Math.max(0, Math.ceil(p * timings.length) - 1)];
const sources = [new URL(import.meta.url), new URL('../../apps/mobile/src/services/similarity.ts', import.meta.url)];
const sourceBytes = await Promise.all(sources.map(file => readFile(file)));
const report = {
  version: doc.version, recordedAt: new Date().toISOString(), datasetSha256: createHash('sha256').update(raw).digest('hex'),
  sourceSha256: sourceBytes.map(bytes => createHash('sha256').update(bytes).digest('hex')),
  engine: 'text-structured', maxResults: MATCH_RESULT_LIMIT, visualMatchingMeasured: false,
  realWorldEvidencePresent: rows.some(row => row.origin !== 'synthetic'),
  scope: 'Supplied labels and phone-camera provenance are attestations, not verified hosted recoveries. Text ranker only; photos are hash/magic-checked for storage, never analyzed. Synthetic and observed/language results stay separate. Not device/model/promotion evidence.',
  recallDefinition: 'Per-query relevant hits within top k / all supplied relevant candidates; macro-average within provenance and language. No-relevant queries excluded, reported separately. Missing ranked candidates remain misses.',
  groups, rows,
  resources: {host: {platform: process.platform, arch: process.arch, node: process.version}, iterationsPerQuery: iterations,
    latencyScope: 'Warm ranking only; excludes candidate retrieval, image decoding, startup/model loads. Nearest-rank percentiles over repeated queries.',
    latencyMs: {p50: quantile(.5), p95: quantile(.95), max: timings.at(-1)},
    memoryScope: 'Node process RSS/heap sampled after each query; includes harness/runtime/parsed dataset. Not transient peak, model footprint or Android measurement.',
    baselineRssBytes: baseline.rss, sampledPeakRssBytes, sampledPeakHeapUsedBytes},
  storage: {datasetBytes: raw.length, photoFiles: seenPhotos.size, photoBytes: [...seenPhotos.values()].reduce((sum, bytes) => sum + bytes, 0),
    runnerAndRankerBytes: sourceBytes.reduce((sum, bytes) => sum + bytes.length, 0), modelBytesLoaded: 0},
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({queries: rows.length, groups, realWorldEvidencePresent: report.realWorldEvidencePresent}));
