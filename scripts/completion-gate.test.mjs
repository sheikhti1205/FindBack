/**
 * completion-gate regression tests (audit FBA-023/024): the gate must fail on
 * an open-P0/P1 ledger or an unallowlisted work marker, and must pass on the
 * real repository in integrity mode. Release mode is asserted to stay RED on
 * the real tree while external P0/P1 items are open — that is the HOLD.
 */
import { deepStrictEqual, equal, ok } from "node:assert";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkCompletionGate,
  collectShippedSources,
  findUnallowlistedDebt,
  loadLedger,
  validateLedger,
} from "./completion-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

describe("validateLedger", () => {
  it("closes a well-formed, fully-closed ledger in release mode", () => {
    const closed = {
      version: 1,
      releaseStatus: "READY",
      items: [{ id: "FBA-001", severity: "P0", area: "x", status: "DONE", evidence: "shipped" }],
    };
    deepStrictEqual(validateLedger(closed, { release: true }), []);
  });

  it("rejects an OPEN P0/P1 without a named blocker and a CLOSED item without evidence", () => {
    const bad = {
      version: 1,
      releaseStatus: "HOLD",
      items: [
        { id: "FBA-001", severity: "P0", status: "BLOCKED_EXTERNAL", blocker: "" },
        { id: "FBA-002", severity: "P1", status: "DONE", evidence: "" },
      ],
    };
    const errors = validateLedger(bad);
    ok(errors.some((e) => /FBA-001.*blocker/.test(e)), errors.join("; "));
    ok(errors.some((e) => /FBA-002.*evidence/.test(e)), errors.join("; "));
  });

  it("fails release mode while any P0/P1 is not closed", () => {
    const hold = {
      version: 1,
      releaseStatus: "HOLD",
      items: [{ id: "FBA-001", severity: "P0", status: "IN_PROGRESS", blocker: "waiting on device" }],
    };
    deepStrictEqual(validateLedger(hold), []);
    ok(validateLedger(hold, { release: true }).some((e) => /release blocked: FBA-001/.test(e)));
  });

  it("rejects duplicate ids and invalid status/severity", () => {
    const bad = {
      version: 1,
      releaseStatus: "HOLD",
      items: [
        { id: "FBA-001", severity: "P9", status: "DONE", evidence: "x" },
        { id: "FBA-001", severity: "P0", status: "MOSTLY_DONE", evidence: "x" },
      ],
    };
    const errors = validateLedger(bad);
    ok(errors.some((e) => /invalid severity/.test(e)));
    ok(errors.some((e) => /invalid status/.test(e)));
    ok(errors.some((e) => /duplicate id/.test(e)));
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

describe("completion-gate on the real repository", () => {
  it("passes integrity mode (CI stays honest, not falsely green)", () => {
    const { passed, errors } = checkCompletionGate({ files: collectShippedSources(REPO_ROOT) });
    ok(passed, errors.join("\n"));
  });
  it("stays RED in release mode while external P0/P1 blockers remain (the HOLD)", () => {
    const { passed, errors } = checkCompletionGate({ release: true, files: collectShippedSources(REPO_ROOT) });
    equal(passed, false);
    ok(errors.some((e) => /release blocked|releaseStatus/.test(e)));
  });
  it("scans no third-party or test-only trees", () => {
    const files = collectShippedSources(REPO_ROOT);
    ok(!Object.keys(files).some((f) => f.includes("third_party") || /\.test\./.test(f)), "scan leaked excluded files");
    ok(loadLedger(REPO_ROOT).items.some((item) => item.id === "FBA-023"), "ledger missing FBA-023");
    ok(Object.keys(files).length > 50, "scan found too few shipped sources");
  });
});
