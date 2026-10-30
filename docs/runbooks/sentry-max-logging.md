# Sentry maximum-logging cutover — new project (`canvas-of-nomads/findback_capacitor`)

Owner moved Sentry accounts to a NEW project. This runbook covers the code
side (already in tree) and the owner-side manual cutover checklist.

No DSN value appears in this file or anywhere in the repo — the DSN is read
from `VITE_SENTRY_DSN` at build time. Where a value is shown, it is the
placeholder `<new-project-dsn>`.

## What the code does (in tree)

Source: `apps/mobile/src/services/monitoring/sentry.ts`
(SDK: `@sentry/capacitor ^4.4.0` / `@sentry/react ^10.69.0` — both expose the
SDK-supported top-level `enableLogs` option, `beforeSendLog`, and the
`Sentry.logger.{info,warn,error}` API.)

- `SENTRY_LOGS_ENABLED = true` is spread as `enableLogs` into `Sentry.init`,
  next to `getSentryPrivacyDefaults()`, so enabling logs cannot silently
  weaken the privacy posture.
- Every log passes through `beforeSendLog` → `sanitizeSentryLog` — the same
  fail-closed scrubbing as events/breadcrumbs (`redactText` on message/body,
  `WITHHELD`-key + query/fragment stripping on `attributes`). Unsafe
  leftovers DISCARD the log (return `null`), never forward raw.
- `reportLogToMonitoring(level, message, context?)` is the info-level helper.
  Levels are limited to the `info | warn | error` union — no
  verbose/trace/debug levels that invite PII-prone free-text dumping. It
  reuses the `cachedDsn` gate (no-op without a DSN) and the same
  `WITHHELD`-key/`redactText` context scrubbing as `reportErrorToMonitoring`.

## Privacy posture — UNCHANGED by maximum logging

- `sendDefaultPii: false`, session replay `0`/`0`, no `user` ever attached.
- Request `headers`/`cookies`/`query_string`/`data` (bodies) deleted.
- Key material, chat/prompt text, photo bytes, precise location, auth tokens,
  emails, phones redacted/withheld before anything leaves the device.
- Extended tests assert `enableLogs` does not weaken any of the above:
  `apps/mobile/src/services/monitoring/sentry.test.ts` ("sentry logs
  config", "sanitizeSentryLog", "reportLogToMonitoring") plus the inert
  contract in `sentryInert.test.ts`.

## Env knobs — no new ones

Maximum logging introduces NO new environment variable: `enableLogs` is
code-level (always on whenever a DSN is present). There is no
`apps/mobile/.env.example` in tree, so nothing was changed there; the
existing knobs live in the repo-root `.env.example` (`VITE_SENTRY_DSN`,
`VITE_SENTRY_ENVIRONMENT`, `VITE_SENTRY_TRACES_SAMPLE_RATE`,
`VITE_MONITORING_SELFTEST`) and are unchanged.

## Owner-side cutover checklist (MANUAL — not in tree)

Code changes are done; every item below is an owner action outside the repo
grant. Workflows read these from repo Settings → Secrets and variables →
Actions (Variables for DSNs/slugs, Secrets for tokens) — never hardcoded.

1. **New project DSN.** In the new Sentry account, open project
   `findback_capacitor` (org `canvas-of-nomads`) and copy its DSN.
   Set the repo Actions VARIABLE `VITE_SENTRY_DSN` to `<new-project-dsn>`
   (replacing the old project's DSN). Effective in:
   - `.github/workflows/release.yml` — `VITE_SENTRY_DSN: ${{ vars.VITE_SENTRY_DSN }}`
     (build env, ~line 202; also referenced ~line 101)
   - `.github/workflows/ci.yml` (~lines 145, 181, 211)
   - `.github/workflows/web.yml` (~line 19)
   Preflight proof: `scripts/check-sentry-config.mjs` fails closed without a
   real DSN, and the release job's "Assert baked client config" step greps the
   DSN host and the release identity back out of the built bundle.
2. **Maximum tracing.** Set the repo Actions VARIABLE
   `VITE_SENTRY_TRACES_SAMPLE_RATE` to `"1.0"` — the workflows are
   variable-driven (release.yml Resolve step, ci.yml, web.yml all fall back
   to the code default when the var is empty; garbage fails closed). Do NOT
   edit a hardcoded `"0.1"` in the workflow files: there is none. Code
   default when empty stays conservative (`0.1`, see
   `SENTRY_DEFAULT_TRACES_SAMPLE_RATE`).
3. **Environment.** Already set per workflow (`production` in release.yml,
   `ci` in ci.yml, `production-web` in web.yml via `VITE_SENTRY_ENVIRONMENT`).
   Keep distinct values per lane so the new project's issues split by
   environment.
4. **Release/symbolication.** Automatic: the "Compute Sentry release identity
   (S3)" step in release.yml/ci.yml mints
   `findback-mobile@<version>+<sha>` and publishes `VITE_SENTRY_RELEASE`,
   which `resolveSentryRelease` (`release.ts`) feeds to the SDK — the same
   string passed to the sourcemap upload. Nothing to edit; verify the
   "Upload sourcemaps to Sentry (S3)" step reports uploads for the release.
5. **Sourcemap upload token (OWNER-SIDE).** Mint a new token in the NEW
   account (needs `project:releases` on the new project) and replace the repo
   Actions SECRET `SENTRY_AUTH_TOKEN`. Update the Actions VARIABLES
   `SENTRY_ORG` (`canvas-of-nomads`) and `SENTRY_PROJECT`
   (`findback_capacitor`). The old account's token cannot upload to the new
   project — releases will stay unsymbolicated until this is done.
6. **Dashboard alerts (OWNER-SIDE, Sentry UI in the new project).** Recreate
   at minimum: error-spike alert, new-issue alert, and a log-volume guard
   (see "Cost" below). Nothing in the repo configures these.
7. **Verify the cutover.** Run a build, confirm the "Assert baked client
   config" step passes with the new DSN host, then set
   `VITE_MONITORING_SELFTEST=true` for one device proof: Profile shows the
   diagnostics button, `sendMonitoringTestSignal` emits the synthetic event
   tagged `monitoringSelfTest: findback-monitoring-self-test`, and exactly
   that event must appear in the NEW project (and stop appearing in the old
   one). Old project: keep until the first green release, then decommission
   per owner preference.

## Cost — maximum logging increases event volume

`enableLogs: true` plus `VITE_SENTRY_TRACES_SAMPLE_RATE=1.0` means every log
call and every transaction is ingested. Expect materially higher event volume
(and quota burn) versus the previous `0.1` sampling with logs off.

To dial back (no code change needed for traces):

- Traces: lower `VITE_SENTRY_TRACES_SAMPLE_RATE` back toward `"0.1"` in
  release.yml/ci.yml (owner-side variable edit, next build takes effect).
- Logs: `reportLogToMonitoring` has no sampler — dial back by reducing call
  sites or gating noisy ones behind local sampling before calling. `enableLogs`
  itself stays on; with zero log calls its cost is ~zero.

## Verification (code side, this change)

- `npx tsc --noEmit -p apps/mobile` — 0 errors.
- `npx vitest run src/services/monitoring` (in `apps/mobile`) — green
  (covers `sentry.test.ts`, `sentryInert.test.ts`, `sentryAiUi.test.ts`,
  `release.test.ts`).
- `npm run scan:secrets` — clean (no DSN/secret literals added).

## Known external crash triage: FINDBACK_CAPACITOR-3

Sentry issue `FINDBACK_CAPACITOR-3` is an emulator/platform crash, not a
FindBack application crash:

- Fatal signal is `SIGILL` in `WebViewGoogle.apk` native Chromium frames
  (triggered via ART/JNI), with no FindBack frames on stack.
- Repro happens on preview Android 17 `sdk_gphone16k_x86_64` while app lifecycle
  transitions to background after Google sign-in attempts report unavailable.
- On x86_64 Chromium this maps to deliberate `ud2` crash traps
  (`CHECK`/`IMMEDIATE_CRASH`) inside the system WebView.

Owner action for this issue:

1. Leave FindBack app code and Sentry native signal capture unchanged.
2. Update Android System WebView on the emulator (or use a stable API image).
3. Resolve the Sentry issue so it automatically reopens on recurrence.
4. Escalate only if the same signature reproduces on physical production
   devices, with WebView version evidence attached.
