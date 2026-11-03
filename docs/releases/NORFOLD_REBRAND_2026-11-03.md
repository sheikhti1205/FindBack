# Norfold rebrand — 0.14.0-beta.1

**Date:** 2026-11-03
**Previous name:** FindBack
**Logo:** unchanged — the current owner-approved bird/leaf emblem.

This is a **name change**, not a new app, database or backend. The source version
moves to `0.14.0-beta.1` because the product identity changed; it is still beta.

## What changed

- Consumer name, app label, web metadata, auth/onboarding copy, help, legal,
  About, push and email copy, share-preview pages, accessibility labels and the
  current README now say **Norfold**.
- The accent option previously called **FindBack Blue** is now simply **Blue**.
  It is still the default accent, and the logo is still monochrome.
- Workspace packages moved from `@findback/*` to `@norfold/*`; the root
  workspace is `norfold`. This is internal packaging, not a backend contract.
- One canonical identity owner (`apps/mobile/src/brand.ts`) holds the product
  name, the legacy name and the current public origin, so a future domain move
  is a configuration change rather than a hunt for scattered literals.

## Current public address

The production site is still **https://findbackapp.social**. No Norfold domain
has been purchased, reserved or announced, and nothing in this change points at
an invented one. The address retires only after a real domain exists and a
controlled migration (DNS/TLS, OAuth origins and redirects, Supabase allowlist,
Android App Links, canonical URLs and redirects) is ready.

## Identifiers deliberately kept

These are compatibility contracts, not branding. Renaming them would break live
users, deployed functions or history:

- Android application id `com.findback.app` (installed-app updates, Google
  OAuth Android client, App Links, push registration)
- Supabase project/ref and database name
- every `findback_*` SQL function/RPC and table/view name
- applied migration filenames and content
- storage bucket names (`findback-images`, `findback-*-media`, …)
- generated brand asset filenames (`findback-birdleaf-v1-*`), because deployed
  pages and previously shared links reference them
- local preference keys (`findback.theme`, `findback.feedLayout.v1`) so existing
  users keep their theme and layout
- historical docs, commits and tags

## Verification

- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- Mobile test suite — see the CI run for the merge commit.
- Web build — the CI web job and the deployed site.
- Not claimed: a fresh physical-device install, a store listing change or a
  domain migration. None of those are part of a name rebrand.
