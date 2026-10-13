# Cross-environment manifest (CLOSEOUT)

Source revision: `0154a9b` (`origin/main`, re-baselined off `790f456`, tree clean at write time).
Mobile version: `1.0.0` (versionCode derived from git history at build;
shallow clones refuse — see `apps/mobile/android/app/build.gradle`).
Repo migration head: `20261013020000`. Live migration head (owner):
`20261012020000`. `BACKEND_SCHEMA_VERSION=20261013020000`.
No release/tag authorized. No Kotlin compiled on this machine (no toolchain).

This document answers "does the product capability exist on this lane". The
separate "is this lane closed yet" readiness matrix (18 owner rows, verdict
vocabulary `PASS` / `READY_FOR_RUNTIME_PROOF` / `DEFERRED_*` / `FAIL*`) lives in
`docs/runbooks/cross-environment-closure.md`.

## Capability vs technology (the rule this matrix obeys)

A feature is **applicable to a lane when the PRODUCT FEATURE exists in that
lane**, regardless of the implementation technology used there. Do not mark a
cell `NOT_APPLICABLE` merely because a technology is absent:

- Google login **is** a web product feature even though Android Credential
  Manager is not the web mechanism.
- KLIPY **is** a web product feature because web has comments.
- Sentry **is** a web product feature (the web lane ships a DSN/release/dist).
- If the web location picker renders a map, the web map renderer applies.

`NOT_APPLICABLE` is reserved for a genuinely absent *product feature* and
**every `NOT_APPLICABLE` cell must carry a one-sentence justification** in the
Notes column. Future passes must not regress to technology-based N/A
reasoning; when in doubt, classify by the product capability and describe the
technology difference in Notes.

### Cell vocabulary (only these four)

- `IMPLEMENTED` — the product feature is present in that lane and no
  lane-specific secret/var or deploy/apply step is outstanding.
- `CONFIG_REQUIRED` — the feature is present in source but a lane
  secret/var/env (or a deploy/apply step) must be supplied before it works.
- `READY_RUNTIME` — implemented and configured; a runtime activation step
  (edge deploy, migration apply, device run) is still pending before it is
  operative.
- `NOT_APPLICABLE` — the product feature does not exist in that lane;
  justification required (see the capability rule above).

Lanes: `LOCAL` (dev web shell / debug APK) · `CI` (GitHub Actions build) ·
`RELEASE` (signed APK/AAB) · `WEB` (production Azure SWA,
`https://findbackapp.social`) · `DOCKER` (reference web-shell + API image) ·
`LIVE` (live Supabase project / deployed Edge Functions / provider secrets).

| Area | LOCAL | CI | RELEASE | WEB | DOCKER | LIVE | Notes |
|---|---|---|---|---|---|---|---|
| Supabase URL/key | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | Fail-closed preflight every lane (`check-mobile-build-config.mjs`); `VITE_*` derived from canonical `SUPABASE_*`; live project reachable owner-side |
| DB migrations | NOT_APPLICABLE | IMPLEMENTED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | READY_RUNTIME | `LOCAL`/`RELEASE`/`WEB`/`DOCKER` N/A because migrations are applied to a database, never bundled into a client build. Static parity green in CI (`migration_parity.test.mjs`). Live apply pending in order: `20261012030000_avatar_url_host_bind` → `20261013010000_comment_attachments_update_bind` → `20261013020000_comment_media_cleanup_lease`, each followed by its verify SQL |
| Sentry DSN | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | NOT_APPLICABLE | New project `canvas-of-nomads/findback_capacitor`; set `VITE_SENTRY_DSN` (never hardcoded, gate-enforced); blank = inert. `LIVE` N/A because a DSN is a client build input, not a live backend service |
| Sentry release/dist | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | NOT_APPLICABLE | ONE scheme `findback-mobile@<version>+<short12>` (exactly-12 everywhere); per-lane closed dist (`web-production`, `docker-reference`); proven by `check-sentry-release-parity.mjs`. `LIVE` N/A because release identity is a build-time string, not a live service |
| Sentry sourcemaps | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | NOT_APPLICABLE | NOT_APPLICABLE | Upload needs `FINDBACK_SENTRY_UPLOAD=true` + token/org/project. CI execution is `EXTERNAL_BLOCKED_BILLING`. `DOCKER` N/A because the reference image intentionally ships no symbol upload (`SENTRY_SYMBOLICATION=NOT_UPLOADED`); `LIVE` N/A because symbol upload is a build-time step |
| Sentry trace rate | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | NOT_APPLICABLE | Single source `build-context.mjs` default `0.1`; `1.0` only via repo var. `LIVE` N/A because the trace rate is a client SDK build input |
| Google auth — Android Credential Manager (runtime) | IMPLEMENTED | IMPLEMENTED | READY_RUNTIME | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Debug-signer success is NOT production proof; release-signer ID-token exchange pending device. `WEB`/`DOCKER`/`LIVE` N/A for THIS mechanism because Credential Manager is an Android OS API — the web Google login feature is tracked in the row below, not dismissed here |
| Google auth — web OAuth (runtime) | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | NOT_APPLICABLE | NOT_APPLICABLE | Google login IS a web product feature (capability rule). The web OAuth path is IMPLEMENTED in source this wave (`signInWithOAuth` → `/auth/callback` bridge → shared resolver) and source-gated by `check-auth-config.mjs`; it stays CONFIG_REQUIRED until the Supabase Google provider carries the web client id/secret + redirect-URL allowlist (`https://findbackapp.social/auth/callback`). `DOCKER`/`LIVE` N/A because the Docker reference image forwards no Google client and OAuth is a client capability |
| Google Web client ID (build input) | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | ANDROID build input (the `setServerClientId` audience). Absent hides Android sign-in, hard fail on signeddev/release Gradle path (`check-google-config.mjs`, packaged assert FBX-028). `WEB` N/A because the browser flow's client id/secret live in the SUPABASE provider config, never in the Vite bundle (the directive forbids exposing a Google client secret). `DOCKER`/`LIVE` N/A because a client ID is a build input, not a live service |
| FCM client (Android push) | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Materialize-or-validate (`materialize-google-services.mjs`); package/project match enforced. `WEB`/`DOCKER`/`LIVE` N/A because the FCM Android client is not a web product feature and the web lane offers no push surface (the inbox is separate and shared) |
| FCM server (push-dispatch) | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | CONFIG_REQUIRED | Needs `FIREBASE_SERVICE_ACCOUNT_JSON` (+ `FCM_PROJECT_ID`, `PUSH_DISPATCH_SECRET`); `check-push-config.mjs` cross-checks `FCM_PROJECT_ID` == canonical client project `findback-mobile-app`. Client lanes N/A because push dispatch is an Edge Function, not a client artifact |
| Push vocabulary (payload rendering) | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | NOT_APPLICABLE | NOT_APPLICABLE | CONFIG_REQUIRED | REACTION+kind end-to-end in repo source/tests (incl. UNKNOWN fail-safe + kind render); live `push-dispatch` STALE until redeployed. `WEB`/`DOCKER` N/A because system-push payload vocabulary is delivered only by the Android push channel; the web inbox uses the shared notification model separately |
| MAPLIBRE_NATIVE | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Native final, keyless, no Google-Maps fallback (`check-map-provider.mjs` PASS); Android runtime compile/device proof pending. `WEB`/`DOCKER`/`LIVE` N/A because MapLibre Native is an Android native library — web renders with its own renderer (next row) |
| WEB_MAP_RENDERER | IMPLEMENTED | IMPLEMENTED | NOT_APPLICABLE | IMPLEMENTED | IMPLEMENTED | NOT_APPLICABLE | The web location picker DOES render a map, so this applies to web: a keyless 3×3 OSM raster tile grid with zoom (`services/location/rasterTiles.ts`), not MapLibre GL. `RELEASE` N/A because the shipped Android APK uses the native renderer; `LIVE` N/A because tile rendering is a client capability, not a backend service |
| GEOCODER | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | IMPLEMENTED | NOT_APPLICABLE | Explicit-submit Nominatim place search (`location/nominatimSearch.ts` + `placesSearch.ts`), keys-free; Android additionally resolves short Maps links natively (`utils/location.ts`). Optional `VITE_NOMINATIM_SEARCH_URL` override. `LIVE` N/A because geocoding runs client-side against public OSM, not a FindBack backend service |
| KLIPY | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | NOT_APPLICABLE | KLIPY IS a web product feature because web has comments. Adapter live-VALIDATED 2026-10-13 with a real key (`data.data` + `file.<size>.<fmt>.url`; share POST 200). `VITE_KLIPY_API_KEY` now flows to `web.yml`/`release.yml` from a repo secret and `check-klipy-config.mjs --assets/--apk` proves the shipped bundle carries it; the secret must still be set or the picker stays hidden. `LIVE` N/A because KLIPY is a client adapter, not a FindBack backend service |
| SMS / phone verification | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | Phone verification IS a product feature on every lane (shared `Verify` screen + profile phone change), but no SMS provider is configured (`appCapabilities.phoneVerification`). Policy + cooldown migration live (`20261012010000`); provider/delivery unproven |
| Edge functions | NOT_APPLICABLE | IMPLEMENTED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | READY_RUNTIME | Client lanes N/A because Edge Functions run in Supabase and are called, not bundled. Canonical safe orchestrator `scripts/deploy-required-edge-functions.mjs` (dry-run default; `--execute`; stops on missing config; NEVER deploys `delete-account`; runs parity after). Live: ai-help, reply-comment and push-dispatch (STALE) deployed; `cleanup-comment-media` NOT deployed (needs migration `20261013020000`) |
| Remote CI execution | IMPLEMENTED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | CONFIG_REQUIRED | NOT_APPLICABLE | Local gates are authoritative and green. Remote Actions execution is `EXTERNAL_BLOCKED_BILLING` (GitHub Actions billing block, not code) for CI/release/web/docker; release not authorized. `LIVE` N/A because CI execution is a pipeline, not a live service |

## X-wave gates and audits (this pass)

New/updated invariants the matrix relies on:

- `scripts/check-auth-config.mjs` — browser-auth source contracts (one shared
  Google resolver, web `signInWithOAuth` + native `signInWithIdToken`, PKCE
  pinned, no Google client secret, no Firebase Auth, external capture in
  `main.tsx`).
- `scripts/cross-environment-matrix.mjs` — the four-status vocabulary and the
  capability rule, with a capability pin that refuses to mark a web product
  feature `NOT_APPLICABLE` (`--check`/`--markdown`).
- `scripts/check-klipy-config.mjs` — env presence plus `--assets`/`--apk`
  bundle-presence proof (X7).
- `scripts/check-cleanup-scheduler.mjs` — comment-media cleanup workflow and
  cron contract.
- `scripts/sentry-cross-lane-proof.mjs` — one release scheme across lanes.
- `docs/runbooks/web-parity-audit.md` — feature-by-feature WEB classification
  (capability vs technology); every former `MISSING_BUG` is now resolved.
- `docs/runbooks/owner-closeout-sequence.md`,
  `docs/runbooks/production-config-matrix.md` — owner apply/verify order.

## Build-matrix schema (per artifact, no secrets)

Every installable artifact record MUST contain: git SHA, version,
versionCode, package (`com.findback.app`), ABI (or `universal`/AAB),
APK SHA256, signer fingerprint, Sentry release, Sentry dist,
Google Web client PRESENT/ABSENT, FCM config VALID/INVALID/DISABLED,
Map provider (`MAPLIBRE`). No artifact was minted in this wave (no
release authorized); `scripts/build-apk.mjs` + `scripts/device-harness/`
produce these records at build time.
