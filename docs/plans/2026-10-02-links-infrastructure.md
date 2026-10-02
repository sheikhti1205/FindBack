# Canonical sharing and notification infrastructure

Approved scope: owner-provided `FindBack_v0.3_Notifications_AppLinks_Web_Handoff.zip`,
phases 2–3 and notification credential provisioning. Baseline `90c9b31`.

## Contracts and constraints

- Public origin: `https://findbackapp.social`.
- External path: `/r/<UUID>`; optional `focus=comments|activity|manage`, with
  `comment=<UUID>` only for comments. Reject unknown hosts, malformed IDs,
  duplicate/unknown parameters, credentials and normalization tricks.
- Reuse HashRouter/Supabase authentication. Public landing and shared-link gate
  expose no report data; authenticated links enter the existing PostDetail.
- Native cold/warm links use the same parser. Pending URLs stay in sessionStorage
  for at most one hour, are validated on read, and are consumed after navigation.
- All production builds require and verify public share origin, Supabase URL and
  publishable key. Server credentials never reach a browser/APK build job.
- Azure Free remains the only web host. No version bump, tag, or publication.

## Execution

1. Create dedicated Firebase `findback-push` sender, enable FCM HTTP v1, grant
   `roles/firebasecloudmessaging.admin`. Mint OAuth and use FCM validate-only
   (no delivery). Store JSON in GitHub and Supabase secrets; delete temporary key
   after both stores are verified. Rotate the Azure deployment token previously
   printed by setup and update the GitHub secret.
2. Test canonical sharing, parser rejection cases and build-origin assertions
   before implementing `reportLinks.ts` and `check-share-config.mjs`.
3. Test cold/warm navigation, auth resume, pending-link expiry and public gate.
   Add `ReportLinkHandler`, pending-link storage and public/shared screens.
4. Add verified manifest filter deriving hostname from the build environment.
   Emit root assetlinks with the actual beta.3 release APK certificate fingerprint.
   Keep the association JSON outside SPA fallback and cache it briefly.
5. Add Azure workflow building the existing mobile web output with real public
   config, verifying baked values, and deploying prebuilt static files. Wire origin
   through CI/release/Docker builds and materialize Google client config only in
   Android jobs. Add separately dispatched server-secret synchronization.
6. Run focused tests, typecheck, lint, secret scan, then full mobile/script tests.
   Build with asserted canonical local Supabase config and verify emitted bundle.
   Deploy the tested working tree to Azure via CLI and verify landing, shared route,
   and root association over HTTPS. Android App Links device proof requires a
   signed candidate installed on a connected device; record any remaining blocker.
