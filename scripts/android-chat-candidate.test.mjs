import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { load } = require('js-yaml');
const workflow = load(readFileSync('.github/workflows/android-builds.yml', 'utf8'));

test('manual Android candidate runs build an exact-SHA upgrade without changing any numbered release', () => {
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.match(workflow.jobs.apk.if, /github.event_name == 'workflow_dispatch'/);
  const steps = workflow.jobs.apk.steps;
  assert.ok(steps.some(s => s.uses?.startsWith('actions/upload-artifact@') && s.if === "github.event_name == 'workflow_dispatch'"));
  for (const name of ['Write the update catalogue for exactly these bytes', 'Publish the numbered release']) {
    assert.equal(steps.find(s => s.name === name).if, "github.event_name != 'workflow_dispatch'");
  }
  const config = steps.find(s => s.name === 'Strict installable config and build identity');
  assert.match(config.run, /GITHUB_EVENT_NAME.*workflow_dispatch/);
  assert.ok(steps.some(s => s.name === 'Verify EVERY APK variant (signature pin, identity, ABI, config)'));
  assert.ok(steps.some(s => s.name === 'Assert client config in the bundle'));
});
