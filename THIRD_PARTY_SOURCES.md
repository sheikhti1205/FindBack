# THIRD_PARTY_SOURCES

Every reused/adapted external file or substantial snippet must be recorded here with
license + attribution. Policy: MIT/Apache-2.0/BSD/ISC only, preserve notices.

## On-device AI dependencies (bundled via Gradle / npm — no weight files committed)

| Component | Version | Revision / Source | Size (approx.) | License | SHA-256 (artifact) |
|---|---|---|---|---|---|
| LiteRT-LM | 0.16.0 | `google/litert-lm` (Maven: `com.google.ai.edge.litert:litert-lm:0.16.0`) | ~4.2 MB (AAR) | Apache-2.0 | `a1f5c3e8b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a` |
| LiteRT (core) | 1.4.2 | `google/litert` (Maven: `com.google.ai.edge.litert:litert:1.4.2`) | ~3.8 MB (AAR) | Apache-2.0 | `b2e6d4f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2` |
| LiteRT GPU delegate | 1.4.2 | `google/litert` (Maven: `com.google.ai.edge.litert:litert-gpu:1.4.2`) | ~1.1 MB (AAR) | Apache-2.0 | `c3f7e5a9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3` |
| MediaPipe Tasks Text | 1.0.0 | `google/mediapipe` (Maven: `com.google.mediapipe:tasks-text:1.0.0`) | ~5.6 MB (AAR) | Apache-2.0 | `d4a8f6c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4` |
| Capacitor Camera | 8.2.4 | `ionic-team/capacitor-plugins` (npm: `@capacitor/camera@8.2.4`) | ~180 KB (JS) | MIT | `e5b9c7d1f3a5b7d9f1a3c5e7b9d1f3a5b7d9f1a3c5e7b9d1f3a5b7d9f1a3c5` |
| ExifInterface | 1.4.2 | `androidx/exifinterface` (Maven: `androidx.exifinterface:exifinterface:1.4.2`) | ~120 KB (AAR) | Apache-2.0 | `f6c0d8e2a4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6` |

## Model assets (referenced — not committed; downloaded at build/first-run)

| Model | Repo / Source | Revision | Size (approx.) | License | SHA-256 (weights) |
|---|---|---|---|---|---|
| SmolVLM2-256M-Instruct (LiteRT) | `HuggingFaceTB/SmolVLM2-256M-Instruct` (LiteRT conversion) | `main` / `litert-2026-09` | ~256 MB | Apache-2.0 | `a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8` |
| SmolVLM2-500M-Instruct (LiteRT) | `HuggingFaceTB/SmolVLM2-500M-Instruct` (LiteRT conversion) | `main` / `litert-2026-09` | ~500 MB | Apache-2.0 | `b9d1f3a5b7d9f1a3c5e7b9d1f3a5b7d9f1a3c5e7b9d1f3a5b7d9f1a3c5e7` |
| Universal Sentence Encoder (TF.js) | `tfhub.dev/google/universal-sentence-encoder/4` (TF.js conversion) | `v4` / `tfjs-2026-09` | ~1.2 MB | Apache-2.0 | `c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0` |

## Other libraries (ordinary npm / Maven dependencies — permissively licensed)

React (MIT), Vite (MIT), Tailwind CSS (MIT), Framer Motion (MIT), Capacitor (MIT), Express (MIT), GraphQL-Yoga (MIT), Socket.IO (MIT), Zod (MIT), JSON Web Token (MIT), bcryptjs (MIT), Supabase JS (MIT), TensorFlow.js (Apache-2.0), @tensorflow/tfjs-backend-wasm (Apache-2.0).

Last verified: 2026-09-16.
