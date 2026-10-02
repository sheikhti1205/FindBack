# FindBack

FindBack is a minimal **lost & found reporting and recovery app** for the
Mobile App Development Lab (University of Chittagong). It is delivered as an
Android APK (Capacitor) that talks **directly to hosted Supabase** (Auth,
PostgreSQL Data API/REST, GraphQL, Realtime, Storage, Edge Functions); SQLite is
only the Node reference/demo test backend. Monorepo layout below.

## Requirements coverage (24 teacher requirements)

See `docs/REQUIREMENTS_MATRIX.md` for the full traceability matrix and
`docs/DEMO_CHECKLIST.md` for the teacher-demo walkthrough.

## Stack

| Area | Choice |
|---|---|
| Mobile UI | React + TypeScript + Vite + Tailwind CSS + Framer Motion |
| Android packaging | Capacitor → Gradle debug APK |
| API | Hosted Supabase: PostgREST/Data API (REST) + `pg_graphql` (GraphQL); the Node/TS Express + GraphQL-Yoga + Socket.IO server is retained as a Docker/coursework reference |
| Database | Supabase PostgreSQL (Data API) in production; SQLite `node:sqlite` for tests/local |
| Auth | Supabase Auth (email OTP via custom SMTP) in production; local JWT for tests/local |
| Storage | Supabase Storage (public `findback-images` bucket) — the app normalizes images on-device and uploads directly under its own `<uid>/` folder (owner-scoped RLS); local uploads dir for tests/local |
| AI | Optional cloud AI via the user's own OpenRouter key, pinned to the free route (`openrouter/free`) — Help answers and consented report-photo suggestions; a built-in answer covers the no-key case. FindBack never switches to a paid model and never stores the key on its servers. The Node server's `LLM_*` fallback is reference-only. |
| ML | No bundled generative model and no image classifier (legacy MobileNet and the on-device VLM were retired); **on-device text embeddings only** — Universal Sentence Encoder via the native bridge, cosine top-3 for Possible Matches, no vector DB, no server AI |
| CI | GitHub Actions |

## Repo layout

```
apps/mobile      React + Vite + Tailwind + Framer Motion + Capacitor
services/api     REST + GraphQL + Socket.IO (Supabase in production, SQLite locally)
packages/shared  shared Zod schemas, types, constants
docs/            requirements matrix, ERD, reporting, demo checklist
```

## Quick start

```bash
npm install

# API (SQLite file in services/api/data; auto-seeds demo data)
npm run dev:api                # http://localhost:4000  (GraphQL: /graphql)

# Mobile web dev (talks directly to hosted Supabase)
npm run dev:mobile

# Tests / checks / build
npm test
npm run typecheck
npm run lint
npm run build

# Android APK (from repo root): canonical root .env contains SUPABASE_URL
# and SUPABASE_PUBLISHABLE_KEY; set VITE_PUBLIC_SHARE_ORIGIN from .env.example
# and export a real VITE_SENTRY_DSN as well.
npm run apk
# → apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Mobile builds derive `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
from the canonical `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in the ignored
root `.env` (or accept explicit nonempty `VITE_*` exports). Only the publishable
key can be bundled; a secret key fails the build. CI reads the public URL from
the `VITE_SUPABASE_URL` repository variable and the publishable key from the
`VITE_SUPABASE_PUBLISHABLE_KEY` repository secret. Both CI and local APK builds
check the effective values before building and check the JavaScript and final
APK against the expected values before distributing it. The app talks **only** to hosted Supabase — Auth, the Data API (feed,
posts, comments, reactions, ratings), Realtime (private broadcast channels) and
Storage (on-device-normalized image uploads) — plus OpenRouter for the optional
AI features described below. The Node Express API remains in the repo as a
Docker/coursework reference but is not part of the mobile runtime. Post and
comment payloads expose a public author profile only — never email or phone.

## Public sharing and Android App Links

The public web surface is hosted at
<https://findbackapp.social>. Shared reports use
`/r/<UUID>` and require a FindBack account to view report content. Signing in
resumes the validated report link, including a comments/activity/manage focus.
Android builds declare verified HTTPS App Links for the same host; the public
`/.well-known/assetlinks.json` pins the release signing certificate.

`VITE_PUBLIC_SHARE_ORIGIN` is mandatory for production web/Android/Docker builds,
with pre-build validation and post-build bundle/APK checks. Firebase Android
client configuration is ignored locally and restored from a GitHub secret in
Android CI. FCM server credentials are confined to the separately dispatched
server-secret workflow. Notification delivery and device-level App Links proof
remain pending for the v0.3 feature wave; see
[`docs/runbooks/SHARING_AND_PUSH_INFRASTRUCTURE.md`](docs/runbooks/SHARING_AND_PUSH_INFRASTRUCTURE.md).

**AI (optional, cloud):** AI is off until the user connects their own OpenRouter
API key under Profile → AI Connection. FindBack is pinned to the free route
(`openrouter/free`), never falls back to a paid model, and stores the key only on
the device. Help answers are generated by OpenRouter with that key, and the
create-report photo assistant sends the selected photo to OpenRouter **only after
an explicit consent notice** to suggest a title, category, and description; with
no key connected, Help answers from a built-in list and no request leaves the
device. There is **no downloadable or offline generative model**, no GPU/CPU
model-mode selector, and no server-side AI Help. The post-detail screen still
shows "Possible Matches" from **on-device** text embeddings (top-3 cosine over
the native MediaPipe TextEmbedder asset — never a probability, no vector DB, no
server AI); that non-generative similarity bridge is retained and independent of
the cloud AI route.

Demo login for the **local/demo backend** (`DB_PROVIDER=sqlite` seed only): any of
`rafi_cu`, `nusrat`, `tanvir_ce`, `shimu`, `arif_cse`, `mitu`, `sayeed_bsc`,
`priya` with password `password123`. Against hosted Supabase, create an account
through the app (real email OTP) — there are no seeded production accounts.

## Useful commands

```bash
# Supabase REST/GraphQL examples   docs/API_DEMO.md
# Legacy Node reference server     npm run dev:api   (GraphiQL at :4000/graphql)
# Activity report (legacy Node)    node scripts/report-activity.mjs [--csv out.csv]
# Regenerate vector ERD PDF        python3 tools/render_erd.py
# Docker single container          docker compose up --build   (needs Docker Engine)
# CI also builds the image, runs it and checks /health on every push (no local engine needed)
```

## Demo/dev credentials & provider mode

The real production stack is hosted Supabase — Auth, the Data API, Realtime and
Storage — used directly by the app, plus optional OpenRouter AI with the user's
own key. The Node Express API (`services/api`, `DB_PROVIDER=supabase|sqlite`)
remains as a Docker/coursework reference and for the local demo mode:
verification codes are returned by the server (`devCode`) instead of SMS,
uploads are stored on local disk, and the reference server's AI Help answers
from a deterministic fallback until `LLM_*` env vars are set (the mobile app
does not use this path). No secrets are committed; copy `.env.example` → `.env`
and never commit `.env`.

## Docs

- `docs/REQUIREMENTS_MATRIX.md` — 24 teacher requirements → implementation
- `docs/DEMO_CHECKLIST.md` — teacher walkthrough
- `docs/erd/ERD.md` + `docs/erd/ERD.pdf` — schema & entity relationship diagram
- `docs/reporting/REPORTING.md` — reporting API, report queries, Crystal import
- `DEFERRED_DECISIONS.md` — provider decisions & their swap points
- `docs/OPEN_SOURCE_RESEARCH.md` — licensing research for reference repos

## License / provenance

All code is original. Third-party packages are listed in `THIRD_PARTY_SOURCES.md`;
open-source reference research is in `docs/OPEN_SOURCE_RESEARCH.md`; Norfold reuse
notes are in `NORFOLD_REUSE_LOG.md`.
