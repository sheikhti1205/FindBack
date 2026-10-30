import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const native = new URL("../apps/mobile/android/app/src/main/", import.meta.url);
const read = (path) => readFileSync(new URL(path, native), "utf8");

// Structural integration guards, not an on-device MapLibre rendering proof.
test("manifest application initializes MapLibre before any activity or bridge call", () => {
  assert.match(read("AndroidManifest.xml"), /android:name="\.FindbackApp"/);
  const app = read("java/com/findback/app/FindbackApp.kt");
  assert.match(app, /override fun onCreate\(\)\s*\{\s*super\.onCreate\(\)\s*MapLibre\.getInstance\(this\)/);
});

test("main-queue snapshot construction and start are inside the failure boundary", () => {
  const service = read("java/com/findback/app/map/MapSnapshotService.kt");
  const start = service.slice(service.indexOf("fun start()"), service.indexOf("if (Looper.myLooper()"));
  assert.ok(start.indexOf("try {") >= 0, "start itself must catch; the caller cannot catch an asynchronously posted exception");
  assert.ok(start.indexOf("try {") < start.indexOf("MapSnapshotter.Options"));
  assert.ok(start.indexOf("try {") < start.indexOf("MapSnapshotter(appContext"));
  assert.match(start, /\}\s*catch \(e: Exception\) \{\s*main\.removeCallbacks\(timeout\)\s*settle\(Result\.failure\(SnapshotFailedException/);
});
