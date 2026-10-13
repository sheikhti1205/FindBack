#!/usr/bin/env node
// X8/X18 — the cross-environment capability matrix.
//
// One declarative source of truth for which product capability is present on
// which lane, using ONLY the four statuses: IMPLEMENTED, CONFIG_REQUIRED,
// READY_RUNTIME, NOT_APPLICABLE. The applicability rule is CAPABILITY-based,
// not technology-based: a cell is NOT_APPLICABLE only when the product feature
// does not exist on that lane, and every such cell must carry a one-sentence
// justification.
//
// `--check` enforces the invariants (vocabulary, justification coverage, and
// a handful of capability-rule pins). `--markdown` renders the table for the
// runbook doc. No secrets are ever read or printed.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LANES = ["LOCAL", "CI", "RELEASE", "WEB", "DOCKER", "LIVE"];
const STATUSES = ["IMPLEMENTED", "CONFIG_REQUIRED", "READY_RUNTIME", "NOT_APPLICABLE"];

const I = "IMPLEMENTED";
const C = "CONFIG_REQUIRED";
const R = "READY_RUNTIME";
const N = "NOT_APPLICABLE";

/**
 * Rows: `{ id, label, cells: { LANE: STATUS }, notes }`. `justification` is
 * REQUIRED whenever any cell is NOT_APPLICABLE (a sentence explaining the
 * absent product capability, not an absent technology).
 */
export const MATRIX = [
  {
    id: "google-auth-web-oauth",
    label: "Google login — web OAuth (runtime)",
    cells: { LOCAL: C, CI: C, RELEASE: C, WEB: C, DOCKER: N, LIVE: N },
    notes:
      "Google login IS a web product feature (capability rule). The web OAuth path is IMPLEMENTED in source this wave (signInWithOAuth → /auth/callback bridge → shared resolver); it stays CONFIG_REQUIRED until the Supabase Google provider carries the web client + the redirect URL allowlist.",
    justification:
      "DOCKER/LIVE N/A because the Docker reference shell forwards no Google client and OAuth is a client capability, not a live FindBack service.",
  },
  {
    id: "klipy",
    label: "KLIPY GIF/sticker picker",
    cells: { LOCAL: C, CI: C, RELEASE: C, WEB: C, DOCKER: C, LIVE: N },
    notes:
      "KLIPY IS a web product feature because web has comments. Adapter live-VALIDATED with a real key; VITE_KLIPY_API_KEY now flows to web.yml/release.yml from a repo secret — the secret must be set or the picker hides.",
    justification:
      "LIVE N/A because KLIPY is a client adapter against a third-party API, not a FindBack backend service.",
  },
  {
    id: "sentry-release-dist",
    label: "Sentry release/dist identity",
    cells: { LOCAL: I, CI: I, RELEASE: I, WEB: I, DOCKER: I, LIVE: N },
    notes: "ONE scheme findback-mobile@<version>+<short12> (exactly-12); per-lane closed dist; parity gate.",
    justification: "LIVE N/A because release identity is a build-time string, not a live service.",
  },
  {
    id: "map-native",
    label: "MAPLIBRE_NATIVE",
    cells: { LOCAL: I, CI: I, RELEASE: I, WEB: N, DOCKER: N, LIVE: N },
    notes: "Native final, keyless, no Google-Maps fallback.",
    justification:
      "WEB/DOCKER/LIVE N/A because MapLibre Native is an Android native library; web renders with its own renderer (WEB_MAP_RENDERER row).",
  },
  {
    id: "map-web-renderer",
    label: "WEB_MAP_RENDERER",
    cells: { LOCAL: I, CI: I, RELEASE: N, WEB: I, DOCKER: I, LIVE: N },
    notes: "The web picker DOES render a map: keyless 3×3 OSM raster tile grid with zoom.",
    justification:
      "RELEASE N/A because the shipped Android APK uses the native renderer; LIVE N/A because tile rendering is a client capability.",
  },
];

/** The capability-rule pins: capability exists on the lane ⇒ never N/A. */
const CAPABILITY_PINS = [
  { row: "google-auth-web-oauth", lane: "WEB" },
  { row: "klipy", lane: "WEB" },
  { row: "map-web-renderer", lane: "WEB" },
];

function rowById(matrix, id) {
  return matrix.find((r) => r.id === id);
}

export function checkMatrixInvariants(matrix = MATRIX) {
  const problems = [];
  const ids = new Set();
  for (const row of matrix) {
    if (ids.has(row.id)) problems.push(`duplicate row id: ${row.id}`);
    ids.add(row.id);
    if (!row.label || !row.notes) problems.push(`row ${row.id} is missing label/notes`);
    for (const lane of LANES) {
      const status = row.cells?.[lane];
      if (!STATUSES.includes(status)) {
        problems.push(`row ${row.id} lane ${lane} has unknown status: ${String(status)}`);
        continue;
      }
      if (Object.keys(row.cells).length !== LANES.length) {
        problems.push(`row ${row.id} must declare all ${LANES.length} lanes`);
        break;
      }
    }
    const hasNa = Object.values(row.cells).includes(N);
    if (hasNa && (!row.justification || row.justification.trim().length < 20)) {
      problems.push(`row ${row.id} has a NOT_APPLICABLE cell without a justification sentence`);
    }
    if (!hasNa && row.justification) {
      problems.push(`row ${row.id} carries a justification but has no NOT_APPLICABLE cell`);
    }
  }
  for (const pin of CAPABILITY_PINS) {
    const row = rowById(matrix, pin.row);
    if (!row) {
      problems.push(`capability pin references unknown row: ${pin.row}`);
      continue;
    }
    if (row.cells[pin.lane] === N) {
      problems.push(
        `capability rule violated: ${pin.row} is NOT_APPLICABLE on ${pin.lane} although the product feature exists there`,
      );
    }
  }
  return problems;
}

export function renderMarkdown(matrix = MATRIX) {
  const header = `| Area | ${LANES.join(" | ")} | Notes |`;
  const sep = `|---|${LANES.map(() => "---").join("|")}|---|`;
  const rows = matrix.map(
    (r) => `| ${r.label} | ${LANES.map((l) => r.cells[l]).join(" | ")} | ${r.notes} |`,
  );
  return [header, sep, ...rows].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkMatrixInvariants();
  if (process.argv.includes("--markdown")) {
    console.log(renderMarkdown());
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`cross-environment-matrix: ${p}`);
    process.exitCode = 1;
  } else if (!process.argv.includes("--markdown")) {
    console.log(`cross-environment-matrix: PASS (${MATRIX.length} rows, ${LANES.length} lanes)`);
  }
}

// Keep the module importable from the repo root without a cwd assumption.
void dirname(fileURLToPath(import.meta.url));
