import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Compatibility smoke, NOT a demonstrated RED-to-GREEN exploit regression:
// body-parser 2.3.0 also survives these probes on Node 24.20.0. The subprocess
// keeps a future unhandled stream error from terminating the whole test worker.
it("survives compressed JSON with trailing bytes and serves the next request", () => {
  const probe = fileURLToPath(new URL("./fixtures/compressedBodyProbe.mjs", import.meta.url));
  const child = spawnSync(process.execPath, ["--max-old-space-size=128", probe], {
    env: {}, encoding: "utf8", timeout: 5000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result).toMatchObject({ valid: 200, healthy: 200 });
  expect(result.malformed).toHaveLength(3);
  for (const status of result.malformed) expect([200, 400]).toContain(status);
});
