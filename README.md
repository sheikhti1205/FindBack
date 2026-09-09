# FindBack

FindBack is a minimal **lost & found reporting and recovery app** for the
Mobile App Development Lab (University of Chittagong). It is delivered as an
Android APK (Capacitor) with a local Node/TS + SQLite API and a monorepo layout.

## Requirements coverage (24 teacher requirements)

See `docs/REQUIREMENTS_MATRIX.md` for the full traceability matrix and
`docs/DEMO_CHECKLIST.md` for the teacher-demo walkthrough.

## Stack

| Area | Choice |
|---|---|
| Mobile UI | React + TypeScript + Vite + Tailwind CSS + Framer Motion |
| Android packaging | Capacitor → Gradle debug APK |
| API | Node/TS — Express (REST) + GraphQL-Yoga + Socket.IO |
| Database | SQLite via built-in `node:sqlite` (local provider) |
| Auth | JWT (local provider) |
| Storage | local uploads dir (cloud adapter swappable) |
| AI | OpenAI-compatible HTTP provider + deterministic fallback |
| ML | On-device TensorFlow.js category suggestion |
| CI | GitHub Actions |

## Repo layout

```
apps/mobile      React + Vite + Tailwind + Framer Motion + Capacitor
services/api     local provider: REST + GraphQL + Socket.IO + SQLite
packages/shared  shared Zod schemas, types, constants
docs/            requirements matrix, ERD, reporting, demo checklist
```

## Quick start

```bash
npm install

# API (SQLite file in services/api/data; auto-seeds demo data)
npm run dev:api                # http://localhost:4000  (GraphQL: /graphql)

# Mobile web dev (talks to the API at localhost:4000)
npm run dev:mobile

# Tests / checks / build
npm test
npm run typecheck
npm run lint
npm run build

# Android APK (after Phase 7 wiring)
npm run apk   # → apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Demo login (seeded): any of `rafi_cu`, `nusrat`, `tanvir_ce`, `shimu`, … with
password `password123`.

## Demo/dev credentials & provider mode

All external providers are intentionally deferred (`docs/DEFERRED_DECISIONS.md`).
The API runs fully in a local demo mode: verification codes are returned by the
server (`devCode`) instead of SMS/email; uploads are stored on disk; the AI Help
Assistant answers from a deterministic fallback until `LLM_*` env vars are set.
No secrets are committed; copy `.env.example` → `.env` and never commit `.env`.

## License / provenance

All code is original. Third-party packages are listed in `THIRD_PARTY_SOURCES.md`;
open-source reference research is in `docs/OPEN_SOURCE_RESEARCH.md`; Norfold reuse
notes are in `NORFOLD_REUSE_LOG.md`.
