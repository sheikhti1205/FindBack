# Google Maps owner key runbook (FindBack A3)

The location picker and the read-only post map render with the **native**
Google Maps SDK (`@capacitor/google-maps`); place search runs through the
**native Places SDK** (`FindbackPlaces` bridge). Both need one Android-app-
restricted API key. The app fails closed without it: the picker and the post
map show *"The interactive map isn't available right now"* with the raster
fallback, and search falls back to Nominatim — **nothing crashes, nothing
blocks a report**.

Never paste the key into chat, screenshots, or any file except the ignored
local env files below. Nobody needs to see the key value — only whether a
build carries one (`VITE_GOOGLE_MAPS_API_KEY` present/absent in the build log).

## 1. Google Cloud console — create the restricted key (owner, ~5 min)

Project with billing enabled (Maps/Places SKUs bill to it):

- [ ] **APIs & Services → Library → enable** (both):
  - **Maps SDK for Android**
  - **Places SDK for Android** (listed as *Places API* — enable the
    **new** Places API, not only the legacy one)
- [ ] **APIs & Services → Credentials → Create credentials → API key**.
- [ ] **Restrict the key** (edit the key → *Application restrictions* →
      **Android apps** → Add package + fingerprint):
  - Package name: `com.findback.app`
  - SHA-1 certificate fingerprint:
    `61:E9:32:D5:14:A0:28:7B:7B:6E:49:F1:90:70:2C:F4:F7:CF:D1:8A`
- [ ] *API restrictions* → **Restrict key** → select **only**:
  - Maps SDK for Android
  - Places API (new)
- [ ] Save. Key changes take a few minutes to propagate.

## 2. Feed the key to local builds (owner device)

The key reaches the APK through **one** env var read from the shell or the
ignored root `.env` (never committed):

```sh
# root .env (git-ignored) — or export GOOGLE_MAPS_API_KEY in the shell
GOOGLE_MAPS_API_KEY=<the key from step 1>
```

What consumes it:

- `apps/mobile/vite.config.ts` derives `VITE_GOOGLE_MAPS_API_KEY` for the web
  layer (`GoogleMap.create({ apiKey })`).
- `apps/mobile/android/app/build.gradle` injects it as the
  `com.google.android.geo.API_KEY` manifest placeholder (native map + the
  `FindbackPlaces` bridge reads it from the manifest at runtime).
- Missing/empty is **not** a build failure — the APK builds fine and the map
  surfaces fail closed (see above).

## 3. Verify on device

- [ ] Rebuild + reinstall (`npm run apk` path or the signed-dev build).
- [ ] Report → **Choose on map**: native map renders, marker drags, tap
      places the pin, **Use my location once** recenters, Search returns
      *Powered by Google* results.
- [ ] A post with coordinates shows the native map with a fixed marker.
- [ ] Without the key (unset var + rebuild): the picker shows the
      *"isn't available right now"* state, search still works (Nominatim),
      Confirm stays usable.

## 4. Troubleshooting (no key values needed)

| Symptom | Likely cause |
| --- | --- |
| Map area grey/blank, fallback shows "could not start" | Key missing in manifest (env var unset at Gradle time) or APIs not enabled |
| `REQUEST_DENIED` in logcat (`FindbackPlaces`) | Places API (new) not enabled, or key restrictions wrong package/SHA-1 |
| Search works but says OpenStreetMap | Native bridge unavailable/misconfigured → Nominatim fallback (expected without a key) |
| Map renders in one surface but not the other | Stale install — reinstall; each surface creates/destroys its own native view |
