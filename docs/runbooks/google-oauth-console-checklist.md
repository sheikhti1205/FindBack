# Google sign-in owner console checklist (FindBack)

FindBack preserves two distinct Google sign-in paths:

- **Web:** Supabase `signInWithOAuth` → Google consent → hosted Supabase callback
  → `/auth/callback` → PKCE `exchangeCodeForSession`. Supabase needs the matching
  **Web application** client ID and secret for Google's authorization-code exchange.
- **Android:** Credential Manager → Web-client `serverClientId` → Google ID token
  + nonce → Supabase `signInWithIdToken`. No Google client secret is sent by the app.

There is no Firebase or `google-services.json` requirement. The Web OAuth client
ID is a public identifier baked into the APK as
`BuildConfig.GOOGLE_WEB_CLIENT_ID` (Gradle reads the `GOOGLE_WEB_CLIENT_ID`
env var; `scripts/build-apk.mjs` loads it from the shell or root `.env`).

Never paste, fetch, log, screenshot, or send a client secret to an agent. The
owner enters the matching secret directly in Supabase's provider console.

## Resolution (2026-11-03, owner-reported + entry probe)

The remaining blocker was a missing **Authorized JavaScript origin** in the Google
Cloud console for the Web OAuth client. The owner added
`https://findbackapp.social` to that client's authorized origins and reports Google
sign-in now completes, including the Supabase code exchange that previously failed.

Credential-free agent check of the deployed app (`c1c3c984`,
`https://findbackapp.social/` → onboarding Skip → `/auth` → **Continue with Google**):
the page is handed to `accounts.google.com/v3/signin/identifier` with
`client_id` present, `redirect_uri=https://nfjhpigbsyyoaaktfaev.supabase.co/auth/v1/callback`,
`scope="email profile"`, title "Sign in - Google Accounts" and body
"Sign in to continue to nfjhpigbsyyoaaktfaev.supabase.co"; no `origin_mismatch`,
`redirect_uri_mismatch`, `invalid_client` or "Access blocked" text. A direct
authorize probe with the same client/redirect and `prompt=none` returns a 302 to the
hosted callback (`error=interaction_required`), i.e. client and redirect are accepted
without a session. Receipts:
`FindBack-internal/01_ACTIVE/onboarding-root-integration-2026-11-03/sessions/A/production-google-entry.json`
and `captures/production-google/google-entry.png`.

Boundaries: no credentials were entered, so this proves the console/provider entry
configuration, not an agent-observed successful login, identity linking, or a
signed physical-device Google login. Those rest on the owner's report.

**Lesson:** the JavaScript origin is part of the client configuration even though the
authorization-code exchange happens server-side at Supabase. A missing origin can
surface as a provider-side failure, so it is checked before re-entering a secret.

## Recovery status (2026-11-02 handoff; historical)

- Intended Web client:
  `961478941021-4hj634u50dug9mrjda769l7p98bh9hv1.apps.googleusercontent.com`.
  The public authorize probe selected this client and the hosted callback below;
  an HTTP redirect proves selection, **not** a successful Google login.
- The handoff reports `invalid_client — The provided client secret is invalid.`
  at `2026-11-02T17:26:24Z`. Next owner action: enter the secret belonging to
  **that exact Web client** directly in Supabase → Authentication → Providers →
  Google, then save. Do not substitute the Android client or request its secret.
- The second listed client
  `961478941021-1qtajvs93gj6f6a5g9lsumlhtsa5a6in.apps.googleusercontent.com`
  has **unverified type**; inspect its type/package/fingerprint in Google Cloud
  before assigning it a role. Site URL/Redirect URLs remain unverified too.
- Production/local Web login and signed physical Android Credential Manager
  login are **unpassed**. The owner performs signup; source checks cannot replace it.

The app fails closed: when the ID is missing the button reports
`misconfigured` and sign-in is never attempted. When the failure is
console-side (OAuth clients / SHA-1 / provider enablement), the app now shows
**"Google sign-in isn't set up yet. Please try another sign-in method."**
(`misconfigured`) instead of blaming the device. Exact native kind comes from
logcat tag `GoogleAuthPlugin` via the Credential Manager exception type.

## 1. Google Auth Platform (Google Cloud console)

Project with the Android app package `com.findback.app`:

- [ ] **Web OAuth client exists** (APIs & Services → Credentials → OAuth 2.0
      Client IDs → type **Web application**). Its client ID ends with
      `.apps.googleusercontent.com` — this exact value is `GOOGLE_WEB_CLIENT_ID`.
- [ ] Web client's **Authorized redirect URIs** includes exactly
      `https://nfjhpigbsyyoaaktfaev.supabase.co/auth/v1/callback`.
      This is Google's return to Supabase, not the app's `/auth/callback` route.
- [x] Authorized JavaScript origins include `https://findbackapp.social` and
      only the local development origins actually used (origin only, no path).
      **Confirmed added by owner 2026-11-03** — its absence was the last blocker;
      see "Resolution" above. Keep it in place for any new Web client.
- [ ] **Android OAuth client exists** for package `com.findback.app` with the
      **release SHA-1** `61:E9:32:D5:14:A0:28:7B:7B:6E:49:F1:90:70:2C:F4:F7:CF:D1:8A`.
      (A debug SHA-1 only covers local debug builds, never the signed
      device/release build.)
- [ ] OAuth **consent screen** is configured (published or test users include
      the login account) — otherwise the Credential Manager sheet cancels or
      returns no credential (`cancelled` / `unavailable`).
- [ ] The value exported at build time matches the Web client ID exactly:
      `node scripts/check-google-config.mjs` must print `PROVIDED`.

## 2. Supabase dashboard (auth providers)

- [ ] **Authentication → Providers → Google → Enabled**, with the **same Web
      OAuth client ID and matching client secret** entered there. The secret is
      used by Supabase for the Web authorization-code exchange; Android ID-token
      verification checks the token/audience/nonce, not a secret sent by the app.
- [ ] **Authentication → URL Configuration:** production Site URL is
      `https://findbackapp.social`; Redirect URLs permit
      `https://findbackapp.social/auth/callback` and each exact local callback
      actually in use. A localhost error return can indicate fallback/allowlist
      configuration; it is not proof of an app routing defect.
- [ ] If logcat shows a successful Credential Manager token but the exchange
      fails, the Supabase auth log (`provider is not enabled`,
      `invalid JWT: unable to verify`, nonce/audience mismatch) is the source
      of truth — that is a **Supabase rejection**, not an app bridge issue.

## 3. Reading a device failure (logcat)

```
adb -s <device> logcat | grep -i "GoogleAuth\|CredentialManager"
```

| What you see | Kind | Meaning / owner action |
|---|---|---|
| `isAvailable → available:false, reason:misconfigured` | `misconfigured` | Empty `GOOGLE_WEB_CLIENT_ID` in the packaged build — rebuild with the env var set (§1). |
| `GetCredentialProviderConfigurationException` | `misconfigured` | Console-side: Android OAuth client missing, SHA-1 mismatch, or ID services disabled — fix in §1. |
| `NoCredentialException` (filter by authorized accounts) | `unavailable` | No authorized Google account on the device — device state, not a bug. |
| `GetCredentialUnsupportedException` | `unavailable` | Play Services too old / Credential Manager unsupported — device state. |
| user dismisses the sheet | `cancelled` | Silent by design, no error shown. |
| `IOException` cause chain | `network` | Connectivity. |
| Supabase `signInWithIdToken` error after a token was issued | provider error | Supabase rejection — fix in §2. |

The ID token and raw nonce are **never** logged by the app; error strings are
stable human copy, never raw platform text.

## 4. After changing console state

Secret/redirect/provider corrections are server-side and need no app rebuild.
Changing the Web client ID requires a new Android build so its audience matches
`BuildConfig.GOOGLE_WEB_CLIENT_ID`; it does not justify rewriting Web PKCE or the
Credential Manager bridge.

After configuration, verify separately: production Web login and callback;
local Web login and callback; signed Android Credential Manager login; existing
email/password signup and recovery. Record actual outcomes without tokens,
authorization codes, raw nonces, secrets, or account personal data.

References: [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google),
[Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
