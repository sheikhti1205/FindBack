#!/usr/bin/env node
/**
 * check-cleanup-scheduler — structural validator for the comment-media
 * cleanup scheduler lane (X11).
 *
 * The queue sweep is only safe when its runner is wired correctly; this
 * checker is the contract that keeps `.github/workflows/cleanup-comment-media.yml`
 * honest. It reads the workflow as TEXT and asserts, without executing
 * anything:
 *   1. a `schedule` trigger (with a cron) exists;
 *   2. a `workflow_dispatch` trigger exists;
 *   3. a `concurrency` guard with `cancel-in-progress: false` exists;
 *   4. NO `push` or `tags` trigger exists (a code push must never sweep);
 *   5. a BOUNDED batch input exists (`max_batches` + numeric `MAX_BATCHES`
 *      ceiling + an `-gt` clamp);
 *   6. it invokes the `cleanup-comment-media` function;
 *   7. it references the dispatch secret by NAME (`secrets.CLEANUP_CRON_SECRET`
 *      via the `x-cleanup-secret` header) — never a literal value.
 *
 * Pure API (exported for node --test, hermetic):
 *   SCHEDULER_RULES, validateSchedulerWorkflow(text) -> { ok, errors }
 * Importing this module has no side effects; the CLI runs on direct execution.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Canonical path of the workflow this validator guards. */
export const SCHEDULER_WORKFLOW_PATH = resolve(
  REPO_ROOT,
  ".github/workflows/cleanup-comment-media.yml",
);

/**
 * Rule table. Each rule has a stable id (used in errors/tests) and a
 * predicate over the workflow text. A rule that returns false contributes
 * one error line.
 */
export const SCHEDULER_RULES = Object.freeze([
  {
    id: "schedule-trigger",
    message: "missing schedule trigger with a cron entry",
    test: (text) => /schedule\s*:/.test(text) && /cron\s*:/.test(text),
  },
  {
    id: "workflow-dispatch",
    message: "missing workflow_dispatch trigger",
    test: (text) => /workflow_dispatch\s*:/.test(text),
  },
  {
    id: "concurrency-guard",
    message: "missing concurrency guard with cancel-in-progress: false",
    test: (text) => /concurrency\s*:/.test(text) && /cancel-in-progress\s*:\s*false/.test(text),
  },
  {
    id: "no-push-tag",
    message: "must not be triggered on push or tags",
    test: (text) => !/(^|\n)[ \t]*(push|tags)\s*:/.test(text),
  },
  {
    id: "bounded-batch",
    message: "missing bounded batch input (max_batches dispatch input + numeric MAX_BATCHES ceiling + -gt clamp)",
    test: (text) =>
      /max_batches\s*:\s*\n[ \t]+(?:default|description|required)\s*:/i.test(text) &&
      /MAX_BATCHES\s*:\s*"?\d+/i.test(text) &&
      /-gt\b/.test(text),
  },
  {
    id: "invokes-function",
    message: "does not invoke the cleanup-comment-media function",
    test: (text) => /functions\/v1\/cleanup-comment-media\b/.test(text),
  },
  {
    id: "secret-by-name",
    message: "missing secrets.CLEANUP_CRON_SECRET reference via the x-cleanup-secret header",
    test: (text) =>
      /secrets\.CLEANUP_CRON_SECRET/.test(text) && /x-cleanup-secret/.test(text),
  },
]);

/**
 * Validate the scheduler workflow text. Returns { ok, errors } where errors
 * is a list of `<rule-id>: <message>` strings (empty when ok).
 */
export function validateSchedulerWorkflow(text) {
  const source = typeof text === "string" ? text : "";
  const errors = [];
  for (const rule of SCHEDULER_RULES) {
    let passed = false;
    try {
      passed = rule.test(source) === true;
    } catch {
      passed = false;
    }
    if (!passed) errors.push(`${rule.id}: ${rule.message}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Read the canonical workflow file and validate it. */
export function checkSchedulerWorkflow(path = SCHEDULER_WORKFLOW_PATH) {
  return validateSchedulerWorkflow(readFileSync(path, "utf8"));
}

function isMainModule() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`check-cleanup-scheduler: structural rules for the cleanup scheduler lane

usage:
  node scripts/check-cleanup-scheduler.mjs

exit codes: 0 all rules pass, 1 any rule fails`);
    process.exit(0);
  }
  let result;
  try {
    result = checkSchedulerWorkflow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`check-cleanup-scheduler: FAIL (cannot read workflow: ${message})`);
    process.exit(1);
  }
  if (!result.ok) {
    for (const line of result.errors) {
      console.error(`check-cleanup-scheduler: FAIL (${line})`);
    }
    process.exit(1);
  }
  console.log(
    `check-cleanup-scheduler: PASS (${SCHEDULER_RULES.length} rules: schedule, dispatch, concurrency, no push/tag, bounded batch, function call, secret by name)`,
  );
}
