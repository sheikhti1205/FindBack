# Google sign-in owner console checklist (FindBack)

FindBack Google login is **Credential Manager → Google Auth Platform Web-client
`serverClientId` → Supabase `signInWithIdToken`**. There is no Firebase, no
`google-services.json` requirement, and no client secret anywhere in this path:
the Web OAuth client ID is a public identifier baked into the APK as
`BuildConfig.GOOGLE_WEB_CLIENT_ID` (Gradle reads the `GOOGLE_WEB_CLIENT_ID`
env var; `scripts/build-apk.mjs` loads it from the shell or root `.env`).

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
      OAuth client ID and client secret** entered there. The mobile app never
      sends the secret; Supabase verifies the ID token server-side against it.
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

Console changes need no app rebuild (they are server-side), except changing
the Web client ID itself, which requires a rebuild so the new audience is
baked into `BuildConfig.GOOGLE_WEB_CLIENT_ID`.
