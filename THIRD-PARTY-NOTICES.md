# Third-party notices

FindBack is built on open-source software. This file is the short, public notice
list; the detailed, version-pinned inventory (including model assets, provenance and
recorded digests) is in [THIRD_PARTY_SOURCES.md](THIRD_PARTY_SOURCES.md).

## Application and web runtime

React, React DOM, React Router, React Aria Components, Vite, Tailwind CSS, Framer
Motion, TipTap (core, react, starter-kit), lucide-react, react-markdown, remark-gfm,
remark-breaks, rehype-sanitize, Zod — MIT.

## Mobile / native

Capacitor and its official plugins (android, app, app-launcher, browser, camera,
core, geolocation, push-notifications, share) — MIT. Sentry Capacitor/React — MIT.
AndroidX ExifInterface — Apache-2.0.

## Backend

Express, cors, multer, dotenv — MIT. GraphQL, graphql-yoga — MIT. Socket.IO — MIT.
jsonwebtoken — MIT. bcryptjs — MIT. Supabase JS and `@supabase/server` — MIT.
sharp — Apache-2.0. Deno / Supabase Edge Functions runtime — MIT.

## On-device AI

LiteRT-LM, LiteRT core and GPU delegate, MediaPipe Tasks Text — Apache-2.0.
SmolVLM2-500M (LiteRT) and SmolVLM-256M (TFLite, diagnostic/storage compatibility
only) — Apache-2.0. Universal Sentence Encoder (MediaPipe TextEmbedder asset) —
Apache-2.0.

Model weight files are **not** committed to this repository; they are downloaded
and verified against pinned digests at build or first run.

## Development and CI

GitHub Actions, Playwright, Vitest, ESLint, TypeScript, esbuild — MIT or
Apache-2.0 as published by their maintainers.

## What this file does not do

It does not replace the license text of any dependency, and it does not grant any
right to the FindBack name or branding (see [BRANDING.md](BRANDING.md)). If you
redistribute a build, keep the notices of the dependencies you ship.
