#!/usr/bin/env node
/**
 * Commit-message convention checker (see docs/COMMIT_CONVENTIONS.md).
 *
 * Prospective only: inspects ONLY the commits it is explicitly given
 * (--range/--rev/--count/--stdin) and never fails repository history.
 * Merge, revert, and generated dependency-bump commits pass gracefully.
 *
 * Pure Node builtins. Test suite: scripts/check-commit-messages.test.mjs
 * Run: `node --test scripts/check-commit-messages.test.mjs` from repo root.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Merge / revert / generated commits are exempt from every rule.
const SKIP_SUBJECT_RE =
  /^(Merge\b|Revert\b|[Bb]ump\b|chore\(deps\b|build\(deps\b|🤖)/;

// Never in the subject.
const WAVE_RE = /\b(wave|phase|stage|step)\s*\d+/i;
const WORKER_RE = /\b(opencode|sonnet|opus|haiku|gpt(?:-?\d)?|gemini|copilot|cursor|Muse|llm|agent)\b/i;
const TEST_COUNT_RE = /\b\d+\s*(tests?|cases?|specs?|assertions?)\b/i;
const WIP_RE = /^\s*wip\b/i;

// Subject shape: `scope: outcome`.
const SUBJECT_RE = /^([a-z0-9][a-z0-9-]*): (\S.*)$/;

// Body must name at least one gate (docs-scoped commits are exempt).
const GATE_RE =
  /\b(typecheck|lint|tests?|gate|verify|verified|verification|checks?|ci\b|e2e|qa|vitest|tsc|eslint|node --test)\b/i;

/**
 * Classify a subject line. Returns "skip" for merge/revert/generated
 * commits, otherwise "normal".
 */
export function classifyCommit(subject) {
  return SKIP_SUBJECT_RE.test(subject.trim()) ? "skip" : "normal";
}

/**
 * Parse a commit-message enforcement-baseline file: one commit SHA per line.
 * Blank lines and `#` comments are ignored. Any commit whose SHA is listed is
 * pre-enforcement and is skipped, so a historical commit that predates the
 * convention (and cannot be rewritten) never blocks a release. The list is
 * append-only: new commits are always enforced.
 */
export function parseBaseline(text) {
  const shas = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    shas.add(line.toLowerCase());
  }
  return shas;
}

/** True when `sha` is in the enforcement baseline (pre-enforcement commit). */
export function isExempt(sha, baseline) {
  if (!sha || !baseline) return false;
  return baseline.has(String(sha).toLowerCase());
}

/**
 * Check one commit message. Returns { ok, errors[], skipped }.
 * Never throws on content; never prints key material (no secrets involved).
 * `options.sha` + `options.baseline` exempt pre-enforcement commits.
 */
export function checkMessage(subject, body = "", options = {}) {
  const errors = [];
  const trimmed = subject.trim();

  if (classifyCommit(trimmed) === "skip") return { ok: true, errors, skipped: true };
  if (isExempt(options.sha, options.baseline)) return { ok: true, errors, skipped: true };
  if (!trimmed) return { ok: false, errors: ["empty subject"], skipped: false };

  if (WIP_RE.test(trimmed)) errors.push("subject looks like WIP");
  if (WAVE_RE.test(trimmed)) errors.push("subject must not contain wave/phase/stage labels");
  if (WORKER_RE.test(trimmed)) errors.push("subject must not name workers/models/agents");
  if (TEST_COUNT_RE.test(trimmed)) errors.push("subject must not contain test counts (record gates in the body)");

  const shape = SUBJECT_RE.exec(trimmed);
  if (!shape) {
    if (/^[A-Z]/.test(trimmed) && !trimmed.includes(":")) {
      errors.push("subject must start with a lower-case `scope:` prefix");
    } else {
      errors.push("subject must match `scope: outcome` with a lower-case scope");
    }
  } else {
    const outcome = shape[2];
    if (/^[A-Z]/.test(outcome)) errors.push("outcome must start lower-case");
    if (/\.$/.test(trimmed)) errors.push("subject must not end with a period");
    if (trimmed.length > 72) errors.push(`subject exceeds 72 chars (${trimmed.length})`);
    // Body-gate rule: docs-scoped commits are exempt.
    if (shape[1] !== "docs" && !GATE_RE.test(body)) {
      errors.push("body must record gates (e.g. `Gates: typecheck, lint, tests`)");
    }
  }

  return { ok: errors.length === 0, errors, skipped: false };
}

function loadCommits(args) {
  const rangeIdx = args.indexOf("--range");
  const revIdx = args.indexOf("--rev");
  const countIdx = args.indexOf("--count");
  const useStdin = args.includes("--stdin");
  const SEP = "\x1f";
  const END = "\x1e";

  /** @returns {{ sha: string, subject: string, body: string }[]} */
  const parse = (raw) =>
    raw
      .split(END)
      .map((chunk) => chunk.replace(/^\n+/, ""))
      .filter((chunk) => chunk.trim())
      .map((chunk) => {
        const [sha = "", subject = "", body = ""] = chunk.split(SEP);
        return { sha: sha.trim(), subject: (subject ?? "").trim(), body: body ?? "" };
      });

  if (useStdin) {
    return import("node:fs").then(({ readFileSync }) =>
      parse(readFileSync(0, "utf8")).map((c, i) => ({
        sha: c.sha || `stdin-${i}`,
        subject: c.subject || c.sha,
        body: c.body,
      })),
    );
  }
  const format = `%H${SEP}%s${SEP}%b${END}`;
  if (rangeIdx !== -1) {
    const range = args[rangeIdx + 1];
    if (!range) throw new Error("check-commit-messages: --range requires a value");
    return parse(execFileSync("git", ["log", `--format=${format}`, range], { encoding: "utf8" }));
  }
  if (revIdx !== -1) {
    const rev = args[revIdx + 1];
    if (!rev) throw new Error("check-commit-messages: --rev requires a value");
    return parse(execFileSync("git", ["log", "-1", `--format=${format}`, rev], { encoding: "utf8" }));
  }
  if (countIdx !== -1) {
    const count = args[countIdx + 1];
    if (!count) throw new Error("check-commit-messages: --count requires a value");
    return parse(execFileSync("git", ["log", `-${count}`, `--format=${format}`], { encoding: "utf8" }));
  }
  throw new Error(
    "check-commit-messages: expected one of --range A...B, --rev X, --count N, --stdin",
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const argv = process.argv.slice(2);
    const baselineIdx = argv.indexOf("--baseline");
    let baseline = new Set();
    if (baselineIdx !== -1) {
      const baselinePath = argv[baselineIdx + 1];
      if (!baselinePath) throw new Error("check-commit-messages: --baseline requires a file path");
      baseline = parseBaseline(readFileSync(baselinePath, "utf8"));
    }
    const commits = await loadCommits(argv);
    if (commits.length === 0) {
      console.log("check-commit-messages: PASS (no commits in range — nothing to check)");
      process.exit(0);
    }
    let failed = 0;
    let skipped = 0;
    for (const { sha, subject, body } of commits) {
      const result = checkMessage(subject, body, { sha, baseline });
      if (result.skipped) {
        skipped += 1;
        console.log(`check-commit-messages: SKIP ${sha} (${subject.slice(0, 60)})`);
      } else if (!result.ok) {
        failed += 1;
        console.error(`check-commit-messages: FAIL ${sha} (${subject.slice(0, 80)})`);
        for (const error of result.errors) console.error(`  - ${error}`);
      }
    }
    if (failed > 0) {
      console.error(`check-commit-messages: FAIL (${failed} failing, ${skipped} skipped, ${commits.length} total)`);
      process.exit(1);
    }
    console.log(
      `check-commit-messages: PASS (${commits.length - skipped} checked, ${skipped} skipped, ${commits.length} total)`,
    );
  } catch (error) {
    console.error(error.message.startsWith("check-commit-messages:") ? error.message : `check-commit-messages: ${error.message}`);
    process.exit(1);
  }
}
