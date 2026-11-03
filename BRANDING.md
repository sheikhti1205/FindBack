# FindBack name and branding

The FindBack name, the FindBack logo, the app icon, the wordmark and the visual
identity of the app are **not** licensed under the PolyForm Noncommercial License.
They remain the property of Sheikh Tawsif Bin Aftab.

You may:

- refer to FindBack truthfully when describing the software (for example, "a fork of
  FindBack") as long as you do not imply endorsement;
- keep the name in an unmodified copy you run privately for a permitted
  noncommercial purpose.

You may not, without written permission:

- publish a modified build, fork or service under the FindBack name or logo;
- use the name or logo in a way that suggests official status, partnership or
  endorsement;
- register FindBack-like names, domains, package names or store listings.

A commercial license (see [COMMERCIAL.md](COMMERCIAL.md)) does not automatically
include branding rights; ask for them explicitly if you need them.

## Current asset authority and regeneration

The current owner-approved identity is the **bird/leaf emblem**, from
`apps/mobile/src/assets/brand/brand-tile-master.png` (2026-10-19, SHA256
`27c4f0479e5240b549183731d4302633c31734a405d1bdf2cc154543ebcc0b4d`).
`logo2-master.jpg` is the historical 2026-10-09 pin/FB mark, retained for
provenance, **not** an input to current platform assets. Do not redraw or trace
either asset. The current master matches the owner's header reference.

Use `BrandMark` in React. Its default is the monochrome alpha emblem, with the
bird/leaf interior keyed out; `shape="tile"` retains the exact prepared owner's
two-ink treatment. Both preserve the master's geometry. The wordmark is text,
not baked into platform icons.

The shared `AuthShell` (email/Google gateway, verification and profile completion)
also uses `BrandMark` for its header and supporting glyph. A generic Radar icon
is not a FindBack logo. The canonical brand gate covers these shared auth and
onboarding consumers, not just generated platform assets.

Maintained generation (Python 3.12+ and Pillow 11.1.0):

```sh
python3 scripts/generate-brand-assets.py
python3 scripts/generate-brand-assets.py --check
python3 scripts/brand-assets.test.py
node scripts/check-brand-consistency.mjs
```

The generator promotes the original October 19 threshold/footprint/crop/pad
derivation; the prepared tile hashes remain unchanged. It emits React marks,
explicit 16/32/48px favicons, 180/192/512px web icons, a 16/32/48 ICO fallback,
legacy/adaptive/themed Android icons, alpha notification icons and native splash
rasters. `generated-brand-manifest.json` records master and generator hashes,
recipes, dimensions and every output hash. CI checks references and reproduces
all bytes; size-only checks cannot bless unrelated artwork.

Adaptive foregrounds have no precomposed tile and fit the 66dp Android safe zone
(64dp artwork on 108dp canvas). Notification PNGs are white ink plus transparency,
not a bell or launcher tile. Native and React splash are independently covered.

### Deployment and acceptance

Current web icon URLs use `findback-birdleaf-v1-*`, not the former stable names.
Compatibility URLs also contain current bytes for existing bookmarks. A new
identity or changed icon bytes require a new URL generation token. HTML remains
revalidated (`no-cache`); there is no app PWA/service-worker subsystem to bump.
Verify live HTTP status, MIME type, cache headers and SHA256 against the manifest
after deployment. A correct source PNG is not deployed-browser acceptance.

Before claiming migration complete, inspect a fresh browser **and an existing
profile that displayed the old icon**, reopen/normal reload, and pinned/bookmark
surfaces where applicable. Do not prescribe clearing every user's cache.
Android acceptance requires a real upgrade (not just clean install), launcher/app
drawer, themed icons, circular/squircle masks, Settings identity, native/React
splash and real notification status/shade/lockscreen in light/dark. These remain
unpassed without observations; this asset change does not authorize an APK,
version bump or release.

Current README screenshots are explicitly historical. GitHub social preview,
console-only email template logos and store graphics are separate admin surfaces;
a repository commit cannot claim to have updated them. If configured, use the
current public `findback-birdleaf-v1-512.png` or the generated canonical asset;
never add remote email image tracking just to display a logo.
