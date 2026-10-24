# FindBack CI Tiers — Fast vs Heavy

## Overview

FindBack uses a two-tier CI strategy to balance developer feedback speed with comprehensive validation.

## Fast CI (runs on every push/PR)

**Target:** < 2 minutes
**Trigger:** Every push to main, every PR

### Steps
1. **Lint** — ESLint on changed files only
2. **Typecheck** — TypeScript compilation (`tsc --noEmit`)
3. **Unit tests** — Vitest on changed test files only (`--changed`)
4. **Migration syntax check** — SQL lint on changed migration files
5. **Schema version check** — Verify BACKEND_SCHEMA_VERSION matches latest migration

### Commands
```bash
# Fast lint
npx eslint --max-warnings 0 $(git diff --name-only HEAD~1 -- '*.ts' '*.tsx')

# Fast typecheck
npx tsc --noEmit -p apps/mobile/tsconfig.json

# Fast tests (changed files only)
npx vitest run --changed --maxWorkers=2

# Migration syntax check
for f in $(git diff --name-only HEAD~1 -- 'supabase/migrations/*.sql'); do
  node scripts/check-migration-syntax.mjs "$f"
done

# Schema version check
node scripts/check-schema-version.mjs
```

## Heavy CI (runs on release tags / manual trigger)

**Target:** < 30 minutes
**Trigger:** Release tags (v*), manual workflow dispatch

### Steps
1. **Full test suite** — All unit + integration tests
2. **Migration verification** — Apply all migrations to fresh DB, verify
3. **Build verification** — Web build + APK build (with URL/publishable key precheck)
4. **Screenshot capture** — Rendered screenshots at representative widths
5. **Link validation** — Check all links in docs and README
6. **Security scan** — Dependabot, Snyk, or similar
7. **Performance audit** — Lighthouse CI

### Commands
```bash
# Full test suite
npx vitest run --maxWorkers=2

# Migration verification
node scripts/verify-migrations.mjs

# Build verification (requires VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY)
node scripts/check-release-config.mjs
npm run build -w apps/mobile
npm run apk -w apps/mobile

# Link validation
node scripts/check-links.mjs

# Screenshot capture
node scripts/capture-screenshots.mjs
```

## Resource Discipline

All heavy commands must run through `~/.config/opencode/bin/heavy-run` with machine-wide lock. At most one heavy command at a time. Vitest pools capped at 3 workers.

## CI Configuration Files

- `.github/workflows/ci-fast.yml` — Fast tier (every push/PR)
- `.github/workflows/ci-heavy.yml` — Heavy tier (release tags/manual)

## Migration from Current State

Current CI runs a single tier. To adopt fast-vs-heavy:
1. Split existing workflow into two files
2. Move full test suite to heavy tier
3. Add changed-file detection to fast tier
4. Add build verification to heavy tier
5. Add link validation to heavy tier

## Status

- **Fast tier:** Concept documented, not yet implemented as separate workflow
- **Heavy tier:** Concept documented, not yet implemented as separate workflow
- **Implementation:** Requires CI configuration changes (blocked by GitHub Actions access)