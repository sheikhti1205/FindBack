# FindBack

FindBack is a minimal **lost & found reporting and recovery app** for the
Mobile App Development Lab (University of Chittagong). It is delivered as an
Android APK (Capacitor) that talks **directly to hosted Supabase** (Auth,
PostgreSQL Data API/REST, GraphQL, Realtime, Storage, Edge Functions); SQLite is
only the Node reference/demo test backend. Monorepo layout below.

## Requirements coverage (24 teacher requirements)

See `docs/REQUIREMENTS_MATRIX.md` for the full traceability matrix and
`docs/DEMO_CHECKLIST.md` for the teacher-demo walkthrough.

**Current completion status (reconciled 2026-10-06, closure-review wave + deletion build): release READY
for the v8 beta line** (owner beta waivers 2026-10-06 for device/live-bound items). Implementation and verification are separate in the matrix.
Shipped and reviewed since the audit baseline: photo-grounding UI with
consent-gated selection, account-bound photo sends, mode-honest consent copy,
assistant-mode reconciliation, phone-verification flow with CI-executed SQL,
matching regression fixtures, SEN-01 build-boundary automation, route/map QA
hardening, schema-version parity, and password recovery. OpenRouter alone is
marked live-tested in the provider UI; other BYOK adapters are experimental
until actual-send proof. Remaining open work is the external acceptance set:
physical Gate-E, live SMS delivery, signed App Links/FCM delivery/direct reply,
release telemetry, genuine Crystal `.rpt` (licensed tooling or explicit
evaluator substitute acceptance), and the final signed release. See [all
findings](docs/COMPLETION_AUDIT.md) (state cells agree with the ledger),
the [current verification/closure report](docs/FINAL_ACCEPTANCE_REPORT.md),
and the machine source of truth [`completion-ledger.json`](completion-ledger.json)
(`generatedFor` names the exact reconciliation commit; the completion gate
binds it to HEAD). No green wave/AI gate is a whole-app completion
certificate. Historical acceptance is archived under `docs/history/`, not
reused as current proof.

## Stack

| Area | Choice |
|---|---|
| Mobile UI | React + TypeScript + Vite + Tailwind CSS + Framer Motion |
| Android packaging | Capacitor → Gradle debug APK |
| API | Hosted Supabase: PostgREST/Data API (REST) + `pg_graphql` (GraphQL); the Node/TS Express + GraphQL-Yoga + Socket.IO server is retained as a Docker/coursework reference |
| Database | Supabase PostgreSQL (Data API) in production; SQLite `node:sqlite` for tests/local |
| Auth | Supabase Auth (email OTP via custom SMTP, phone OTP for number changes, password recovery via verified deep link) in production; local JWT for tests/local |
| Storage | Supabase Storage (public `findback-images` bucket) — the app normalizes images on-device and uploads directly under its own `<uid>/` folder (owner-scoped RLS); local uploads dir for tests/local |
| AI | Report-photo automatic analysis: SmolVLM2 local-first with consented OpenRouter fallback (`openrouter/free`); on-device-only never sends, cloud-only skips local. Help: direct BYOK and installed specialized Needle/SmolVLM2 where wired, built-in fallback. Shared app-owned manager/orchestrator, explicit checksum-verified downloads. No server relay or silent paid route. Only OpenRouter marked live-tested; other BYOK adapters experimental pending actual sends. |
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
server-secret workflow. Actual notification delivery, shade direct reply and
release-signed device-level App Links proof remain pending for the exact final
candidate (zero-work dispatch success is not delivery); see
[`docs/runbooks/SHARING_AND_PUSH_INFRASTRUCTURE.md`](docs/runbooks/SHARING_AND_PUSH_INFRASTRUCTURE.md).

**AI (optional; verification incomplete):** Help chat is cloud (OpenRouter's `openrouter/free` default,
user's connected provider directly) plus installed Needle/SmolVLM2 where wired;
the create-report photo assistant is consented SmolVLM2 on-device default with
OpenRouter cloud fallback bound to the requesting account (fail-closed on
account switch). Keys stay on the device, paid routes require explicit
consent, and no FindBack server relays inference. Without a cloud connection or
a selected compatible offline model, Help uses built-in answers where the chosen
mode permits. Photo grounding selection, account-bound sends, assistant modes,
phone verification (code seam; live SMS needs approved hosted provider
configuration and receipt) and password recovery are shipped and reviewed;
device acceptance remains external.

On Android, **Settings → AI & models → On-device AI** (`/settings/ai/models`) starts explicit pinned downloads for
Needle (structured item-detail extraction / matching challenger) and SmolVLM2-500M
(approved image descriptions). Download progress, Pause, Resume, checksum verify,
install and Remove use the app-owned native storage driver. Startup rehashes
existing installs, without downloading or measuring automatically. Installed
 models appear in the Help picker and need no provider key; they are specialized
 tasks, not a general offline support chatbot. The web build fails closed for
 offline inference. The create-report **Analyze photo** flow is consented
 SmolVLM2 local-first (on-device default) with OpenRouter cloud fallback.

Possible Matches uses USE on-device embeddings by default (top-3 cosine, never a
probability). On-device AI (**Settings → AI & models → On-device AI**) can explicitly select installed Needle for this
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
Storage — used directly by the app, plus local-first photo AI and optional direct
BYOK cloud legs with the user's own key. OpenRouter is the only baseline
live-tested provider; other adapters remain experimental. The Node Express API
(`services/api`, `DB_PROVIDER=supabase|sqlite`)
remains as a Docker/coursework reference and for the local demo mode:
verification codes are returned by the server (`devCode`) instead of SMS,
uploads are stored on local disk, and the reference server's AI Help answers
from a deterministic fallback until `LLM_*` env vars are set (the mobile app
does not use this path). No secrets are committed; copy `.env.example` → `.env`
and never commit `.env`.

## Docs

- `docs/REQUIREMENTS_MATRIX.md` — 24 teacher requirements → implementation
- `docs/DEMO_CHECKLIST.md` — teacher walkthrough
- `docs/COMPLETION_AUDIT.md` — all 36 FBA findings, evidence boundaries and blockers
- `docs/FINAL_ACCEPTANCE_REPORT.md` — current READY (v8 beta) / verification and closure report
- `docs/history/` — dated historical acceptance, not current certification
- `docs/erd/ERD.md` + `docs/erd/ERD.pdf` — schema & entity relationship diagram
- `docs/reporting/REPORTING.md` — reporting API, report queries, Crystal import
- `DEFERRED_DECISIONS.md` — provider decisions & their swap points
- `docs/OPEN_SOURCE_RESEARCH.md` — licensing research for reference repos

## License / provenance

All code is original. Third-party packages are listed in `THIRD_PARTY_SOURCES.md`;
open-source reference research is in `docs/OPEN_SOURCE_RESEARCH.md`; Norfold reuse
notes are in `NORFOLD_REUSE_LOG.md`.
