/**
 * completion-gate v2 regression tests (audit FBA-023/024 + closure review):
 * integrity stays honest, --final demands every-severity closure, evidence
 * references, docs agreement and HEAD binding, and --release adds READY.
 */
import { deepStrictEqual, equal, ok } from "node:assert";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkCompletionGate,
  collectShippedSources,
  collectTestSources,
  FINDINGS_MANIFEST,
  findUnallowlistedDebt,
  findUnallowlistedSkips,
  loadLedger,
  parseAuditStates,
  validateActiveBaseline,
  validateDocsConsistency,
  validateEvidenceRefs,
  validateHeadBinding,
  validateLedger,
} from "./completion-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const sevOf = (id) => {
  const n = Number(id.slice(4));
  if (id === "FBA-035") return "P1";
  if (id === "FBA-036") return "P2";
  if ([1, 2, 7, 8, 17, 26].includes(n)) return "P0";
  if ([3, 4, 5, 10, 11, 14, 15, 19, 20].includes(n)) return "P1";
  if ([6, 13, 16, 18, 21, 23, 24, 25].includes(n)) return "P2";
  if ([12, 22].includes(n)) return "P3";
  return "OK";
};

/** A full-manifest ledger whose items can be overridden per test. */
function fullLedger(overrides = {}, { status = "DONE", releaseStatus = "HOLD" } = {}) {
  return {
    version: 1,
    releaseStatus,
    generatedFor: "a".repeat(40),
    items: FINDINGS_MANIFEST.map((id) => ({
      id,
      severity: sevOf(id),
      area: "test",
      status,
      evidence: `shipped in apps/mobile/src/services/${id}.ts (commit ${"b".repeat(40)})`,
      blocker: "",
      ...overrides[id],
    })),
  };
}

const stubPaths = { exists: () => true, commitExists: () => true, root: REPO_ROOT };
const fakeRegister = (states) =>
  FINDINGS_MANIFEST.map((id) => `| ${id} | P0 | ${states[id] ?? "DONE — test"} | evidence | criterion |`).join("\n");
const stubDocs = (states) => ({
  read: (p) => (p === "docs/COMPLETION_AUDIT.md" ? fakeRegister(states) : "no predictions here"),
});
const stubGitClean = (head = "a".repeat(40)) => (cmd, _args) => {
  if (cmd === "rev-parse") return `${head}\n`;
  if (cmd === "status") return "\n";
  if (cmd === "diff") return "\n";
  throw new Error(`unexpected git ${cmd}`);
};

describe("validateLedger integrity", () => {
  it("closes a well-formed, full-manifest ledger", () => {
    deepStrictEqual(validateLedger(fullLedger()), []);
  });

  it("rejects an OPEN item without a named blocker and a CLOSED item without evidence", () => {
    const bad = fullLedger({
      "FBA-001": { status: "BLOCKED_EXTERNAL", blocker: "" },
      "FBA-002": { status: "DONE", evidence: "" },
    });
    const errors = validateLedger(bad);
    ok(errors.some((e) => /FBA-001.*blocker/.test(e)), errors.join("; "));
    ok(errors.some((e) => /FBA-002.*evidence/.test(e)), errors.join("; "));
  });

  it("rejects a WAIVED item without a written waiver", () => {
    const bad = fullLedger({ "FBA-006": { status: "WAIVED", waiver: "", evidence: "accepted" } });
    ok(validateLedger(bad).some((e) => /FBA-006.*waiver/.test(e)));
  });

  it("rejects missing/extra ids against the canonical manifest", () => {
    const missing = fullLedger();
    missing.items = missing.items.filter((i) => i.id !== "FBA-034");
    ok(validateLedger(missing).some((e) => /missing canonical finding FBA-034/.test(e)));
    const extra = fullLedger();
    extra.items.push({ id: "FBA-037", severity: "P3", status: "DONE", evidence: "x", blocker: "" });
    ok(validateLedger(extra).some((e) => /non-canonical id FBA-037/.test(e)));
  });

  it("rejects duplicate ids and invalid status/severity", () => {
    const bad = fullLedger({
      "FBA-001": { severity: "P9", status: "MOSTLY_DONE", evidence: "x" },
    });
    bad.items.push({ id: "FBA-001", severity: "P0", status: "DONE", evidence: "x", blocker: "" });
    const errors = validateLedger(bad);
    ok(errors.some((e) => /invalid severity/.test(e)));
    ok(errors.some((e) => /invalid status/.test(e)));
    ok(errors.some((e) => /duplicate id/.test(e)));
  });
});

describe("validateLedger final", () => {
  it("fails while any severity stays open — P2/P3 cannot hide behind P0/P1 closure", () => {
    const hold = fullLedger({ "FBA-013": { status: "IN_PROGRESS", blocker: "waiting on device", evidence: "" } });
    deepStrictEqual(validateLedger(hold), []);
    const errors = validateLedger(hold, { final: true }, { ...stubPaths, ...stubDocs({}), git: stubGitClean() });
    ok(errors.some((e) => /final blocked: FBA-013/.test(e)), errors.join("; "));
  });

  it("fails when a closed item retains a blocker", () => {
    const bad = fullLedger({ "FBA-001": { blocker: "device proof tracked elsewhere" } });
    const errors = validateLedger(bad, { final: true }, { ...stubPaths, ...stubDocs({}), git: stubGitClean() });
    ok(errors.some((e) => /FBA-001.*retains a blocker/.test(e)), errors.join("; "));
  });

  it("accepts a formally waived limitation with waiver + evidence", () => {
    const waived = fullLedger(
      { "FBA-006": { status: "WAIVED", waiver: "evaluator accepted CSV substitute", blocker: "genuine .rpt needs licensed tooling" } },
      { releaseStatus: "READY" },
    );
    const errors = validateLedger(waived, { release: true }, { ...stubPaths, ...stubDocs({ "FBA-006": "WAIVED — evaluator acceptance" }), git: stubGitClean() });
    deepStrictEqual(errors, []);
  });

  it("fails release mode when releaseStatus is not READY even with every finding closed", () => {
    const hold = fullLedger({}, { releaseStatus: "HOLD" });
    const errors = validateLedger(hold, { release: true }, { ...stubPaths, ...stubDocs({}), git: stubGitClean() });
    deepStrictEqual(errors, ['releaseStatus is "HOLD" (must be READY to release)']);
  });
});

describe("validateEvidenceRefs", () => {
  it("accepts existing paths, commits, run ids and manual runbooks", () => {
    const ledger = {
      items: [
        { id: "FBA-001", evidence: "wired in apps/mobile/src/screens/CreateReport.tsx, gate run 37395801580" },
        { id: "FBA-002", evidence: "manual:gate-e-device-run device matrix" },
        { id: "FBA-003", evidence: `landed in commit ${"c".repeat(40)}` },
      ],
    };
    deepStrictEqual(
      validateEvidenceRefs(ledger, {
        exists: (p) => p.endsWith("apps/mobile/src/screens/CreateReport.tsx"),
        commitExists: () => true,
        root: REPO_ROOT,
      }),
      [],
    );
  });

  it("rejects dangling paths, unknown commits, unmatched runbooks and reference-free prose", () => {
    const ledger = {
      items: [
        { id: "FBA-001", evidence: "wired in apps/mobile/src/screens/Missing.tsx" },
        { id: "FBA-002", evidence: `landed in commit ${"d".repeat(40)}` },
        { id: "FBA-003", evidence: "manual:no-such-runbook" },
        { id: "FBA-004", evidence: "the team worked hard and it feels complete" },
      ],
    };
    const errors = validateEvidenceRefs(ledger, { exists: () => false, commitExists: () => false, root: REPO_ROOT });
    ok(errors.some((e) => /FBA-001.*Missing\.tsx/.test(e)), errors.join("; "));
    ok(errors.some((e) => /FBA-002.*unknown commit/.test(e)), errors.join("; "));
    ok(errors.some((e) => /FBA-003.*no matching docs\/runbooks/.test(e)), errors.join("; "));
    ok(errors.some((e) => /FBA-004.*no verifiable reference/.test(e)), errors.join("; "));
  });
});

describe("docs consistency", () => {
  it("parses register state cells per finding", () => {
    const states = parseAuditStates("| FBA-001 | P0 | DONE — owner | ev | crit |\n| FBA-002 | P0 | OPEN — op | ev | crit |");
    equal(states.get("FBA-001"), "DONE — owner");
    equal(states.get("FBA-002"), "OPEN — op");
  });

  it("fails when the register still shows IN_PROGRESS for a ledger-closed finding", () => {
    const errors = validateDocsConsistency(fullLedger(), stubDocs({ "FBA-001": "IN_PROGRESS — owner" }));
    ok(errors.some((e) => /FBA-001.*register still says/.test(e)), errors.join("; "));
  });

  it("fails when a current doc still predicts the ledger as upcoming", () => {
    const errors = validateDocsConsistency(fullLedger(), {
      read: (p) => (p === "docs/COMPLETION_AUDIT.md" ? fakeRegister({}) : "Main owns the upcoming `completion-ledger.json`."),
    });
    ok(errors.some((e) => /upcoming/.test(e)), errors.join("; "));
  });

  it("fails on a stale active baseline SHA in current docs", () => {
    const errors = validateActiveBaseline({ generatedFor: "f".repeat(40) }, {
      read: () => "Audit/source baseline: `b472a247ae593b8eb4e9585bb8947a87ccfaf6c7` is active.",
    });
    ok(errors.some((e) => /stale active baseline/.test(e)), errors.join("; "));
  });

  it("ignores historical SHA mentions and migration timestamps", () => {
    const errors = validateActiveBaseline({ generatedFor: "f".repeat(40) }, {
      read: () => [
        "Archived byte-for-byte as read at b472a24 (historical).",
        "Migration 20261006120000_auth_phone_verification_sync.sql applied.",
      ].join("\n"),
    });
    deepStrictEqual(errors, []);
  });
});

describe("validateHeadBinding", () => {
  it("passes on a clean tree reconciled at HEAD", () => {
    deepStrictEqual(validateHeadBinding({ generatedFor: "a".repeat(40) }, { git: stubGitClean() }), []);
  });

  it("passes when only the ledger changed since generatedFor", () => {
    const git = (cmd) => {
      if (cmd === "rev-parse") return `${"b".repeat(40)}\n`;
      if (cmd === "status") return "\n";
      return "completion-ledger.json\n";
    };
    deepStrictEqual(validateHeadBinding({ generatedFor: "a".repeat(40) }, { git }), []);
  });

  it("fails on a dirty tree and on non-ledger drift since generatedFor", () => {
    const dirty = (cmd) => (cmd === "rev-parse" ? `${"a".repeat(40)}\n` : " M apps/mobile/src/x.ts\n");
    ok(validateHeadBinding({ generatedFor: "a".repeat(40) }, { git: dirty }).some((e) => /dirty/.test(e)));
    const drifted = (cmd) => {
      if (cmd === "rev-parse") return `${"b".repeat(40)}\n`;
      if (cmd === "status") return "\n";
      return "completion-ledger.json\napps/mobile/src/x.ts\n";
    };
    const errors = validateHeadBinding({ generatedFor: "a".repeat(40) }, { git: drifted });
    ok(errors.some((e) => /non-ledger file\(s\) changed/.test(e)), errors.join("; "));
  });

  it("rejects a non-SHA generatedFor", () => {
    ok(validateHeadBinding({ generatedFor: "b472a24" }, {}).some((e) => /full commit SHA/.test(e)));
  });
});

describe("findUnallowlistedDebt", () => {
  it("flags TODO/FIXME markers unless they are allowlisted by file + text", () => {
    const files = {
      "apps/mobile/src/services/similarity.ts": " * TODO(DEVICE-CALIBRATION): calibrate",
      "apps/mobile/src/services/other.ts": "// TODO: wire this later",
    };
    const errors = findUnallowlistedDebt(files);
    deepStrictEqual(errors, ["apps/mobile/src/services/other.ts:1: unallowlisted TODO work marker"]);
  });
});

describe("findUnallowlistedSkips", () => {
  it("flags todos/skips unless allowlisted as device-only with an owner", () => {
    const files = {
      "apps/mobile/src/a.test.ts": '  it.todo("before trace: Home pull");',
      "apps/mobile/src/b.test.ts": '  it.todo("wire this later");',
    };
    const errors = findUnallowlistedSkips(files, {
      allowlist: [{ file: "apps/mobile/src/a.test.ts", contains: "before trace", owner: "FBA-014", reason: "device" }],
    });
    deepStrictEqual(errors, ["apps/mobile/src/b.test.ts:1: unallowlisted todo/skip — automate it or allowlist as device-only with an owner"]);
  });
});

describe("completion-gate on the real repository", () => {
  it("passes integrity mode (CI stays honest, not falsely green)", () => {
    const { passed, errors } = checkCompletionGate({ files: collectShippedSources(REPO_ROOT) });
    ok(passed, errors.join("\n"));
  });
  it("stays RED in final/release mode while external blockers remain (fixture HOLD)", () => {
    // Fail-closed property, independent of the live repo disposition: an
    // unwaived external blocker plus HOLD must refuse release.
    const held = fullLedger(
      { "FBA-002": { status: "BLOCKED_EXTERNAL", blocker: "no authorized device" } },
      { releaseStatus: "HOLD" },
    );
    const { passed, errors } = checkCompletionGate({ release: true, ledger: held, files: {}, testFiles: {} });
    equal(passed, false);
    ok(errors.some((e) => /final blocked|releaseStatus/.test(e)), errors.join("\n"));
  });
  it("goes GREEN in release mode once waivers are written and status is READY (v8 beta disposition)", () => {
    const { passed, errors } = checkCompletionGate({ release: true, files: collectShippedSources(REPO_ROOT) });
    ok(passed, errors.join("\n"));
    // The green must rest on written owner waivers, never on an emptied manifest.
    const waived = loadLedger(REPO_ROOT).items.filter((item) => item.status === "WAIVED");
    ok(waived.length > 0, "release-green with zero waivers means the manifest was emptied");
    ok(
      waived.every((item) => typeof item.waiver === "string" && item.waiver.trim() !== ""),
      "every WAIVED item needs written waiver text",
    );
  });
  it("scans production Android source but no third-party or test-only trees", () => {
    const files = collectShippedSources(REPO_ROOT);
    ok(Object.keys(files).some((f) => f.startsWith("apps/mobile/android/app/src/main/")), "Android production source unscanned");
    ok(!Object.keys(files).some((f) => f.includes("third_party") || /\.test\./.test(f)), "scan leaked excluded files");
    ok(loadLedger(REPO_ROOT).items.some((item) => item.id === "FBA-023"), "ledger missing FBA-023");
    ok(Object.keys(files).length > 50, "scan found too few shipped sources");
    const tests = collectTestSources(REPO_ROOT);
    ok(Object.keys(tests).length > 100, "test inventory too small to enforce skips");
  });
});
