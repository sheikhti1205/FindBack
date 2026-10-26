/** Entry/DEX ownership policy. These checks do not prove model qualification or disk durability. */
export const USE_ASSET = "assets/models/use/universal_sentence_encoder.tflite";

/** Standard Android ABI directory names. An arbitrary `lib/<name>/` is not an ABI. */
const ANDROID_ABIS = new Set([
  "arm64-v8a", "armeabi-v7a", "armeabi", "x86", "x86_64", "riscv64", "mips", "mips64",
]);

/**
 * Every DEX entry is ownership-checked regardless of directory or filename case;
 * assets/res-raw entries are additionally secret-scanned. Shared with the scanner
 * so the policy and the traversal cannot drift apart.
 */
export function classifyPackageEntry(entry) {
  const isDex = /\.dex$/i.test(entry);
  return { isDex, isTextScan: isDex || entry.startsWith("assets/") || entry.startsWith("res/raw/") };
}

export function validateNativePackage(entries, { strict = false } = {}) {
  const errors = [];
  for (const entry of entries) {
    if (/\.(?:litertlm|gguf|cact|tflite)$/i.test(entry) && entry !== USE_ASSET) {
      errors.push(`forbidden model asset: ${entry}`);
    }
    if (/^lib\/[^/]+\/lib(?:litertlm[^/]*|findback_llama|findback_probe|llama(?:[-_][^/]*)?|ggml(?:[-_][^/]*)?|mtmd|probe)\.so$/i.test(entry)) {
      errors.push(`retired runtime library: ${entry}`);
    }
  }
  const abis = [...new Set(
    entries.map((e) => /^lib\/([^/]+)\/[^/]+$/.exec(e)?.[1]).filter(Boolean),
  )];
  for (const abi of abis) {
    if (!ANDROID_ABIS.has(abi)) errors.push(`unsupported native ABI directory: ${abi}`);
  }
  if (strict) {
    if (!entries.includes(USE_ASSET)) errors.push("required USE asset missing");
    if (!abis.length) errors.push("no native libraries present");
    for (const abi of abis) {
      if (!entries.includes(`lib/${abi}/libmediapipe_tasks_jni.so`)) errors.push(`embedding JNI missing: ${abi}`);
      // Needle is currently qualified only on arm64; do not pretend other ABIs ship it.
      if (abi === "arm64-v8a" && !entries.includes(`lib/${abi}/libfindback_needle.so`)) errors.push(`Needle JNI missing: ${abi}`);
    }
  }
  return errors;
}

export function retiredDexOwners(bytes) {
  const text = typeof bytes === "string" ? bytes : bytes.toString("latin1");
  // Match class descriptors, not prose/model cleanup IDs. R8 must not ship these owners.
  // Exact retired helpers are listed individually: the rest of `vlm` (embeddings,
  // Diag) is retained, so a package-wide prefix rejection would be wrong.
  return [
    "Lcom/google/ai/edge/litertlm/",
    "Lcom/findback/app/llama/",
    "Lcom/findback/app/ai/QwenTextPlugin;",
    "Lcom/findback/app/ai/QwenTextPolicy;",
    "Lcom/findback/app/ai/LiteRtArtifactPolicy;",
    "Lcom/findback/app/ai/ThoughtEnvelope;",
    "Lcom/findback/app/vlm/SmolVlmPlugin;",
    "Lcom/findback/app/vlm/NativeProbe;",
    "Lcom/findback/app/vlm/DeviceProbe;",
    "Lcom/findback/app/vlm/LiteRtBackend;",
    // Top-level types declared in the deleted LiteRtBackend.kt. They have no live
    // Kotlin referent, so a DEX containing only one of them is stale payload.
    "Lcom/findback/app/vlm/LiteRtComputeBackend;",
    "Lcom/findback/app/vlm/VisionLanguageSplit;",
    "Lcom/findback/app/vlm/GpuProbePassRecord;",
    // Compiler-generated facade for that file's top-level declarations.
    "Lcom/findback/app/vlm/LiteRtBackendKt;",
    "Lcom/findback/app/vlm/RuntimeOperationGate;",
    "Lcom/findback/app/vlm/RuntimeTimingRunner;",
  ].filter((owner) => text.includes(owner));
}
