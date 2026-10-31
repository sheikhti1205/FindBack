# GitHub Releases distribution design (SPEC ONLY)

## 1. Current GitHub limits (verified 2026-09-21, cite before relying)

Source: `docs.github.com/repositories/releasing-projects-on-github/about-releases`
(and the backing variables in `github/docs` repo,
`content/repositories/releasing-projects-on-github/about-releases.md`):

- **Up to 1000 release assets per single release.**
- **Each file in a release must be under 2 GiB.**
- **No limit on total release size, nor on bandwidth.**
- REST API rate limits (`docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api`):
  **60 req/hr unauthenticated, 5,000 req/hr authenticated** (per user/token).
  Binary download goes via `browser_download_url` redirect
  (`docs.github.com/en/rest/releases/assets`) — metadata calls are the
  rate-limited part, which is why the app must not poll the API at runtime (§4).

## 2. Is `.part01/.part02` chunking necessary?

**No — for every v1 small candidate.** Largest planned single asset is the
LFM2.5-1.2B int8 `.fbmodel` (~1.25 GB cited by the converter card), under 2 GiB.
SmolVLM2-500M (~361 MB) and the Qwen 0.6B class fit with wide margin.

**Yes — only for large catalog entries IF ever distributed:** the Gemma-3n-E2B
 int4 `.litertlm` is listed at ~3.66 GB (preview repo file listing; the
 registry note corrects an older ~2 GB figure to ~3.39 GB). Any file >2 GiB
MUST be split (e.g. `.fbmodel.part01/.part02`, each <2 GiB) with the part list
+ per-part SHA-256 inside the release `checksums.txt` and the in-package
 manifest. Gemma stays `catalogOnly` in v1 — chunking design is recorded here
 so future implementation work does not re-research it.

Alternative considered: Git LFS for weights. Rejected for v1 — release assets
already give unlimited total size + bandwidth without LFS quotas/client
requirements; LFS adds a second rate-limit bucket and client complexity.

## 3. `FindBack-Models` curated release layout (design)

- **Separate repo** `FindBack-Models` (not the app repo): isolates signing/
  publish permissions, keeps app clones lean, avoids any pressure on the
  1000-asset/release cap from app binaries.
- **One release per artifact set**, immutable tag scheme:
  `models/<entry-id>/<upstream-rev-short>-<recipe>` (e.g.
  `models/smolvlm2-500m/dad030b6-int4`). Never re-upload under an existing tag
  (GitHub refuses same-name re-upload; rotation = new tag + new catalogue pin).
- **Assets per release:**
  - `<entry-id>.fbmodel` (the data-only package, see fbmodel-package.md),
  - `<entry-id>.fbmodel.sha256` (sidecar for pre-download check),
  - `checksums.txt` (whole-package + per-part hashes),
  - `provenance.json` (upstream repo/rev/file, converter, license id, card URLs).
- Chunked large assets (future only): `<entry-id>.fbmodel.part01`,
  `.part02`, … each <2 GiB, enumerated in `checksums.txt`.

## 4. Built-in shipped catalogue metadata (hard rule)

- The app **ships `catalogue.v1.json` in-app**, pinned to one immutable
  `pinnedModelsRelease.tag` (repo + tag + per-asset SHA-256 baked in).
- The app **MUST NOT depend on a mutable remote list** at runtime (no
  "latest release" fetch, no branch-file fetch) — rationale: supply-chain
  pinning (tamper/rollback surface, see threat-surface.md) AND reliability
  (60 req/hr unauthenticated quota makes runtime API dependence fragile).
- Catalogue updates ship **with app updates** (new JSON + new pin). Download
  URLs are the pinned `browser_download_url`s — no token needed, CDN-redirected.
- Resume via HTTP Range (future downloader work); per-asset SHA-256 verified
  post-download against the SHIPPED pin, never against a freshly fetched value.
