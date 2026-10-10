---
name: findback-ai-runtime
description: Use when adding, routing, benchmarking, downloading, promoting, or debugging local/cloud AI models, runtimes, model pickers, report-photo analysis, assistant chat, extraction, embeddings, STT, or TTS in FindBack.
---

# FindBack AI runtime quality

## Separate axes

Do not conflate model artifact, runtime, modality, product role, maturity, privacy mode, or residency. A model may support multiple roles only after each role is qualified.

## Chat routing

A vision model that is vision-only in FindBack must never be the only candidate for a text-only Assistant turn. Text-only prompts route to a qualified text/chat model or the configured cloud/built-in fallback. Never answer `attach an image` merely because a VLM was selected if a compatible text model exists.

## Vision/report routing

Photo analysis must use a qualified VLM and the canonical media derivative pipeline. Validate structured outputs, loop/echo, field stuffing, privacy cases, and retries. Failure of one local model follows the explicit user privacy mode; never silently cross to cloud.

## Promotion gates

Every downloadable model needs pinned upstream revision, exact artifact hash, license/distribution decision, runtime/format, RAM estimate then device measurement, role-specific corpus, latency, cancellation, streaming, loop/echo/refusal behavior, and reviewer PASS. `Works in a desktop demo` is not qualification.

## <=2B candidate policy

Evaluate candidates; do not expose every model by default. Keep a curated Recommended set and an Advanced catalogue. Prefer a few complementary models over duplicates.

## Runtime strategy

Reuse existing LiteRT-LM, llama.cpp/GGUF, and Needle ownership unless measured evidence justifies another runtime. Cactus may be evaluated as a unified challenger only behind a separate benchmark lane; do not replace working runtimes based on marketing claims.
