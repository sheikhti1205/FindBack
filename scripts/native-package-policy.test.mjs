import test from "node:test";
import assert from "node:assert/strict";
import { validateNativePackage, retiredDexOwners, classifyPackageEntry, USE_ASSET } from "./native-package-policy.mjs";

const qualified = [USE_ASSET, "classes.dex", "lib/arm64-v8a/libmediapipe_tasks_jni.so", "lib/arm64-v8a/libfindback_needle.so"];
test("strict qualified retained entries pass without a rejected runtime", () => {
  assert.deepEqual(validateNativePackage(qualified, { strict: true }), []);
});
for (const name of ["liblitertlm_jni.so", "libfindback_llama.so", "libllama.so", "libggml-base.so", "libggml-cpu.so", "libmtmd.so", "libprobe.so"]) {
  test(`rejects ${name} in every mode`, () => {
    for (const strict of [false, true]) assert.ok(validateNativePackage([...qualified, `lib/x86_64/${name}`], { strict }).some((e) => e.includes("retired runtime library")));
  });
}
for (const suffix of ["litertlm", "gguf", "cact", "tflite"]) {
  test(`rejects bundled .${suffix} weights`, () => {
    assert.ok(validateNativePackage([...qualified, `assets/models/retired/model.${suffix}`]).some((e) => e.includes("forbidden model asset")));
  });
}
test("all shipped ABIs require embeddings; arm64 additionally requires Needle", () => {
  assert.ok(validateNativePackage([USE_ASSET, "lib/arm64-v8a/libmediapipe_tasks_jni.so"], { strict: true }).some((e) => e.includes("Needle")));
  assert.ok(validateNativePackage([...qualified, "lib/x86_64/libc++_shared.so"], { strict: true }).some((e) => e.includes("embedding JNI missing: x86_64")));
  assert.deepEqual(validateNativePackage([USE_ASSET, "lib/armeabi-v7a/libmediapipe_tasks_jni.so"], { strict: true }), []);
});
test("strict mode never accepts a missing USE asset or all-empty native ABI set", () => {
  assert.ok(validateNativePackage(qualified.filter((e) => e !== USE_ASSET), { strict: true }).some((e) => e.includes("USE")));
  assert.ok(validateNativePackage([USE_ASSET], { strict: true }).some((e) => e.includes("no native")));
});
test("DEX descriptor rejection includes secondary DEX and does not reject old-file cleanup labels", () => {
  assert.deepEqual(retiredDexOwners(Buffer.from("qwen3-smol-llama cleanup identity")), []);
  for (const descriptor of ["Lcom/google/ai/edge/litertlm/Engine;", "Lcom/findback/app/llama/LlamaBridge;", "Lcom/findback/app/ai/QwenTextPlugin;", "Lcom/findback/app/vlm/SmolVlmPlugin;"]) {
    assert.equal(retiredDexOwners(Buffer.from(descriptor)).length, 1);
  }
});

test("rejects the retired probe library in strict and non-strict modes", () => {
  for (const strict of [false, true]) {
    assert.ok(validateNativePackage([...qualified, "lib/arm64-v8a/libfindback_probe.so"], { strict })
      .some((e) => e.includes("retired runtime library")));
  }
});

test("rejects every exact retired helper descriptor but keeps retained vlm owners", () => {
  const retired = [
    "Lcom/findback/app/ai/QwenTextPolicy;",
    "Lcom/findback/app/ai/LiteRtArtifactPolicy;",
    "Lcom/findback/app/ai/ThoughtEnvelope;",
    "Lcom/findback/app/vlm/NativeProbe;",
    "Lcom/findback/app/vlm/DeviceProbe;",
    "Lcom/findback/app/vlm/LiteRtBackend;",
    "Lcom/findback/app/vlm/LiteRtComputeBackend;",
    "Lcom/findback/app/vlm/VisionLanguageSplit;",
    "Lcom/findback/app/vlm/GpuProbePassRecord;",
    "Lcom/findback/app/vlm/RuntimeOperationGate;",
    "Lcom/findback/app/vlm/RuntimeTimingRunner;",
    "Lcom/findback/app/vlm/LiteRtBackendKt;",
  ];
  for (const descriptor of retired) {
    assert.equal(retiredDexOwners(Buffer.from(descriptor)).length, 1, descriptor);
  }
  for (const retained of ["Lcom/findback/app/vlm/EmbeddingPlugin;", "Lcom/findback/app/vlm/FindBackDiagPlugin;", "Lcom/findback/app/download/ModelDownloadPlugin;"]) {
    assert.deepEqual(retiredDexOwners(Buffer.from(retained)), [], retained);
  }
});

test("classifies every DEX entry regardless of directory or filename case", () => {
  for (const entry of ["classes.dex", "classes2.dex", "CLASSES2.DEX", "assets/legacy/runtime.dex", "res/raw/runtime.dex"]) {
    const kind = classifyPackageEntry(entry);
    assert.equal(kind.isDex, true, entry);
    assert.equal(kind.isTextScan, true, entry);
  }
  assert.deepEqual(classifyPackageEntry("lib/arm64-v8a/libfindback_needle.so"), { isDex: false, isTextScan: false });
  assert.deepEqual(classifyPackageEntry("assets/models/use/universal_sentence_encoder.tflite"), { isDex: false, isTextScan: true });
});

test("rejects unknown or case-invalid ABI directories instead of treating them as ABIs", () => {
  for (const abi of ["not-an-android-abi", "ARM64-V8A", "arm64_v8a"]) {
    const errors = validateNativePackage([USE_ASSET, `lib/${abi}/libmediapipe_tasks_jni.so`], { strict: true });
    assert.ok(errors.some((e) => e.includes(`unsupported native ABI directory: ${abi}`)), abi);
  }
  assert.deepEqual(validateNativePackage([USE_ASSET, "lib/armeabi-v7a/libmediapipe_tasks_jni.so"], { strict: true }), []);
  assert.deepEqual(validateNativePackage([USE_ASSET, "lib/x86_64/libmediapipe_tasks_jni.so"], { strict: true }), []);
});
