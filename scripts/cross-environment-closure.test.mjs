import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOSURE,
  ROWS,
  VERDICTS,
  checkClosure,
  closureToJson,
  renderClosureMarkdown,
  scaffoldEvidence,
} from "./cross-environment-closure.mjs";

const OPEN = { isAncestor: () => true };

function clone() {
  return JSON.parse(JSON.stringify(CLOSURE));
}

test("shipped closure is valid: exact 18 rows, allowed verdicts, evidence present", () => {
  const { problems } = checkClosure(CLOSURE, OPEN);
  assert.deepEqual(problems, []);
});

test("the row set is exactly the 18 owner rows", () => {
  assert.equal(ROWS.length, 18);
  assert.deepEqual(Object.keys(CLOSURE.rows).sort(), [...ROWS].sort());
});

test("every declared verdict is from the allowed set", () => {
  for (const row of ROWS) assert.ok(VERDICTS.includes(CLOSURE.rows[row].verdict), row);
});

test("a missing row is reported", () => {
  const c = clone();
  delete c.rows.RELEASE;
  assert.ok(checkClosure(c, OPEN).problems.some((p) => /missing rows: RELEASE/.test(p)));
});

test("an unknown row is reported", () => {
  const c = clone();
  c.rows.MADE_UP = { verdict: "PASS", evidence: "docs/evidence/repo-implementation.json" };
  assert.ok(checkClosure(c, OPEN).problems.some((p) => /unknown rows: MADE_UP/.test(p)));
});

test("an unknown verdict is rejected", () => {
  const c = clone();
  c.rows.RELEASE.verdict = "PROBABLY_FINE";
  assert.ok(checkClosure(c, OPEN).problems.some((p) => /unknown verdict/.test(p)));
});

test("PASS without an evidence path fails", () => {
  const c = clone();
  delete c.rows.REPO_IMPLEMENTATION.evidence;
  assert.ok(checkClosure(c, OPEN).problems.some((p) => /PASS without an evidence path/.test(p)));
});

test("PASS with a missing evidence file fails", () => {
  const c = clone();
  c.rows.REPO_IMPLEMENTATION.evidence = "docs/evidence/does-not-exist.json";
  assert.ok(checkClosure(c, OPEN).problems.some((p) => /evidence missing/.test(p)));
});

test("PASS with empty evidence fails", () => {
  const c = clone();
  const seams = { ...OPEN, exists: () => true, read: () => "   " };
  assert.ok(checkClosure(c, seams).problems.some((p) => /evidence empty/.test(p)));
});

test("PASS with non-JSON evidence fails", () => {
  const c = clone();
  const seams = { ...OPEN, exists: () => true, read: () => "not json" };
  assert.ok(checkClosure(c, seams).problems.some((p) => /evidence not JSON/.test(p)));
});

test("PASS evidence without a 40-hex baselineSha fails", () => {
  const c = clone();
  const seams = { ...OPEN, exists: () => true, read: () => JSON.stringify({ row: "x" }) };
  assert.ok(checkClosure(c, seams).problems.some((p) => /40-hex baselineSha/.test(p)));
});

test("PASS evidence whose baselineSha is not reachable from HEAD fails (anti-staleness)", () => {
  const c = clone();
  const seams = {
    ...OPEN,
    isAncestor: () => false,
    exists: () => true,
    read: () => JSON.stringify({ baselineSha: "a".repeat(40) }),
  };
  const problems = checkClosure(c, seams).problems;
  assert.ok(problems.some((p) => /baselineSha .* is not reachable from HEAD/.test(p)));
});

test("FAIL requires a blocker", () => {
  const c = clone();
  c.rows.RELEASE = { verdict: "FAIL" };
  assert.ok(checkClosure(c, OPEN).problems.some((p) => /is FAIL without a blocker/.test(p)));
});

test("DEFERRED_* requires an ownerAction", () => {
  const c = clone();
  delete c.rows.EMULATOR.ownerAction;
  assert.ok(checkClosure(c, OPEN).problems.some((p) => /is DEFERRED_OWNER without an ownerAction/.test(p)));
});

test("READY_FOR_RUNTIME_PROOF requires a proofCommand", () => {
  const c = clone();
  delete c.rows.MAPLIBRE.proofCommand;
  assert.ok(
    checkClosure(c, OPEN).problems.some((p) => /READY_FOR_RUNTIME_PROOF without a proofCommand/.test(p)),
  );
});

test("a non-reachable closure baselineSha is reported", () => {
  const c = clone();
  c.baselineSha = "b".repeat(40);
  const seams = { ...OPEN, isAncestor: (sha) => sha !== "b".repeat(40) };
  assert.ok(checkClosure(c, seams).problems.some((p) => /closure baselineSha .* not reachable/.test(p)));
});

test("every PASS row is evidence-backed with no PASS lacking evidence", () => {
  const { passRows } = checkClosure(CLOSURE, OPEN);
  const expected = Object.entries(CLOSURE.rows)
    .filter(([, e]) => e.verdict === "PASS")
    .map(([id]) => id);
  assert.deepEqual([...passRows].sort(), [...expected].sort());
  for (const id of passRows) assert.ok(CLOSURE.rows[id].evidence, `${id} carries evidence`);
});

test("markdown renders one row per lane", () => {
  const md = renderClosureMarkdown();
  for (const row of ROWS) assert.ok(md.includes(`| ${row} |`), row);
  assert.equal(md.split("\n").length, ROWS.length + 2);
});

test("json emits all 18 rows", () => {
  const parsed = JSON.parse(closureToJson());
  assert.equal(parsed.rows.length, 18);
  assert.equal(parsed.baselineSha, CLOSURE.baselineSha);
});

test("scaffold produces an evidence template per PASS row", () => {
  const tmpl = scaffoldEvidence();
  const expected = Object.values(CLOSURE.rows)
    .filter((e) => e.verdict === "PASS")
    .map((e) => e.evidence)
    .sort();
  assert.deepEqual(Object.keys(tmpl).sort(), expected);
  for (const v of Object.values(tmpl)) assert.equal(v.baselineSha, "<40-hex product HEAD>");
});
