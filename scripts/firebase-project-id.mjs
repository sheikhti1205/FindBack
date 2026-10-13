#!/usr/bin/env node
/**
 * Canonical FindBack Firebase project identity.
 *
 * ONE source of truth for the Firebase *client* project id used by the Android
 * google-services.json materializer AND the *server* push-dispatch project id.
 * The FCM client and the FCM server MUST belong to the same Firebase project,
 * otherwise a client-side token can never be delivered by the server service
 * account. `materialize-google-services.mjs` writes the client config for this
 * id; `check-push-config.mjs` cross-checks the server `FCM_PROJECT_ID` against
 * it so a client/server project mismatch fails preflight instead of silently
 * dropping every push.
 *
 * This is a public identifier (it ships inside google-services.json), NOT a
 * secret.
 */
export const FINDBACK_FIREBASE_PROJECT_ID = "findback-mobile-app";
