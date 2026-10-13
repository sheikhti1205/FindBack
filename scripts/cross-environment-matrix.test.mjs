import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATRIX,
  checkMatrixInvariants,
  renderMarkdown,
} from "./cross-environment-matrix.mjs";

const LANES = ["LOCAL", "CI", "RELEASE", "WEB", "DOCKER", "LIVE"];

test("the shipped matrix satisfies every invariant", () => {
  assert.deepEqual(checkMatrixInvariants(), []);
});

test("the capability rule keeps product features non-N/A on the web lane", () => {
  const google = MATRIX.find((r) => r.id === "google-auth-web-oauth");
  const klipy = MATRIX.find((r) => r.id === "klipy");
  const map = MATRIX.find((r) => r.id === "map-web-renderer");
  assert.notEqual(google.cells.WEB, "NOT_APPLICABLE");
  assert.notEqual(klipy.cells.WEB, "NOT_APPLICABLE");
  assert.notEqual(map.cells.WEB, "NOT_APPLICABLE");
});

test("every NOT_APPLICABLE cell carries a justification", () => {
  for (const row of MATRIX) {
    if (Object.values(row.cells).includes("NOT_APPLICABLE")) {
      assert.ok(row.justification && row.justification.length > 20, `${row.id} justification`);
    }
  }
});

function withRow(overrides) {
  return MATRIX.map((r) => (r.id === "klipy" ? { ...r, ...overrides } : r));
}

test("an unknown status is rejected", () => {
  const bad = withRow({ cells: { ...MATRIX.find((r) => r.id === "klipy").cells, WEB: "MAYBE" } });
  assert.ok(checkMatrixInvariants(bad).some((p) => /unknown status/.test(p)));
});

test("a NOT_APPLICABLE cell without a justification is rejected", () => {
  const bad = withRow({ justification: "" });
  assert.ok(checkMatrixInvariants(bad).some((p) => /without a justification/.test(p)));
});

test("marking a web product capability N/A is rejected by the capability pin", () => {
  const bad = withRow({ cells: { ...MATRIX.find((r) => r.id === "klipy").cells, WEB: "NOT_APPLICABLE" } });
  assert.ok(checkMatrixInvariants(bad).some((p) => /capability rule violated/.test(p)));
});

test("every row declares all lanes and renders a markdown row", () => {
  for (const row of MATRIX) {
    for (const lane of LANES) assert.ok(row.cells[lane], `${row.id}.${lane}`);
  }
  const md = renderMarkdown();
  assert.match(md, /\| Area \| LOCAL \| CI \| RELEASE \| WEB \| DOCKER \| LIVE \| Notes \|/);
  assert.equal(md.split("\n").length, MATRIX.length + 2);
});
