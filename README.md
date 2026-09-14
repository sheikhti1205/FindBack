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
| AI | Supabase Edge Function `ai-help` (authenticated) → OpenAI-compatible HTTP provider when secrets are set, deterministic fallback otherwise |
| ML | MobileNet V1 (TensorFlow.js) bundled locally; on-device inference with no external network requests |
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

# Android APK (from repo root) — public Supabase values only, no API URL
VITE_SUPABASE_URL=https://<ref>.supabase.co \
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
npm run apk
# → apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Mobile builds read two public, bundle-safe Supabase values: `VITE_SUPABASE_URL`
and `VITE_SUPABASE_PUBLISHABLE_KEY` (publishable key only; the secret key is never
bundled). The app talks **only** to hosted Supabase — Auth, the Data API (feed,
posts, comments, reactions, ratings), Realtime (private broadcast channels),
Storage (on-device-normalized image uploads) and the `ai-help` Edge Function. The
Node Express API remains in the repo as a Docker/coursework reference but is not
part of the mobile runtime. Post and comment payloads expose a public author
profile only — never email or phone.

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

The real production stack is hosted Supabase — Auth, the Data API, Realtime,
Storage and the `ai-help` Edge Function — used directly by the app. The Node
Express API (`services/api`, `DB_PROVIDER=supabase|sqlite`) remains as a
Docker/coursework reference and for the local demo mode: verification codes are
returned by the server (`devCode`) instead of SMS, uploads are stored on local
disk, and the AI Help Assistant answers from a deterministic fallback until
`LLM_*` env vars are set. No secrets are committed; copy `.env.example` → `.env`
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
