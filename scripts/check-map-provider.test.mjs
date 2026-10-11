import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBannedHits, checkMapLibrePin, checkMapProvider, readPin } from "./check-map-provider.mjs";

/** Fake FS matched by path suffix (the gate resolves files against repo root). */
function reader(files) {
  return (path) => {
    const key = Object.keys(files).find((suffix) => path.endsWith(suffix));
    if (!key) throw new Error(`unreadable: ${path}`);
    return files[key];
  };
}

const REL = {
  variables: "apps/mobile/android/variables.gradle",
  buildGradle: "apps/mobile/android/app/build.gradle",
  plugin: "apps/mobile/android/app/src/main/java/com/findback/app/map/FindbackMapPlugin.kt",
};

function baseFiles() {
  return {
    [REL.variables]: "mapLibreVersion = '13.6.1'",
    [REL.buildGradle]: [
      'implementation "org.maplibre.gl:android-sdk-opengl:$mapLibreVersion"',
      'buildConfigField "String", "MAP_STYLE_URL"',
      'System.getenv("FINDBACK_MAP_STYLE_URL") ?: "https://tiles.openfreemap.org/styles/liberty"',
    ].join("\n"),
    [REL.plugin]: 'const val RENDERER_VERSION = "13.6.1"',
  };
}

test("flags banned hits per file and pattern", () => {
  const read = reader({
    "pkg.json": `{"dependencies": {"@capacitor/google-maps": "^8.0.1"}}`,
    "places.gradle": `implementation "com.google.android.libraries.places:places:3.5.0"`,
    "clean.gradle": `implementation "org.maplibre.gl:android-sdk-opengl:$mapLibreVersion"`,
  });
  assert.deepEqual(checkBannedHits(["pkg.json"], ["@capacitor/google-maps"], read), [
    "pkg.json: @capacitor/google-maps",
  ]);
  assert.deepEqual(
    checkBannedHits(["places.gradle"], ["com.google.android.libraries.places"], read),
    ["places.gradle: com.google.android.libraries.places"],
  );
  assert.deepEqual(checkBannedHits(["clean.gradle"], ["@capacitor/google-maps"], read), []);
  assert.deepEqual(checkBannedHits(["missing.gradle"], ["@capacitor/google-maps"], read), []);
});

test("reads the version pin", () => {
  assert.equal(readPin("mapLibreVersion = '13.6.1'"), "13.6.1");
  assert.equal(readPin("no pin here"), null);
});

test("rejects a drifted renderer version or missing style wiring", () => {
  assert.equal(checkMapLibrePin(reader(baseFiles())).ok, true);

  const drifted = baseFiles();
  drifted[REL.plugin] = 'const val RENDERER_VERSION = "9.9.9"';
  const result = checkMapLibrePin(reader(drifted));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /RENDERER_VERSION/);

  const unpinned = baseFiles();
  unpinned[REL.variables] = "no pin";
  assert.equal(checkMapLibrePin(reader(unpinned)).ok, false);

  const floating = baseFiles();
  floating[REL.buildGradle] = floating[REL.buildGradle].replace("$mapLibreVersion", "13.+");
  assert.match(checkMapLibrePin(reader(floating)).errors.join("\n"), /single version source/);
});

test("rejects a reintroduced Google Maps key reference", () => {
  const files = baseFiles();
  files[REL.buildGradle] += '\nmanifestPlaceholders = [googleMapsApiKey: googleMapsApiKey()]';
  const result = checkMapProvider(reader(files));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /GOOGLE_MAPS_API_KEY|googleMapsApiKey/);
});

test("live repo tree passes the provider gate", () => {
  const result = checkMapProvider();
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});
