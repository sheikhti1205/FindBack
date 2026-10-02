# Sharing, App Links and FCM infrastructure

## Provisioned endpoints

- Public web: `https://findbackapp.social` (Azure Static Web Apps custom domain;
  `https://ambitious-wave-0f1b6c500.3.azurestaticapps.net` remains the default host).
- Azure Static Web Apps: `findback-web`, `findback-rg`, East Asia, Free SKU.
- Supabase project: `nfjhpigbsyyoaaktfaev` (existing Auth, Data API, Realtime and Storage).
- Firebase project: `findback-mobile-app`, number `847111479023`.
- Android package: `com.findback.app`.
- Dedicated FCM sender: `findback-push@findback-mobile-app.iam.gserviceaccount.com`,
  with `roles/firebasecloudmessaging.admin`; FCM HTTP v1 enabled.

## External report contract

`/r/<UUID>` accepts `focus=comments|activity|manage`. A `comment=<UUID>` is
allowed only with comments focus. The shared parser rejects other hosts,
unknown/duplicate parameters, credentials, malformed IDs, and URL normalization
tricks. Browser, native cold/warm entry and future push taps use this contract.

The landing and shared-link sign-in gate fetch no anonymous report data.
Authenticated users enter the existing report detail screen. Pending links are
validated on read, expire after one hour and are consumed after navigation.
An exact linked comment expands the preview and receives keyboard focus.

## Automation and credentials

The `Web` workflow runs on `main` pushes or manual dispatch. It validates public
config, typechecks/tests routing, builds the existing React client, verifies
baked values and the signing-certificate association, then deploys prebuilt
static output to Azure.

Required GitHub repository variables:

- `VITE_PUBLIC_SHARE_ORIGIN`, `VITE_SUPABASE_URL`, `VITE_SENTRY_DSN`.
- `SUPABASE_PROJECT_REF` for server-secret synchronization.

Required GitHub secrets:

- Web: `AZURE_STATIC_WEB_APPS_API_TOKEN`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
  `ANDROID_SIGNING_CERT_SHA256` (association verification).
- Android: `GOOGLE_SERVICES_JSON_B64` (public Firebase client configuration).
- Server-secret sync only: `FIREBASE_SERVICE_ACCOUNT_JSON`, `SUPABASE_ACCESS_TOKEN`.
- Push dispatch (optional): `PUSH_DISPATCH_SECRET` — a 32–128 character
  `[A-Za-z0-9_-]` token the owner generates once.

Run the separate server workflow after rotating the dedicated sender credential:

```bash
gh workflow run sync-fcm-secrets.yml --ref main
```

It validates the sender/project/key, writes a mode-0600 temporary env file,
stores `FIREBASE_SERVICE_ACCOUNT_JSON`, `FCM_PROJECT_ID` and
`PUBLIC_SHARE_ORIGIN` in Supabase, and — when `PUSH_DISPATCH_SECRET` is present —
mirrors it into the function environment too. It checks every stored SHA-256
digest and removes the temporary directory in a `finally` block. It never logs
credential input or raw CLI output. Server credentials are not supplied to any
browser/APK build.

## Device tokens, preferences and dispatch

- Migrations `20261002000000` (inbox actions), `20261002010000` (private inbox
  Realtime signal), `20261002020000` (device tokens, preferences, `pushed_at`),
  `20261002030000` (nested comments) and `20261002040000` (reply tokens) reach
  production only through the manual `Backend deploy` workflow with
  `push_migrations=true`.
- `push-dispatch` is a server-to-server Edge Function. Deploy it from the same
  workflow (`deploy_push_dispatch=true`, `--no-verify-jwt`); it authenticates
  callers with the `x-findback-dispatch-secret` header in constant time and reads
  the service-role key from the runtime environment only.
- `reply-comment` is the device-facing Edge Function for notification-shade
  replies (`deploy_reply_comment=true`, `--no-verify-jwt`). It accepts only a
  single-use, expiring token minted by `push-dispatch` (hash-only at rest) and
  posts the reply as the token owner via the service role.
- The `Push dispatch` workflow calls `push-dispatch` every 10 minutes. It no-ops
  with a notice until `PUSH_DISPATCH_SECRET` is provisioned as a GitHub secret
  and the `Backend deploy` + `Sync FCM server secrets` workflows have run.
- The mobile client requests permission, creates the `findback_updates` Android
  channel, registers the FCM token, and writes preferences through the
  `auth.uid()`-scoped RPCs. Notification taps route through the same `/r/<UUID>`
  parser as App Links.
- Push messages are **data-only**: the app's `FindbackMessagingService` replaces
  the Capacitor plugin's service (removed via manifest merge) and presents the
  notification, attaching a `RemoteInput` reply action for COMMENT
  notifications. Foreground messages still forward to JS; taps open MainActivity
  with the canonical report URL.

The Azure deployment token printed during initial provisioning was rotated and
the GitHub secret replaced. The original temporary sender JSON was deleted after
GitHub storage and Supabase digest verification.

## Verification recorded on 2026-10-02

- FCM OAuth and HTTP v1 **validate-only** succeeded; no message was delivered.
- Supabase sender secret digest matched; project and public-origin secrets exist.
- Lint and all-workspace typecheck passed.
- API: 156 tests passed. Mobile: 2402 passed, 1 skipped, 6 todo.
- Selected release/sharing/server-config tooling: 30 tests passed.
- Android debug assembly and JVM tests passed: 35 tests, zero failures/errors.
- Packaged manifest contains `autoVerify`, the canonical HTTPS host and `/r/`.
- Google Services generated resources match the Firebase project/app/sender.
- Bundle and final debug APK checks matched Supabase URL/publishable key,
  Sentry host and public share origin; strict APK scan passed.
- Association JSON matches release certificate SHA-256
  `34115ae9b59768276b54d40bb033682a46ef0f3918d5b783263ea1833a07624c`.
- CLI-deployed HTTPS landing/report shell and association returned 200;
  missing association files returned 404 rather than the SPA HTML fallback.
- Live browser checks at 320px and 1280px passed: landing, shared account gate,
  sign-in and pending-link storage; no overflow/page errors or anonymous report reads.
- GitHub Web deployment: run `36977658113` passed for `abda2c7`.
- GitHub server-secret synchronization: run `36977672171` passed, verifying all
  three stored digests using the repository secrets.
- GitHub CI run `36977658036`: test, Android and Docker jobs passed; the commit
  convention job rejected `abda2c7` because its message lacked the required gate
  body. The subsequent correction commit records its gates.

## Remaining v0.3 gates

Inbox read/unread/delete/restore, the private inbox Realtime signal, FCM
permission/channels/token registration/preferences and server-side dispatch,
nested comments, and scoped notification-shade direct reply are implemented.

No Android device is currently connected. Before releasing v0.3, install a
release-signed candidate and verify OS App Links association and cold/warm taps,
authentication resume, notification delivery/taps, and direct reply. A debug APK
does not match the release-only association certificate. Version/tag publication
stays behind the signed-candidate and device gates.

Before a release-range check that includes `abda2c7`, resolve that original
commit-message defect explicitly. A follow-up commit does not change its body;
history rewriting requires the owner's authorization.
