#!/usr/bin/env node
/** Source/build ownership only. APK/compiler/device verification remains separate. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export function checkNativeRetirement(root = resolve(import.meta.dirname, "..")) {
  const errors = [];
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const base = "apps/mobile/android/app/src/main";
  const gradle = read("apps/mobile/android/app/build.gradle");
  const cmake = read(`${base}/cpp/CMakeLists.txt`);
  const main = read(`${base}/java/com/findback/app/MainActivity.java`);
  if (/litertlm-android|fetchLlamaCpp|fetch-llama-cpp|implementation[^\n]*kotlinx-coroutines-android/.test(gradle)) errors.push("rejected app dependency or fetch owner remains");
  if (/findback_llama|findback_probe|third_party\/llama\.cpp/.test(cmake)) errors.push("rejected native CMake target remains");
  for (const name of ["FindbackNeedle", "EmbeddingPlugin", "FindBackDiagPlugin", "ModelDownloadPlugin"]) {
    if (!new RegExp(`registerPlugin\\(${name}\\.class\\)`).test(main)) errors.push(`retained registration missing: ${name}`);
  }
  for (const name of ["fetchUseModel", "fetchNeedleEngine", "com.google.mediapipe:tasks-text"]) {
    if (!gradle.includes(name)) errors.push(`retained dependency/fetch missing: ${name}`);
  }
  if (!/add_library\(findback_needle SHARED needle\/needle_bridge\.cpp\)/.test(cmake)) errors.push("retained Needle JNI target missing");
  function walk(dir) {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // Cached third-party trees are not app source and may contain historical inputs.
      if (entry.isDirectory()) { if (entry.name !== "third_party") walk(path); continue; }
      if (!/\.(?:java|kt|cpp|c)$/.test(entry.name)) continue;
      const text = read(path);
      if (/com\.google\.ai\.edge\.litertlm|System\.loadLibrary\("findback_(?:llama|probe)"\)|Java_com_findback_app_(?:llama_LlamaBridge|vlm_NativeProbe)_|class\s+(?:QwenTextPlugin|SmolVlmPlugin)\b/.test(text)) errors.push(`retired engine owner in ${path}`);
    }
  }
  walk(base);
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkNativeRetirement();
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("native-retirement: retained source/build owners present; rejected owners absent (not APK/device acceptance)");
}
