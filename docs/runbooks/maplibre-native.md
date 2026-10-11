# MapLibre Native runbook (FindBack keyless map)

The report picker, the post viewer, and the post map preview render with
**MapLibre Native Android** (pinned `org.maplibre.gl:android-sdk-opengl`,
see `mapLibreVersion` in `apps/mobile/android/variables.gradle`). Place
search runs through **Nominatim** on explicit submit. There is **no Maps API
key, no Places key, and no Mapbox token** — nothing to provision, restrict,
rotate, or bill.

## What renders where

- **Report → Choose on map (Android):** the native `FindbackMapActivity`
  (full-screen MapLibre map, fixed center pin, explicit Search button, up to
  5 results, "Use my location once", Confirm/Cancel). Cancel never mutates
  the draft; Confirm returns raw coordinates and the app commits through the
  existing approximate-by-default path (exact pin stays an explicit opt-in).
- **Post detail (Android):** a `MapSnapshotter` bitmap preview; tap opens the
  native viewer. No live map is embedded under the WebView.
- **Web/dev (or bridge missing):** a keyless OSM raster grid with the same
  search/confirm semantics. `maplibre-gl` is intentionally NOT used.

## Style endpoint (non-secret config)

Default style: `https://tiles.openfreemap.org/styles/liberty`
(OpenStreetMap-derived data, no SLA — the app treats it as replaceable).

Override locally or per build without code changes:

```sh
# root .env (git-ignored) — or export FINDBACK_MAP_STYLE_URL in the shell
FINDBACK_MAP_STYLE_URL=https://your-host/styles/your-style
```

Rules: HTTPS only, non-empty, not a placeholder — anything else falls back
to the default at runtime (validated natively, never a build failure). Any
MapLibre-compatible style URL works; switching providers means changing this
URL only. The URL is public config, safe to share and safe to log.

Nominatim contact (optional override, same non-secret class):

```sh
FINDBACK_MAP_CONTACT=https://your-public-contact-page
```

Default is the app's public site. It goes into the native search
`User-Agent` (`FindBack/<version> (Android; contact: <contact>)`) per the
Nominatim usage policy — keep it a working public contact.

## Search policy (do not "improve" into autocomplete)

- Explicit Search-button submit only — never per keystroke.
- ≤1 request/second (native `NominatimGate`, web `NominatimThrottler`).
- Max 5 results; sanitized (name + finite in-range coordinates).
- Native requests carry `User-Agent: FindBack/<version> (Android)` per the
  Nominatim usage policy.
- A result recenters the camera but never commits until Confirm.

## Attribution (must stay visible)

Map surfaces credit `© OpenStreetMap contributors` (the SDK draws its own
attribution/logo on the native map; the raster and snapshot surfaces print
the line; search results credit Nominatim). Do not remove it.

## Troubleshooting

| Symptom | Cause → action |
|---|---|
| "The map could not load" + Try again | Style/network unreachable. Retry; Confirm stays available when a valid pin exists. If OpenFreeMap itself is down, switch `FINDBACK_MAP_STYLE_URL` to another MapLibre-compatible style to separate a renderer failure from a provider outage. |
| Search finds nothing | Check connection; Nominatim rate-limits to ≤1 req/s ("wait a moment" message). Pan + confirm the pin always works. |
| "Use my location once" denied | Map stays usable; permission is one-shot, never background. |
| Preview shows fallback tiles | Snapshot failed or timed out (20 s cap). "Open map" still launches the viewer. |
| Release gate `check-map-provider` fails | A Google Maps/Places reference reappeared, or the MapLibre pin drifted — read the listed hits, remove the remnant, keep the single `$mapLibreVersion` source. |

## What must NOT come back

`@capacitor/google-maps`, the Places SDK, `com.google.android.geo.API_KEY`,
`GOOGLE_MAPS_API_KEY` / `VITE_GOOGLE_MAPS_API_KEY`, `FindbackPlaces`,
MapLibre GL JS in the WebView, or an embedded native map under the WebView.
The release gate enforces this (`node scripts/check-map-provider.mjs`).

Untouched on purpose: Google sign-in / `GOOGLE_WEB_CLIENT_ID`, Firebase/FCM,
`play-services-location`, `@capacitor/geolocation`, and the external
"Open in Maps" handoff (geo: URIs, Google Maps links as *input*).

## Runtime proof template (MAP-11)

```text
commit: <sha>  build: debug/signeddev  device: <model/emulator>
Android: <version>  ABI: <arm64-v8a/...>  style: <effective URL host>
picker opens: PASS  Bangladesh renders: PASS  search: PASS
current location: PASS/NOT TESTED (reason)  confirm: PASS  cancel: PASS
snapshot: PASS  viewer: PASS  offline/error: PASS  key absent: PASS
```

Size reference (measured 2026-10-11): MapLibre OpenGL AAR carries
`libmaplibre.so` ~10.8 MB (arm64-v8a) / ~7.9 MB (armeabi-v7a) /
~11.2 MB (x86_64) plus ~0.8 MB Java — per-ABI splits keep release APKs to
one ABI each. Record the before/after APK/AAB delta with each release that
changes the pin.
