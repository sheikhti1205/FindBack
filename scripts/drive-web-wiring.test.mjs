import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";

test("production Web receives the same public Google OAuth audience as Android", () => {
  const workflow = readFileSync(new URL("../.github/workflows/web.yml", import.meta.url), "utf8");
  assert.match(workflow, /VITE_GOOGLE_DRIVE_CLIENT_ID: \$\{\{ vars\.GOOGLE_WEB_CLIENT_ID \}\}/);
  assert.match(workflow, /node scripts\/check-drive-web-config\.mjs --preflight/);
  assert.match(workflow, /node scripts\/check-drive-web-config\.mjs --assets apps\/mobile\/dist\/assets/);
});
