# Development guide

FindBack is a monorepo with a React/Capacitor client, a Node API, a shared package and
a Supabase backend. This page is the practical setup and check reference; the design is
in [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

- Node.js 22 and npm
- A Supabase project (or the local Supabase CLI stack) for anything that touches the
  backend
- For Android builds: JDK 21, Android SDK with the pinned NDK, and a signed release
  keystore only when producing release artifacts

## Setup

```bash
git clone https://github.com/sheikhti1205/FindBack.git
cd FindBack
npm install
```

`npm install` builds `packages/shared` through the `prepare` script.

Copy `.env.example` to `.env` and fill in your own values. `.env` files are ignored;
`.env.example` files must contain names only, never values.

## Run

```bash
npm run dev:mobile   # client dev server (web shell)
npm run dev:api      # local Node API
```

The Android app is the same web build wrapped by Capacitor. `npm run apk` builds a
signed release; it requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
to be present and non-empty, and it refuses to build a bundle with a missing URL.
Never use a `sb_secret_*` or service-role key in a client build.

## Checks

```bash
npm run typecheck    # shared build + API and mobile typecheck
npm run lint         # eslint over the repo
npm test             # shared build + API tests + mobile tests
npm run scan:secrets # repository secret scan
```

Additional gates used in CI and before a release:

```bash
node scripts/completion-gate.mjs         # ledger integrity + debt/skip policy
node scripts/check-security-baseline.mjs # dependency CVE tripwire
node scripts/check-map-provider.mjs      # keyless map provider policy
node scripts/check-version-sync.mjs      # root and mobile versions agree
node --test scripts/*.test.mjs           # release-infra and config script tests
```

SQL behaviour suites need a real PostgreSQL instance; CI provides one. See
`supabase/tests/` and `scripts/sql-behavior.mjs`.

## Repository layout

```
apps/mobile/          React + Capacitor client (Android primary)
services/api/         Node/Express + GraphQL API
packages/shared/      shared schemas, validation, constants
supabase/migrations/  applied SQL migrations (immutable once applied)
supabase/functions/   Deno Edge Functions
scripts/              build, verification and release tooling
docs/                 product, architecture, history and acceptance docs
```

## Database changes

- Add a new timestamped migration; never edit an applied one.
- Applied migration bytes are part of the release record and are verified against the
  hosted migration head.
- A migration-bearing change stays local until its gates pass, then is pushed and
  immediately read back from the live project.

## Tests

- Mobile and shared code: Vitest, colocated `*.test.ts(x)` files.
- API: Vitest under `services/api`.
- SQL behaviour: real PostgreSQL probes in `supabase/tests/`.
- Edge Functions: Deno tests under `supabase/functions/**`.

Device-only checks (camera, push, TalkBack, IME, real two-device chat) cannot run in
CI; they are tracked as external gates and are never claimed from a host test.

## Documentation

- Product/status: [README](../README.md), [ROADMAP](../ROADMAP.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Version history: [history/VERSION_HISTORY.md](history/VERSION_HISTORY.md)
- Course-era material: [course/](course/)
