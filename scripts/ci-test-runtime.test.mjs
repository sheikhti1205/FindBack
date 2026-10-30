import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Native Web Locks (including pending-query and abort semantics) arrived in
// Node 24.5. Do not replace the real messaging lock tests with a mutex mock.
for (const [file, job] of [["ci.yml", "check"], ["release.yml", "gate"]]) {
  test(`${file} full mobile test job uses Node 24 with native Web Locks`, () => {
    const workflow = readFileSync(`.github/workflows/${file}`, "utf8");
    const jobs = workflow.split(/(?=^ {2}[a-zA-Z0-9_-]+:\s*$)/m);
    const lane = jobs.find((part) => part.startsWith(`  ${job}:`));
    assert.ok(lane, `missing ${job} job`);
    assert.match(lane, /npm test -w @findback\/mobile/);
    assert.ok(/node-version: 24\b/.test(lane),
      "the full suite requires Node 24.5+ navigator.locks and worker_threads.locks");
  });
}

test("CI executes the runtime regression", () => {
  assert.ok(/run: node --test[^\n]*scripts\/ci-test-runtime\.test\.mjs/.test(
    readFileSync(".github/workflows/ci.yml", "utf8")));
});
