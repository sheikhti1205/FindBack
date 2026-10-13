# Owner closeout sequence (CLOSEOUT-21)

One ordered sequence. Secrets are NAMES only — never paste values into
source; export them in the shell (or set repo Actions vars/secrets).
Destructive/live sections are marked and separated from local build steps.
Source revision this was written against: `c0b5f2b` (`origin/main`); live DB head at write time: `20261012020000`.

## A. Preflight (read-only, any machine)

```sh
git rev-parse HEAD && git status --short   # expect c0b5f2b (or newer), clean
node scripts/completion-gate.mjs --final
node scripts/check-sentry-release-parity.mjs
node scripts/check-map-provider.mjs
node scripts/check-google-config.mjs
node scripts/check-push-config.mjs   # names only; server secrets expected missing until E
node scripts/check-edge-parity.mjs --manifest <live-manifest.json>
```

## B. Live database (needs Supabase access; never replay applied migrations)

Apply-then-verify EACH migration in order (each additive/fix-forward, audited
CLOSEOUT-2). Do not proceed to the next APPLY until the matching VERIFY passes.

```sh
# 1. APPLY 120300  →  VERIFY 120300
supabase db push   # applies 20261012030000_avatar_url_host_bind.sql
psql "$DATABASE_URL" -f supabase/tests/verify_20261012030000_avatar_host_bind.sql

# 2. APPLY 130100  →  VERIFY 130100
supabase db push   # applies 20261013010000_comment_attachments_update_bind.sql
psql "$DATABASE_URL" -f supabase/tests/verify_20261013010000_attachment_update_bind.sql

# 3. APPLY 130200  →  VERIFY 130200
supabase db push   # applies 20261013020000_comment_media_cleanup_lease.sql
psql "$DATABASE_URL" -f supabase/tests/verify_20261013020000_cleanup_lease.sql
```

`supabase db push` is idempotent and skips already-applied migrations; never
hand-replay an older migration file. After each apply, confirm the row exists
in `supabase_migrations.schema_migrations` and inspect the changed
function/constraint/policy via the matching verify file.

Final schema-parity check (repo head must equal live head):

```sh
node --test supabase/tests/migration_parity.test.mjs   # repo constant parity
# live head must read: 20261013020000  (== BACKEND_SCHEMA_VERSION)
```

`BACKEND_SCHEMA_VERSION` (`apps/mobile/src/services/appCapabilities.ts`) is
`20261013020000`; if the live backend is behind that, the app degrades via the
capabilities gate rather than assuming the newer schema.

Then (disposable test backend only — confirm disposable-vs-production
first): `supabase/tests/run-live.sh` with `TEST_SUPABASE_URL`,
`TEST_SUPABASE_PUBLISHABLE_KEY`, `TEST_USER_A_JWT`, `TEST_USER_B_JWT`
(NOT the real reactor/owner accounts). Live `run-live.sh` does not yet
cover the new lookalike-host/UPDATE-reassign/lease-ack probes — those live
in the three verify files above.

## C. Edge functions (after B; `delete-account` NEVER in this set)

Preferred: the canonical safe orchestrator (dry-run first, then execute):

```sh
node scripts/deploy-required-edge-functions.mjs                  # dry-run plan
node scripts/deploy-required-edge-functions.mjs --migrations-live # + cleanup step
SUPABASE_PROJECT_REF=<ref> node scripts/deploy-required-edge-functions.mjs \
  --execute --migrations-live --manifest <fresh-manifest.json>
```

It stops on missing config (push-config must read PRESENT + ALIGNED), never
deploys `delete-account`, and runs edge parity afterwards when `--manifest`
is supplied. Equivalent manual commands:

```sh
node scripts/check-push-config.mjs   # must read all PRESENT + ALIGNED first
supabase functions deploy ai-help            # JWT verify ON (no flag)
supabase functions deploy reply-comment --no-verify-jwt
supabase functions deploy push-dispatch --no-verify-jwt   # only after push-config PASS
# ONLY after migration 20261013020000 is live:
supabase functions deploy cleanup-comment-media --no-verify-jwt
node scripts/check-edge-parity.mjs --manifest <fresh-manifest.json>  # expect all CURRENT
```

`delete-account` deploys separately, owner-side, after explicit auth
review — never via the shared pipeline.

## D. Sentry cutover (names only)

1. Set repo Actions VARIABLE `VITE_SENTRY_DSN` to the new-project DSN;
   optional `VITE_SENTRY_TRACES_SAMPLE_RATE=1.0`, `VITE_MONITORING_SELFTEST`
   (leave unset except for one device proof).
2. Set CI secret `SENTRY_AUTH_TOKEN` + vars `SENTRY_ORG`, `SENTRY_PROJECT`.
3. Local proof: `FINDBACK_SENTRY_UPLOAD=true node scripts/build-apk.mjs
   --variant=signeddev` (fails closed on missing config; pins dist;
   verifies upload; strips maps after verify).
4. Device proof: install, then ONE `VITE_MONITORING_SELFTEST=true` run —
   handled error + warning + breadcrumb land under the pinned
   release/dist; normal startup never auto-fires it.

## E. FCM server + push proof

1. Provision `FIREBASE_SERVICE_ACCOUNT_JSON` (+ `FCM_PROJECT_ID`,
   `PUSH_DISPATCH_SECRET`) via the secrets sync (never in Git).
2. `node scripts/check-push-config.mjs` → all PRESENT.
3. Send synthetic notifications: LOVE, HELPFUL, SUPPORT, WOW, COMMENT,
   MENTION, STATUS + one unknown-type (must fail safe, generic copy,
   no crash) + self-reaction (no notification) + muted Reactions (no push).

## F. Canonical signeddev + device (quiet window: no heavy gates overlap)

```sh
node scripts/build-apk.mjs --variant=signeddev   # provenance report: SHA,
  # version/code, package, signer, Supabase host, Google PRESENT, FCM, MAPLIBRE
node scripts/device-harness/provenance.mjs --apk <path>   # artifact manifest
adb install <signeddev.apk>   # emulator Norfold_API36 or Xiaomi; fresh-install only
```

Google runtime harness: existing/new Google user, cancel, Credential
Manager unavailable, misconfigured OAuth, Supabase token reject, missing
profile → Complete Profile, restart mid-completion, same-email password
account, logout/switch. Capture error CLASS only (never token/nonce).

## G. Restore + release decision (owner only)

1. Resolve Actions billing → rerun exact-final-SHA CI.
2. KLIPY: key is wired into gitignored root `.env` and the adapter contract is live-validated (2026-10-13). Remaining: set `VITE_KLIPY_API_KEY` as a CI + release secret so production builds bake it; then in-app visual check of the picker on device. SMS provider test, model-lab selection — deferred.
3. Only then: version/release decision. No tag/release in this wave.
