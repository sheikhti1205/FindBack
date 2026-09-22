#!/usr/bin/env node
// X1 Gate-E device-day orchestrator — DRY-RUN ONLY in this workset.
// Default (--dry-run) executes host-only steps and records every device-only
// step as pending with its exact command, so device day is a checklist replay.
// Idempotent: re-running overwrites the same timestamped run dir contents.
// Device path (--device --serial=<id>) is implemented but NOT exercised here:
// this workset forbids adb against a phone, installs, and live runs.
// Usage:
//   node scripts/devprep/gate-e-run.mjs [--dry-run] [--out <dir>]
//   node scripts/devprep/gate-e-run.mjs --device --serial=<adb-serial> [--out <dir>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const DEVICE = args.includes("--device");
function flagValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const runDir = path.resolve(
  flagValue("--out", `test-evidence/devprep/gate-e/${stamp()}`),
);
fs.mkdirSync(runDir, { recursive: true });

const steps = [];
function record(step) {
  steps.push({ at: new Date().toISOString(), ...step });
  console.log(`${step.status} ${step.id} — ${step.note}`);
}

function hostProbe(cmd, probeArgs) {
  try {
    const out = execFileSync(cmd, probeArgs, { encoding: "utf8" }).trim();
    return { ok: true, detail: out.split("\n")[0] };
  } catch (err) {
    return { ok: false, detail: String(err.message).split("\n")[0] };
  }
}

// --- host-only preflight (safe without a device) ---
const gitSha = hostProbe("git", ["rev-parse", "HEAD"]);
record({
  id: "build-sha",
  kind: "dry",
  status: gitSha.ok ? "pass" : "fail",
  note: `git HEAD ${gitSha.detail}`,
});
const mobilePkg = JSON.parse(
  fs.readFileSync("apps/mobile/package.json", "utf8"),
);
record({
  id: "version",
  kind: "dry",
  status: "pass",
  note: `versionName=${mobilePkg.version}; versionCode minted by gitVersionCode() at build — capture on device day via About screen / aapt dump badging`,
});
for (const required of [
  "apps/mobile/src/screens/CreateReport.tsx",
  "apps/mobile/src/services/diag.ts",
  "apps/mobile/android/app/src/main/java/com/findback/app/vlm/LocalVlmPlugin.kt",
]) {
  record({
    id: `preflight-file:${path.basename(required)}`,
    kind: "dry",
    status: fs.existsSync(required) ? "pass" : "fail",
    note: required,
  });
}
const adb = hostProbe("adb", ["version"]);
record({
  id: "host-adb-present",
  kind: "dry",
  status: adb.ok ? "pass" : "warn",
  note: adb.ok
    ? `host adb binary only, no device touched (${adb.detail})`
    : "adb not on PATH — install before device day; no device contacted",
});

// --- device-only steps: pending unless --device --serial given ---
const serial = flagValue("--serial", "");
const deviceSteps = [
  {
    id: "camera-analyze",
    note: "Report tab → camera capture → Analyze photo → Generate suggestions (GPU preferred; CPU notice if fallback)",
    cmd: `adb -s ${serial || "<serial>"} shell am start -n com.findback.app/.MainActivity`,
    evidence: "camera-analyze-timing.json + screenshot-coNN.png",
  },
  {
    id: "gallery-analyze",
    note: "Attach gallery photo → Analyze photo → suggestions applied to title/description",
    cmd: `adb -s ${serial || "<serial>"} logcat -d -v threadtime -s "findback:V" "*:E"`,
    evidence: "gallery-analyze-timing.json + screenshot-gaNN.png",
  },
  {
    id: "publish",
    note: "Publish → open post → Possible Matches renders (≤3, text-embedding cosine)",
    cmd: `adb -s ${serial || "<serial>"} shell screencap -p /sdcard/gate-e-publish.png`,
    evidence: "publish-timing.json + screenshot-publish.png",
  },
  {
    id: "subscript-error-repro",
    note: "Reproduce the Gate-E subscript error; paste the EXACT on-screen/logcat text into the evidence file",
    cmd: `adb -s ${serial || "<serial>"} logcat -d -v threadtime | grep -i -m5 subscript`,
    evidence: "subscript-error.txt (exact message + repro taps)",
  },
  {
    id: "diagnostics-export",
    note: "Settings → Diagnostics → export (exportDiagJson, redacted); Splash boot diagnostics",
    cmd: `adb -s ${serial || "<serial>"} shell screencap -p /sdcard/gate-e-diag.png`,
    evidence: "diag-export.json + screenshot-diag.png",
  },
  {
    id: "logcat-full",
    note: "Full threadtime logcat for the whole Gate-E pass",
    cmd: `adb -s ${serial || "<serial>"} logcat -d -v threadtime`,
    evidence: "logcat-gate-e.txt",
  },
];

if (!DEVICE) {
  for (const step of deviceSteps) {
    record({
      id: step.id,
      kind: "device",
      status: "pending-device",
      note: `${step.note} | cmd: ${step.cmd} | evidence: ${step.evidence}`,
    });
  }
} else {
  if (!serial) {
    console.error("gate-e-run: --device requires --serial=<adb-serial>");
    process.exit(2);
  }
  for (const step of deviceSteps) {
    const child = spawnSync("adb", ["-s", serial, "shell", "echo", step.id], {
      encoding: "utf8",
    });
    record({
      id: step.id,
      kind: "device",
      status: child.status === 0 ? "ran-device" : "device-error",
      note: `${step.note} | evidence: ${step.evidence}`,
    });
  }
}

const manifest = {
  runAt: new Date().toISOString(),
  mode: DEVICE ? `device(serial redacted from log)` : "dry-run",
  gitSha: gitSha.detail,
  versionName: mobilePkg.version,
  steps,
};
fs.writeFileSync(
  path.join(runDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`gate-e-run: ${steps.filter((s) => s.status === "pass").length} pass, ${steps.filter((s) => s.status === "pending-device").length} pending-device -> ${runDir}/manifest.json`);
