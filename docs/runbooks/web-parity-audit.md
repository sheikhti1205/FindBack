# Web parity audit (product-capability audit)

Source revision: `ec4ce24` (`origin/main`, tree clean at write time).
Method: audited the compiled web surface, which is the SAME Capacitor SPA
(`apps/mobile`) deployed to production web (`https://findbackapp.social`,
built by `.github/workflows/web.yml` → Azure Static Web Apps). Web parity is
therefore decided by reading the shared source and every
`Capacitor.isNativePlatform()` / `getPlatform()` / `isPluginAvailable()`
gate, not by a separate web codebase.

## Why this audit exists

A previous cross-environment matrix reasoned about *technologies* rather than
*product capabilities*: it marked Google Auth web = `NOT_APPLICABLE` and
KLIPY web = `N/A` because the Android technologies (Credential Manager, an
Android build) do not exist on the web. But FindBack ships a real production
web app with comments, a location picker with map behaviour, reactions, etc.
This audit re-classifies the WEB product surface feature-by-feature.

## Classification legend (exactly one per feature)

- `IDENTICAL` — same shared component/service; web behaviour matches Android.
- `EQUIVALENT_DIFFERENT_IMPL` — same product capability; the implementation
  differs by platform (native plugin vs web API) with no capability gap.
- `ANDROID_ONLY_INTENTIONAL` — the product feature is deliberately Android
  only; web degrades honestly or explains unavailability.
- `MISSING_BUG` — an accidental omission: the product capability exists on
  Android but is absent/unreachable on web with no justification.

## Feature classification

| Feature | Classification | Justification | Evidence |
|---|---|---|---|
| authentication | `IDENTICAL` | One Supabase session owner and one auth context for every platform; web signed-out visitors get the public landing, signed-in web renders the full Shell. | `apps/mobile/src/auth.tsx`; `apps/mobile/src/services/session.ts`; `apps/mobile/src/App.tsx:53` |
| Google auth | `EQUIVALENT_DIFFERENT_IMPL` | Same product capability, platform-specific mechanism: Android uses Credential Manager → ID token + nonce → `signInWithIdToken`; web uses Supabase `signInWithOAuth` → `/auth/callback` bridge → PKCE exchange. Both resolve through ONE shared outcome resolver. Gated by `check-auth-config.mjs`. | `apps/mobile/src/services/auth/googleSignIn.ts`; `apps/mobile/src/components/AuthLinkBootstrap.tsx`; `apps/mobile/src/utils/externalAuthEntry.ts`; `apps/mobile/src/components/auth/GoogleSignInButton.tsx`; `scripts/check-auth-config.mjs` |
| email signup/signin | `IDENTICAL` | Shared sign-up / sign-in forms call the same Supabase client and session owner. | `apps/mobile/src/components/auth/SignUpForm.tsx`; `apps/mobile/src/components/auth/SignInForm.tsx`; `apps/mobile/src/services/auth.ts:148,180` |
| email verification | `IDENTICAL` | Same Verify screen + OTP exchange against Supabase; no platform gate. | `apps/mobile/src/screens/Verify.tsx`; `apps/mobile/src/services/auth.ts:260,267` |
| password recovery | `IDENTICAL` | Same Forgot/Recovery routes, code exchange and password update; web is fully reachable. | `apps/mobile/src/screens/ForgotPassword.tsx`; `apps/mobile/src/screens/Recovery.tsx`; `apps/mobile/src/services/auth.ts:296,309,318` |
| profile completion | `EQUIVALENT_DIFFERENT_IMPL` | The completion screen is reachable on web: both the native Google handoff and the web `/auth/callback` bridge produce a seed, and `adoptExternalAuthOutcome` routes a seed-less session to `/complete-profile`. | `apps/mobile/src/screens/CompleteProfile.tsx`; `apps/mobile/src/components/AuthLinkBootstrap.tsx`; `apps/mobile/src/auth.tsx`; `apps/mobile/src/screens/AuthGateway.tsx` |
| avatar | `EQUIVALENT_DIFFERENT_IMPL` | Android uses the native media picker; web uses `<input type=file>`. Both then run the same normalize → upload → `update_my_avatar_by_key` RPC path. | `apps/mobile/src/components/ProfileAvatarEditor.tsx:82,149`; `apps/mobile/src/services/avatar.ts` |
| Home | `IDENTICAL` | Shared feed/shell; no platform gate. | `apps/mobile/src/screens/Home.tsx`; `apps/mobile/src/hooks/useFeed.ts`; `apps/mobile/src/components/PostCardHomeFeed.test.tsx` |
| Search | `IDENTICAL` | Shared search screen and filters; no platform gate. | `apps/mobile/src/screens/SearchScreen.tsx`; `apps/mobile/src/screens/AdvancedSearchFilters.tsx` |
| report creation | `IDENTICAL` | Shared CreateReport flow (title, Markdown, category, date, location, publish); no platform gate on the flow itself. | `apps/mobile/src/screens/CreateReport.tsx`; `apps/mobile/src/services/posts.ts` |
| media selection | `EQUIVALENT_DIFFERENT_IMPL` | Web uses a multi-file `<input type=file>`; Android uses the native `FindbackMedia`/Camera picker. Both normalize through the canonical media pipeline. | `apps/mobile/src/screens/CreateReport.tsx:1941`; `apps/mobile/src/services/photo.ts:42`; `apps/mobile/src/services/media/nativeMedia.ts:38` |
| AI photo analysis | `EQUIVALENT_DIFFERENT_IMPL` | Cloud leg is shared (OpenRouter BYOK) and works on web; the local-first leg is Android-only and silently resolves `null` on web so automatic mode falls back to cloud. | `apps/mobile/src/services/analyzeReportPhoto.ts`; `apps/mobile/src/services/analyzeReportPhotoLocal.ts`; `apps/mobile/src/services/ai/applicationAi.ts:657` |
| comments/replies | `IDENTICAL` | Shared PostDetail + CommentComposer and the same comment RPCs; nested replies, edit/delete all shared. | `apps/mobile/src/screens/PostDetail.tsx`; `apps/mobile/src/components/CommentComposer.tsx`; `apps/mobile/src/services/posts.ts:375,410,472` |
| mentions | `IDENTICAL` | Shared autocomplete + Markdown mention render; no platform gate. | `apps/mobile/src/components/MentionAutocomplete.tsx`; `apps/mobile/src/components/MarkdownView.tsx` |
| reactions | `IDENTICAL` | Shared reaction tray/model/feed; no platform gate. | `apps/mobile/src/components/ReactionTray.tsx`; `apps/mobile/src/services/reactions.ts`; `apps/mobile/src/services/feedReactions.ts` |
| comment media | `IDENTICAL` | Shared attachment model, same Storage bucket + upload; web reaches it through the file input (photos and short video). | `apps/mobile/src/services/commentAttachments.ts`; `apps/mobile/src/services/commentBodyMedia.ts` |
| KLIPY | `IDENTICAL` | One shared KLIPY adapter and composer control, gated only by `VITE_KLIPY_API_KEY`. Blank key hides the control on every platform, never fakes results. `web.yml` and `release.yml` now bake the key from a repo secret, and `check-klipy-config.mjs --assets/--apk` proves it is in the shipped bundle. | `apps/mobile/src/services/klipy.ts`; `apps/mobile/src/components/CommentComposer.tsx`; `.github/workflows/web.yml`; `scripts/check-klipy-config.mjs` |
| emoji | `EQUIVALENT_DIFFERENT_IMPL` | Android uses the native curated emoji sheet; web renders the compact `EMOJI_WEB_FALLBACK` grid. Both insert at the caret; no functional gap. | `apps/mobile/src/services/emojiPicker.ts`; `apps/mobile/src/components/CommentComposer.tsx:292` |
| profile/settings | `IDENTICAL` | Shared Profile/ProfileEdit/Settings and the full settings route tree; no platform gate. | `apps/mobile/src/screens/Profile.tsx`; `apps/mobile/src/screens/Settings.tsx`; `apps/mobile/src/App.tsx:148` |
| notifications inbox | `IDENTICAL` | Shared inbox + realtime subscription + read/unread/delete/undo; Android-only system push is an additive delivery channel, not a replacement. | `apps/mobile/src/screens/Notifications.tsx`; `apps/mobile/src/services/notifications.ts`; `apps/mobile/src/services/realtime.ts` |
| Assistant | `EQUIVALENT_DIFFERENT_IMPL` | Cloud assistant + built-in fallback answers work on web; on-device model picker and voice dictation are Android-only and degrade honestly on web. | `apps/mobile/src/services/assistant/cloudAssistant.ts`; `apps/mobile/src/services/auth.ts:545`; `apps/mobile/src/services/speechInput.ts:154` |
| cloud AI | `EQUIVALENT_DIFFERENT_IMPL` | Same BYOK OpenRouter adapter on all platforms; web additionally requires an unlock phrase for remembered keys (device-keychain vs WebCrypto difference). | `apps/mobile/src/services/openRouter.ts`; `apps/mobile/src/screens/AiConnection.tsx:541` |
| local AI | `ANDROID_ONLY_INTENTIONAL` | On-device downloads/inference are deliberately Android-only; the web build refuses and documents it rather than faking a model. | `apps/mobile/src/services/ai/applicationAi.ts:657`; `apps/mobile/src/screens/AiModels.tsx:76`; `apps/mobile/src/services/appCapabilities.ts:91` |
| maps/location | `EQUIVALENT_DIFFERENT_IMPL` | Android uses the native MapLibre picker/snapshot/viewer; web uses a keyless OSM raster tile grid with zoom (no MapLibre GL). Same draft/confirm path; Nominatim geocoder works on both. | `apps/mobile/src/native/mapLibreMaps.ts`; `apps/mobile/src/components/InteractiveLocationMap.tsx:58,162`; `apps/mobile/src/services/location/rasterTiles.ts`; `apps/mobile/src/services/location/nominatimSearch.ts` |
| sharing | `IDENTICAL` | Shared `shareReport` using Web Share API with clipboard fallback; Android additionally uses `AppLauncher` for the maps hand-off. | `apps/mobile/src/components/ReportShareButton.tsx`; `apps/mobile/src/utils/shareReport.ts`; `apps/mobile/src/utils/location.ts:345` |
| Sentry | `IDENTICAL` | Same privacy-sanitized `initMonitoring`; the web lane supplies DSN + `dist=web-production` + release so events symbolicate. | `apps/mobile/src/services/monitoring/sentry.ts:580`; `.github/workflows/web.yml:18-22`; `docs/runbooks/production-config-matrix.md:18` |
| account deletion | `IDENTICAL` | Same AccountSettings confirm flow calling the `delete-account` edge function; deployment state is a separate (live-backend) concern. | `apps/mobile/src/screens/AccountSettings.tsx`; `apps/mobile/src/services/auth.ts:336`; `supabase/functions/delete-account` |

## MISSING_BUG findings

**Resolved in the X1–X6 wave — no `MISSING_BUG` remains.**

1. **Google auth was absent on production web (FIXED).** The button is now
   strategy-aware (`googleAuthStrategy` → `android-native` | `web-oauth` |
   `unavailable`) and the web branch calls Supabase `signInWithOAuth`. The
   `/auth/callback` ordinary-path entry is captured before the router mounts
   (`captureExternalAuthEntryFromWindow`), origin-allowlisted, stripped from the
   address bar, and exchanged once via `completeGoogleWebCallback`. Android
   Credential Manager is untouched; both paths share
   `resolveOutcomeForCurrentSession`.
2. **Profile completion was unreachable on web (FIXED).** The web callback
   bridge routes a seed-less session to `/complete-profile` with the seed, and
   `adoptExternalAuthOutcome` mirrors the native context update.

Both are now `EQUIVALENT_DIFFERENT_IMPL` in the table above. The invariant that
these cannot silently regress is enforced by `scripts/check-auth-config.mjs`
(source contracts) and `apps/mobile/src/services/auth/googleSignIn.web.test.ts`
＋ `apps/mobile/src/utils/authExternalEntry.test.ts` (web-lane behaviour).

### Checked and NOT bugs (intentional platform differences)

- Push notifications: `pushNotifications.ts` reports `unsupported` on web by design; the inbox still works and no native push is promised.
- Voice dictation: Android-only with an honest web message (`speechInput.ts:154`).
- Local/on-device AI: Android-only by design with explicit web copy (`appCapabilities.ts:91`).
- On-device geo `servicesEnabled` and native snapshots degrade to documented web fallbacks, never hard-fail.
