# OpenRouter-only FindBack pivot — approved owner direction

## Decision and boundaries

Archive local generative AI at `local-ai-final-2026-09-25` (branch `archive/local-generative-ai-2026-09-25`), then remove local generative code and binary dependencies from active compilation. Keep the independent editor audit improvements, ordinary image normalization/upload, search, and independently useful non-generative ML. Historical internal records and lab worktrees remain untouched. No further local-model investigation.

All generative requests go to the fixed HTTPS OpenRouter Chat Completions endpoint with `model: "openrouter/free"`. No caller can set model, endpoint, provider, paid routing, or fallback model. The router picks an eligible free model; selection varies and free vision/structured support is not guaranteed. See [OpenRouter free router](https://openrouter.ai/docs/guides/routing/routers/free-router.md) and [image input](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding.md). Do not assume success from HTTP 200: the body may contain an error or an error choice.

## Connection and credentials

A user enters their own OpenRouter key in AI Connection. Validate it via `GET https://openrouter.ai/api/v1/key` (no inference quota used), with cancellable timeout, then show connected/disconnected status; never display or log the key. Remove key immediately disconnects. Credential records are keyed by the authenticated FindBack user ID, and logout/account switch clears the in-memory key. Core features do not require it.

Android uses a Capacitor bridge backed by Android Keystore AES-GCM with encrypted private app storage. For browsers the default is memory-only; an explicit **Remember on this browser** choice encrypts the key with WebCrypto AES-GCM from a user-supplied unlock phrase (PBKDF2 salted per record); only salt/nonce/ciphertext/user ID are stored. An unlock phrase is required after reopening. Never store plaintext keys or unlock phrases in localStorage/IndexedDB, and never sync the key to FindBack servers. Opting out removes persisted ciphertext. Warn that users should set spending limits on their own OpenRouter key, even though the app only requests the free router.

## Central service and features

One client owns fixed URL/model, timeouts, cancellation, bounded response size, non-streaming error checks, safe user-facing error codes and credential retrieval. It sends text messages and user-consented local image data URLs (JPEG/PNG/WebP only; size and resolution caps, no remote public photo URL). No raw provider message or prompt is logged. Free-tier exhaustion and rate limit get distinct copy; no unbounded retry and no paid fallback. Consumer operations validate parsed output against their existing fields before previewing.

- Image analysis: explicit consent for sending the selected image; suggest structured report fields with evidence/uncertainty; do not apply without review; image normalization remains independent.
- AI Help: generated answer tagged as such; when disconnected/unavailable, deterministic FAQ only, tagged Built-in answer. Legacy generic provider Edge Function and Node provider must not be callable as active generative paths.
- Report assistant: collect title/description/category/location hints and show a review handoff; no silent overwrite and no publish.
- Search assistant: map validated supported filters into ordinary search; model output never executes a query or supplies results.

## UI and verification

Replace Offline AI with AI Connection settings and remove active references to model switching/download, RAM/GPU and verification. Reuse FindBack visual language, accessible labels/status/focus. Archive obsolete tests with the tag; active tests mock OpenRouter responses and assert every generative request carries only `openrouter/free`, no key leak, malformed-output refusal, no-AI core routes, and native dependencies absent. Run full TS/lint/mobile/API/JVM gates and canonical APK (`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` sourced from local `.env` and asserted non-empty before build), config proof, strict APK scan, size and SHA. Device-only rows remain unverified until run on hardware.

## Execution slices

1. Archive/preserve, freeze labs and record owner decision (completed on branch/tag; source branch remains `main`).
2. Fixed-route client with error validation and fake-response tests; secure per-user key storage/connection UI.
3. AI Help and guided assistant wiring; image analysis review and search handoff.
4. Remove obsolete local generative entry points, Gradle dependencies and tests; keep non-generative ML; refresh docs.
5. Run integrated checks and build exactly from the verified source; report remaining device acceptance separately.
