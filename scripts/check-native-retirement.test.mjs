import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { checkNativeRetirement } from "./check-native-retirement.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const native = "apps/mobile/android/app/src/main/";

test("retained native live source/build checker passes", () => {
  assert.deepEqual(checkNativeRetirement(root), []);
});

test("app native source has no rejected engines, but keeps embeddings and diagnostics", () => {
  for (const file of ["ai/QwenTextPlugin.kt", "vlm/SmolVlmPlugin.kt", "llama/FindbackLlama.kt", "vlm/RuntimeTimingRunner.kt", "vlm/DeviceProbe.kt", "vlm/NativeProbe.kt"]) {
    assert.equal(existsSync(resolve(root, native, "java/com/findback/app", file)), false, file);
  }
  for (const file of ["EmbeddingPlugin.kt", "UniversalSentenceEmbedder.kt", "Diag.kt"]) {
    assert.ok(existsSync(resolve(root, native, "java/com/findback/app/vlm", file)), file);
  }
  assert.match(read(native + "java/com/findback/app/download/ModelDownloadPlugin.kt"), /fun supportedAbis\([\s\S]*?Build\.SUPPORTED_ABIS/);
});

test("native build removes rejected acquisition/dependencies without removing Needle or USE", () => {
  const gradle = read("apps/mobile/android/app/build.gradle");
  const cmake = read(native + "cpp/CMakeLists.txt");
  assert.doesNotMatch(gradle, /fetchLlamaCpp|fetch-llama-cpp|litertlm-android|implementation[^\n]*kotlinx-coroutines-android/);
  assert.doesNotMatch(cmake, /findback_llama|third_party\/llama\.cpp|findback_probe/);
  assert.match(gradle, /fetchNeedleEngine/);
  assert.match(gradle, /fetchUseModel/);
  assert.match(gradle, /com\.google\.mediapipe:tasks-text/);
  assert.match(cmake, /add_library\(findback_needle SHARED needle\/needle_bridge\.cpp\)/);
  assert.match(cmake, /target_link_libraries\(findback_needle needle/);
});

test("strict package scanner rejects retired payloads instead of requiring LiteRT-LM", () => {
  const scanner = read("scripts/scan-apk.mjs");
  assert.doesNotMatch(scanner, /missingVision|visionAbis|vision JNI missing/);
  assert.match(scanner, /validateNativePackage/);
  assert.match(scanner, /SECRETS/);
  assert.match(scanner, /zipalign/);
});

/* ---------------------------------------------------------------------------
 * Behavioural scanner regression.
 *
 * The string checks above cannot tell a working ownership scan from one that
 * silently stopped reading shaded DEX. These cases run the real `scan-apk.mjs`
 * against a synthetic stored ZIP, so reverting the traversal to canonical-root
 * `classes*.dex` fails here instead of passing quietly.
 * ------------------------------------------------------------------------- */

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Minimal STORED zip: enough for `unzip -Z1` / `unzip -p`, no dependency. */
function storedZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, contents] of files) {
    const data = Buffer.from(contents);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);

    local.push(header, nameBytes, data);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function scanSyntheticApk(files) {
  const directory = mkdtempSync(join(tmpdir(), "findback-scan-apk-"));
  try {
    const apk = join(directory, "synthetic.apk");
    writeFileSync(apk, storedZip(files));
    try {
      const stdout = execFileSync(process.execPath, [resolve(root, "scripts/scan-apk.mjs"), apk], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output: stdout };
    } catch (error) {
      return { status: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the real scanner rejects retired owners in shaded DEX, not only classes*.dex", () => {
  const payloads = [
    ["assets/legacy/runtime.dex", "Lcom/findback/app/vlm/LiteRtBackend;"],
    ["res/raw/runtime.dex", "Lcom/google/ai/edge/litertlm/Engine;"],
    ["CLASSES2.DEX", "Lcom/findback/app/llama/LlamaBridge;"],
    ["lib/arm64-v8a/payload.dex", "Lcom/findback/app/vlm/SmolVlmPlugin;"],
    ["assets/legacy/runtime.dex", "Lcom/findback/app/vlm/GpuProbePassRecord;"],
    ["assets/legacy/runtime.dex", "Lcom/findback/app/vlm/VisionLanguageSplit;"],
    ["assets/legacy/runtime.dex", "Lcom/findback/app/vlm/LiteRtBackendKt;"],
  ];
  for (const [entry, descriptor] of payloads) {
    const result = scanSyntheticApk([[entry, `dex\n035\0${descriptor}`]]);
    assert.notEqual(result.status, 0, `${entry} should fail the scan`);
    assert.match(result.output, /retired runtime class ownership/, `${entry} ${descriptor}`);
  }
});

test("the same scanner path does not flag a DEX with no retired owner", () => {
  const result = scanSyntheticApk([["assets/legacy/runtime.dex", "dex\n035\0Lcom/findback/app/vlm/EmbeddingPlugin;"]]);
  assert.doesNotMatch(result.output, /retired runtime class ownership/);
});
