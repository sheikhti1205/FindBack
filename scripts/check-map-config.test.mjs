import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import {
  BUILD_GRADLE_PATH,
  checkGradleMapSource,
  checkMapConfig,
  DEFAULT_MAP_CONTACT,
  DEFAULT_MAP_SEARCH_URL,
  DEFAULT_MAP_STYLE_URL,
  effectiveMapConfig,
  MAP_CONTACT_ENV,
  MAP_SEARCH_ENV,
  MAP_STYLE_ENV,
  mapPresence,
  validateMapContact,
  validateMapSearchUrl,
  validateMapStyleUrl,
} from "./check-map-config.mjs";

const script = resolve("scripts/check-map-config.mjs");

// loadEnv merges ambient process.env, so hermetic tests scrub the owner keys.
const ENV_KEYS = [MAP_STYLE_ENV, MAP_CONTACT_ENV, MAP_SEARCH_ENV];
const savedEnv = {};
beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function emptyEnvDir() {
  const dir = mkdtempSync(join(tmpdir(), "findback-map-owner-"));
  writeFileSync(join(dir, ".env.production"), "# intentionally empty\n");
  return dir;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, [MAP_STYLE_ENV]: "", [MAP_CONTACT_ENV]: "", [MAP_SEARCH_ENV]: "", ...env },
  });
}

test("absent custom config resolves to the owner-decided defaults on both sides", () => {
  const dir = emptyEnvDir();
  try {
    const config = effectiveMapConfig({ env: {}, envDir: dir });
    assert.equal(config.styleUrl, DEFAULT_MAP_STYLE_URL);
    assert.equal(config.contact, DEFAULT_MAP_CONTACT);
    assert.equal(config.styleSource, "default");
    assert.equal(config.contactSource, "default");
    assert.equal(mapPresence(config), "ABSENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("present custom config reaches both the map and the search side", () => {
  const dir = emptyEnvDir();
  const style = "https://tiles.example-provider.net/styles/bright";
  const contact = "https://contact.example-provider.net";
  try {
    const config = effectiveMapConfig({
      env: { [MAP_STYLE_ENV]: style, [MAP_CONTACT_ENV]: contact },
      envDir: dir,
    });
    assert.equal(config.styleUrl, style);
    assert.equal(config.contact, contact);
    assert.equal(config.styleSource, "custom");
    assert.equal(config.contactSource, "custom");
    assert.equal(mapPresence(config), "PRESENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed custom values fail closed instead of shipping half-applied", () => {
  const dir = emptyEnvDir();
  try {
    for (const bad of ["http://insecure.tiles/style", "not a url", "https://placeholder.tiles/style"]) {
      const result = checkMapConfig({ env: { [MAP_STYLE_ENV]: bad }, envDir: dir });
      assert.equal(result.ok, false, bad);
      assert.match(result.errors.join("\n"), new RegExp(MAP_STYLE_ENV));
    }
    const badContact = checkMapConfig({ env: { [MAP_CONTACT_ENV]: "has whitespace in it" }, envDir: dir });
    assert.equal(badContact.ok, false);
    assert.match(badContact.errors.join("\n"), new RegExp(MAP_CONTACT_ENV));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validators accept well-formed custom values and mirror the native rules", () => {
  assert.equal(validateMapStyleUrl("https://tiles.openfreemap.org/styles/liberty").ok, true);
  assert.equal(validateMapStyleUrl("http://tiles.openfreemap.org/styles/liberty").ok, false);
  assert.equal(validateMapStyleUrl("").ok, false);
  assert.equal(validateMapStyleUrl("https://example.com/style").ok, false);
  assert.equal(validateMapContact("https://findbackapp.social").ok, true);
  assert.equal(validateMapContact("").ok, false);
  assert.equal(validateMapContact("not a contact").ok, false);
});

test("Gradle source parity fails when build.gradle drifts from the owner", () => {
  const live = checkGradleMapSource();
  assert.deepEqual(live, [], `live build.gradle diverged: ${live.join("; ")}`);

  const driftedEnv = (path) => {
    if (!path.endsWith("app/build.gradle")) throw new Error(`unreadable: ${path}`);
    return "android { /* no map env reads here */ }";
  };
  const missing = checkGradleMapSource(driftedEnv);
  assert.ok(missing.some((error) => error.includes(MAP_STYLE_ENV)), missing.join("; "));
  assert.ok(missing.some((error) => error.includes(MAP_CONTACT_ENV)), missing.join("; "));
});

test("CLI passes with defaults and never prints values", () => {
  const custom = "https://custom-tiles-absent-from-logs.provider.net/styles/x";
  const ok = run([]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /style=DEFAULT contact=DEFAULT/);

  const customRun = run([], { [MAP_STYLE_ENV]: custom });
  assert.equal(customRun.status, 0, customRun.stderr);
  assert.match(customRun.stdout, /style=CUSTOM/);
  assert.doesNotMatch(customRun.stdout + customRun.stderr, /absent-from-logs/);
});

test("CLI fails closed on a malformed custom style without printing it", () => {
  const bad = "http://plaintext-tiles-never-in-logs.example.net/style";
  const result = run([], { [MAP_STYLE_ENV]: bad });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(MAP_STYLE_ENV));
  assert.doesNotMatch(result.stdout + result.stderr, /plaintext-tiles-never-in-logs/);
});

test("owner constants match the documented single source", () => {
  assert.equal(MAP_STYLE_ENV, "FINDBACK_MAP_STYLE_URL");
  assert.equal(MAP_CONTACT_ENV, "FINDBACK_MAP_CONTACT");
  assert.equal(MAP_SEARCH_ENV, "VITE_NOMINATIM_SEARCH_URL");
  assert.equal(DEFAULT_MAP_SEARCH_URL, "https://nominatim.openstreetmap.org/search");
  assert.ok(BUILD_GRADLE_PATH.endsWith("apps/mobile/android/app/build.gradle"));
});

test("search endpoint seam: absent resolves to default, custom validated, Gradle reads it", () => {
  const dir = emptyEnvDir();
  try {
    const absent = effectiveMapConfig({ env: {}, envDir: dir });
    assert.equal(absent.searchUrl, DEFAULT_MAP_SEARCH_URL);
    assert.equal(absent.searchSource, "default");
    const custom = "https://geocode.example-provider.net/search";
    const present = effectiveMapConfig({ env: { [MAP_SEARCH_ENV]: custom }, envDir: dir });
    assert.equal(present.searchUrl, custom);
    assert.equal(present.searchSource, "custom");
    assert.equal(mapPresence(present), "PRESENT");
    assert.equal(validateMapSearchUrl(DEFAULT_MAP_SEARCH_URL).ok, true);
    assert.equal(validateMapSearchUrl(custom).ok, true);
    for (const bad of ["http://insecure-geocode.example.net/search", "not a url", "https://placeholder-geocode.example.net/search"]) {
      assert.equal(validateMapSearchUrl(bad).ok, false, bad);
      const result = checkMapConfig({ env: { [MAP_SEARCH_ENV]: bad }, envDir: dir });
      assert.equal(result.ok, false, bad);
      assert.match(result.errors.join("\n"), new RegExp(MAP_SEARCH_ENV));
    }
    assert.equal(validateMapSearchUrl("").ok, false, "(empty validator)");
    const blank = checkMapConfig({ env: { [MAP_SEARCH_ENV]: " " }, envDir: dir });
    assert.equal(blank.ok, true, "blank resolves to default, never fails");
    assert.equal(blank.config.searchSource, "default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
