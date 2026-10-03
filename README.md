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
| AI | Optional direct BYOK cloud providers (default `openrouter/free`), plus explicit Android downloads for Needle structured text and SmolVLM2 image descriptions via LiteRT-LM. Shared app-owned manager/orchestrator; verified installs only. No server relay or automatic paid/cloud fallback. |
| ML | USE on-device embeddings default for Possible Matches; explicitly selected installed Needle challenger for this session. CPU default; measured GPU vision selection only with fresh correctness evidence, CPU language decoder on both arms. Device performance remains unmeasured. |
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
Storage (on-device-normalized image uploads) — plus user-selected BYOK providers for the optional
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

**AI (optional):** Cloud Help and consented create-report photo suggestions use
the user's connected provider directly; OpenRouter's `openrouter/free` is the
default. Keys stay on the device, paid routes require explicit consent, and no
FindBack server relays inference. Without a cloud connection or a selected
compatible offline model, Help uses built-in answers.

On Android, **Profile → AI & Models** starts explicit pinned downloads for
Needle (structured item-detail extraction / matching challenger) and SmolVLM2-500M
(approved image descriptions). Download progress, Pause, Resume, checksum verify,
install and Remove use the app-owned native storage driver. Startup rehashes
existing installs, without downloading or measuring automatically. Installed
models appear in the Help picker and need no provider key; they are specialized
tasks, not a general offline support chatbot. The web build fails closed for
offline inference. The create-report **Analyze photo** flow remains consented
cloud analysis.

Possible Matches uses USE on-device embeddings by default (top-3 cosine, never a
probability). AI & Models can explicitly select installed Needle for this
session. Smol uses CPU by default; **Measure CPU / Measure GPU** runs two pinned
color fixtures with correctness checks and real LiteRT TTFT/tokens-per-second
counters. Only the vision backend differs; the language decoder is CPU on both
arms. Fresh correctness-passing records can select a backend for this session;
GPU initialization failure announces an explicit CPU retry. Hardware discovery
does not prove accelerated inference. **Civi 3 acceptance and all physical-device
performance claims remain `DEVICE_REQUIRED / NOT EXECUTED`.** See the
[current device runbook](docs/runbooks/gate-e-device-run.md). LFM/llama.cpp remain
lab-only, excluded from product downloads and routing.

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
