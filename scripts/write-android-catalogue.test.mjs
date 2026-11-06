import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCatalogue } from "./write-android-catalogue.mjs";

const SHA = "a".repeat(40);
const SIGNER = "b".repeat(64);

function workspace(apks) {
  const dir = mkdtempSync(join(tmpdir(), "norfold-catalogue-"));
  for (const [name, body] of Object.entries(apks)) writeFileSync(join(dir, name), body);
  return { dir, files: Object.keys(apks) };
}

function fact(abi, extra = {}) {
  return {
    abi,
    abis: [abi],
    packageName: "com.findback.app",
    versionName: "0.14.0-beta.1",
    versionCode: 100123,
    minSdk: 24,
    targetSdk: 36,
    signerSha256: SIGNER,
    ...extra,
  };
}

function options(overrides = {}) {
  const { dir, files } = workspace({
    "Norfold-abc123-arm64-v8a.apk": Buffer.from("arm64 bytes"),
    "Norfold-abc123-armeabi-v7a.apk": Buffer.from("arm32 bytes"),
    "Norfold-abc123-universal.apk": Buffer.from("universal bytes"),
  });
  return {
    facts: [fact("arm64-v8a"), fact("armeabi-v7a"), fact("universal", { abis: ["arm64-v8a", "armeabi-v7a"] })],
    apkDir: dir,
    files,
    repo: "sheikhti1205/Norfold",
    tag: "android-latest",
    releaseId: "v0.14.0-beta.1+abc123def456",
    versionName: "0.14.0-beta.1",
    versionCode: 100123,
    gitSha: SHA,
    publishedAt: "2026-11-06T10:00:00Z",
    summary: "Latest main build.",
    signingChannel: "beta",
    ...overrides,
  };
}

test("describes every single-ABI APK with the bytes it really staged", () => {
  const catalogue = buildCatalogue(options());
  assert.equal(catalogue.schemaVersion, 1);
  const [release] = catalogue.releases;
  assert.equal(release.accepted, true);
  assert.equal(release.versionCode, 100123);
  assert.deepEqual(release.artifacts.map((artifact) => artifact.abis), [["arm64-v8a"], ["armeabi-v7a"]]);
  for (const artifact of release.artifacts) {
    assert.match(artifact.url, /^https:\/\/github\.com\/sheikhti1205\/Norfold\/releases\/download\/android-latest\//);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifact.bytes > 0);
    assert.equal(artifact.signingChannel, "beta");
    assert.equal(artifact.packageName, "com.findback.app");
  }
  const arm64 = release.artifacts[0];
  assert.equal(arm64.sha256, createHash("sha256").update(Buffer.from("arm64 bytes")).digest("hex"));
});

test("never offers the universal APK as a separate download", () => {
  const catalogue = buildCatalogue(options());
  assert.ok(!catalogue.releases[0].artifacts.some((artifact) => artifact.url.includes("universal")));
});

test("fails closed when a verified ABI has no staged APK", () => {
  const { dir } = workspace({ "Norfold-abc123-arm64-v8a.apk": Buffer.from("only arm64") });
  assert.throws(
    () => buildCatalogue(options({ apkDir: dir, files: ["Norfold-abc123-arm64-v8a.apk"] })),
    /exactly one staged APK for armeabi-v7a, found 0/,
  );
});

test("fails closed when two staged APKs claim the same ABI", () => {
  const { dir } = workspace({
    "Norfold-a-arm64-v8a.apk": Buffer.from("a"),
    "Norfold-b-arm64-v8a.apk": Buffer.from("b"),
  });
  assert.throws(
    () => buildCatalogue(options({ apkDir: dir, files: ["Norfold-a-arm64-v8a.apk", "Norfold-b-arm64-v8a.apk"], facts: [fact("arm64-v8a")] })),
    /exactly one staged APK for arm64-v8a, found 2/,
  );
});

test("refuses a version that disagrees with the verified APKs", () => {
  assert.throws(() => buildCatalogue(options({ versionCode: 999999 })), /disagrees with the verified APKs/);
});

test("refuses a foreign package, a non-SemVer version or an empty summary", () => {
  assert.throws(() => buildCatalogue(options({ facts: [fact("arm64-v8a", { packageName: "com.example.app" })] })), /packageName is not/);
  assert.throws(() => buildCatalogue(options({ versionName: "latest" })), /--version-name is not SemVer/);
  assert.throws(() => buildCatalogue(options({ summary: "   " })), /--summary is empty/);
  assert.throws(() => buildCatalogue(options({ gitSha: "abc" })), /--git-sha is not a commit SHA/);
});

test("refuses mixed builds inside one facts file", () => {
  assert.throws(
    () => buildCatalogue(options({ facts: [fact("arm64-v8a"), fact("armeabi-v7a", { versionCode: 100999 })] })),
    /mixes builds/,
  );
});

test("refuses a tag that would break the download path", () => {
  assert.throws(() => buildCatalogue(options({ tag: "android latest" })), /--tag must not contain whitespace/);
});

test("successive publications retain changelogs and bundled history without inventing old download verification", () => {
  const baseline=JSON.parse(readFileSync(new URL('../apps/mobile/public/updates/catalogue.v1.json',import.meta.url),'utf8'));
  const first=buildCatalogue(options({baseline}));
  const second=buildCatalogue(options({baseline,previous:first,releaseId:'android-second',versionCode:100124,
    facts:[fact('arm64-v8a',{versionCode:100124})],publishedAt:'2026-11-07T10:00:00Z'}));
  assert.equal(second.releases.length,1);
  assert.deepEqual(second.history.find(h=>h.id===first.releases[0].id),{
    id:first.releases[0].id,versionName:first.releases[0].versionName,publishedAt:first.releases[0].publishedAt,
    summary:first.releases[0].summary,downloadStatus:'unverified',
  });
  for(const record of baseline.history) assert.deepEqual(second.history.find(h=>h.id===record.id),record);
  const third=buildCatalogue(options({baseline,previous:second,releaseId:'android-third',versionCode:100125,
    facts:[fact('arm64-v8a',{versionCode:100125})],publishedAt:'2026-11-08T10:00:00Z'}));
  assert.ok(third.history.some(h=>h.id===first.releases[0].id));
  assert.ok(third.history.some(h=>h.id==='android-second'));
});

test("bounds rolling build history while preserving canonical historical records",()=>{
  const baseline=JSON.parse(readFileSync(new URL('../apps/mobile/public/updates/catalogue.v1.json',import.meta.url),'utf8'));
  const previous={releases:[],history:Array.from({length:130},(_,i)=>({id:`build-${i}`,versionName:'0.14.0-beta.1',publishedAt:new Date(Date.UTC(2026,9,1,i)).toISOString(),summary:`Build ${i}`,downloadStatus:'unverified'}))};
  const next=buildCatalogue(options({baseline,previous}));
  assert.equal(next.history.length,102);
  assert.ok(next.history.some(h=>h.id==='build-129'));
  assert.ok(!next.history.some(h=>h.id==='build-0'));
  assert.ok(Buffer.byteLength(JSON.stringify(next))<128*1024);
});
