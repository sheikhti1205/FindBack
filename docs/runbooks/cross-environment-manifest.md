# Cross-environment manifest (CLOSEOUT)

Source revision: `9ac0714` (`origin/main`, tree clean at write time).
Mobile version: `1.0.0` (versionCode derived from git history at build;
shallow clones refuse — see `apps/mobile/android/app/build.gradle`).
Repo migration head: `20261013020000`. Live migration head (owner):
`20261012020000`. `BACKEND_SCHEMA_VERSION=20261013020000`.
No release/tag authorized. No Kotlin compiled on this machine (no toolchain).

Cell vocabulary (only): `WIRED` | `RUNTIME_VERIFIED` | `OWNER_SECRET_REQUIRED`
| `DEPLOYMENT_REQUIRED` | `EXTERNAL_BLOCKED` | `NOT_APPLICABLE`.
“Runtime proof pending” is recorded in Notes, never in the cell.

| Area | LOCAL | CI | RELEASE | WEB | DOCKER | LIVE | Notes |
|---|---|---|---|---|---|---|---|
| Supabase URL/key | WIRED | WIRED | WIRED | WIRED | WIRED | RUNTIME_VERIFIED | Fail-closed preflight every lane (`check-mobile-build-config.mjs`); live project reachable owner-side |
| DB migrations | NOT_APPLICABLE | RUNTIME_VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | DEPLOYMENT_REQUIRED | Static parity green (`migration_parity.test.mjs` runs in CI); live needs 12030000 → 20261013010000 → 20261013020000 in order + 3 verify SQL |
| Sentry DSN | OWNER_SECRET_REQUIRED | OWNER_SECRET_REQUIRED | OWNER_SECRET_REQUIRED | OWNER_SECRET_REQUIRED | OWNER_SECRET_REQUIRED | NOT_APPLICABLE | New project `canvas-of-nomads/findback_capacitor`; set `VITE_SENTRY_DSN` var; never hardcoded (gate-enforced) |
| Sentry release/dist | WIRED | WIRED | WIRED | WIRED | WIRED | NOT_APPLICABLE | ONE scheme `findback-mobile@<version>+<short12>` (exactly-12 everywhere); per-lane closed dist; proven by `check-sentry-release-parity.mjs`. CI *execution* EXTERNAL_BLOCKED (billing) |
| Sentry sourcemaps | OWNER_SECRET_REQUIRED | EXTERNAL_BLOCKED | OWNER_SECRET_REQUIRED | OWNER_SECRET_REQUIRED | NOT_APPLICABLE | NOT_APPLICABLE | Upload needs `FINDBACK_SENTRY_UPLOAD=true` + token/org/project; docker reference explicitly `NOT_UPLOADED` |
| Sentry trace rate | WIRED | WIRED | WIRED | WIRED | WIRED | NOT_APPLICABLE | Single source `build-context.mjs` default `0.1`; `1.0` only via repo var |
| Google Web ID (build) | WIRED | WIRED | WIRED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Absent hides sign-in locally; hard fail signeddev/release (`check-google-config.mjs`, packaged assert) |
| Google Android OAuth (runtime) | WIRED | WIRED | WIRED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Debug-signer success is NOT production proof; release-signer ID-token exchange pending device |
| FCM client | WIRED | WIRED | WIRED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Materialize-or-validate (`materialize-google-services.mjs`); package/project match enforced |
| FCM server | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | OWNER_SECRET_REQUIRED | Needs `FIREBASE_SERVICE_ACCOUNT_JSON` (+ `FCM_PROJECT_ID`, `PUSH_DISPATCH_SECRET`); `check-push-config.mjs` names-only gate; then deploy `push-dispatch` |
| Push vocabulary | RUNTIME_VERIFIED | RUNTIME_VERIFIED | RUNTIME_VERIFIED | NOT_APPLICABLE | NOT_APPLICABLE | DEPLOYMENT_REQUIRED | REACTION+kind end-to-end in repo source/tests (incl. UNKNOWN fail-safe + kind render); live `push-dispatch` stale until redeployed |
| MapLibre | WIRED | WIRED | WIRED | WIRED | NOT_APPLICABLE | NOT_APPLICABLE | Native final, keyless, no Google-Maps fallback (`check-map-provider.mjs` PASS); Android runtime compile/device proof pending |
| KLIPY | OWNER_SECRET_REQUIRED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | Static adapter + tests green; live proof deferred until key through approved channel |
| SMS | WIRED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | OWNER_SECRET_REQUIRED | Policy + cooldown migration live (`20261012010000`); provider/delivery unproven |
| Edge functions | NOT_APPLICABLE | WIRED | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | DEPLOYMENT_REQUIRED | Pipeline wired (`backend-deploy.yml`); live needs ai-help/reply-comment (if STALE) + push-dispatch + cleanup-comment-media (after migration); `delete-account` owner-side separate |
| Remote CI execution | EXTERNAL_BLOCKED | EXTERNAL_BLOCKED | EXTERNAL_BLOCKED | EXTERNAL_BLOCKED | NOT_APPLICABLE | NOT_APPLICABLE | Zero-step failures = Actions billing block, not code; local gates authoritative |

## Build-matrix schema (per artifact, no secrets)

Every installable artifact record MUST contain: git SHA, version,
versionCode, package (`com.findback.app`), ABI (or `universal`/AAB),
APK SHA256, signer fingerprint, Sentry release, Sentry dist,
Google Web client PRESENT/ABSENT, FCM config VALID/INVALID/DISABLED,
Map provider (`MAPLIBRE`). No artifact was minted in this wave (no
release authorized); `scripts/build-apk.mjs` + `scripts/device-harness/`
produce these records at build time.
