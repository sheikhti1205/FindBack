# THIRD_PARTY_SOURCES

Every reused/adapted external file or substantial snippet must be recorded here with
license + attribution. Policy: MIT/Apache-2.0/BSD/ISC only, preserve notices.

## On-device AI dependencies (bundled via Gradle / npm — no weight files committed)

| Component | Version | Revision / Source | Size (approx.) | License | SHA-256 (artifact) |
|---|---|---|---|---|---|
| LiteRT-LM | 0.16.0 | `litert-community` (Maven: `com.google.ai.edge.litertlm:litertlm-android:0.16.0`) | ~4.2 MB (AAR) | Apache-2.0 | not recorded |
| LiteRT (core) | 1.4.2 | `google/litert` (Maven: `com.google.ai.edge.litert:litert:1.4.2`) | ~3.8 MB (AAR) | Apache-2.0 | not recorded |
| LiteRT GPU delegate | 1.4.2 | `google/litert` (Maven: `com.google.ai.edge.litert:litert-gpu:1.4.2`) | ~1.1 MB (AAR) | Apache-2.0 | not recorded |
| MediaPipe Tasks Text | 1.0.0 | `google/mediapipe` (Maven: `com.google.mediapipe:tasks-text:1.0.0`) | ~5.6 MB (AAR) | Apache-2.0 | not recorded |
| Capacitor Camera | 8.2.4 | `ionic-team/capacitor-plugins` (npm: `@capacitor/camera@8.2.4`) | ~180 KB (JS) | MIT | not recorded |
| ExifInterface | 1.4.2 | `androidx/exifinterface` (Maven: `androidx.exifinterface:exifinterface:1.4.2`) | ~120 KB (AAR) | Apache-2.0 | not recorded |

## Model assets (referenced — not committed; downloaded at build/first-run)

| Model | Repo / Source | Revision | Size (approx.) | License | SHA-256 (weights) |
|---|---|---|---|---|---|
| SmolVLM2-500M (LiteRT) | `litert-community/SmolVLM2-500M` (`SmolVLM2-500M.litertlm`) | `dad030b6e56756201d670cfb4d042736a2ce3a5c` | 360822960 B (~361 MB) | Apache-2.0 | `b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0` (verified: native manifest + chunk provenance + shipped catalogue agree) |
| SmolVLM 256M (TFLite, diagnostic/storage compatibility only — never offered for report generation) | `litert-community/SmolVLM-256M-Instruct` (TFLite `smolvlm-256m-instruct_q8_ekv2048_single_image.tflite` + `tokenizer.model`) | `dc16f6046d86c646bcc5dfe249c879d028f8b2f2` | 288229208 B + 881895 B (~288 MB) | Apache-2.0 | TFLite `48991855eb6365aae8cd1d8fe3013e6059dfea44b4ae26dd76dfa2a942dba3c4`, tokenizer `6682f47d3b33538490b21265ba3b2a83f8d48e09dcd7f957b46b508abb427a04` (verified: native manifest + chunk provenance agree) |
| Universal Sentence Encoder (native MediaPipe TextEmbedder asset) | app asset `models/use/universal_sentence_encoder.tflite` via MediaPipe `TextEmbedder` (no TF.js/WASM path) | not recorded | ~1.2 MB | Apache-2.0 | not recorded |

## Other libraries (ordinary npm / Maven dependencies — permissively licensed)

React (MIT), Vite (MIT), Tailwind CSS (MIT), Framer Motion (MIT), Capacitor (MIT), Express (MIT), GraphQL-Yoga (MIT), Socket.IO (MIT), Zod (MIT), JSON Web Token (MIT), bcryptjs (MIT), Supabase JS (MIT).

Last verified: 2026-09-22 (dependency versions re-checked against `apps/mobile/android/app/build.gradle`, `apps/mobile/android/variables.gradle`, and `apps/mobile/package.json`; AAR/JS artifact hashes recorded as `not recorded` — no measured digests exist in-tree; model pins re-checked against `VlmManifests.kt`, `apps/mobile/android/app/src/main/assets/chunks/PROVENANCE.md`, and `docs/specs/model-library/catalogue.v1.json`).
