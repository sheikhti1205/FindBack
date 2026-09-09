# FindBack — Implementation Plan

FindBack is a minimal Android **Lost & Found reporting and recovery app** built to
satisfy 24 mandatory teacher requirements for the Mobile App Development Lab
(University of Chittagong). This plan follows the DEEPSEEK_SUPER_PROMPT phases.

## Decisions (provisional, reversible — tracked in DEFERRED_DECISIONS.md)
- **Course-compliant stack**: React + TypeScript + Vite + Tailwind CSS + Framer
  Motion, packaged as an Android APK with Capacitor. Keeps the mandatory
  Tailwind/Framer/Vite/modern-frontend requirements while delivering an APK.
- **Local/demo providers** now, swappable later: Node/TS API (Express REST +
  GraphQL-Yoga + Socket.IO) on built-in `node:sqlite`. Auth via JWT; verification
  via dev adapter; local file storage; deterministic AI fallback.

## Phase plan
- **P0 Research/inventory** — supplied files read; Norfold inspected for reuse;
  reference-repo licenses verified; repo initialized. DONE in pass 1.
- **P1 Scaffold** — monorepo: `apps/mobile`, `services/api`, `packages/shared`;
  theme tokens (Material 3 Expressive, monochrome); routing; API service; shared types.
- **P2 Core domain** — schema + seed; auth interfaces/local auth; register/login;
  live username check; email/phone verification UI+state; feed; create post; details.
- **P3 Mandatory interactions** — realtime comments; like/dislike; ratings;
  pagination; search/filter; datepicker.
- **P4 Integrations** — map; file/image upload; YouTube embed; on-device ML
  (TensorFlow.js category suggestion); AI Help Assistant (generic provider +
  deterministic fallback).
- **P5 APIs** — REST + GraphQL + JWT/session + authorization.
- **P6 Reporting/devops** — ERD (source + SVG + PDF); Crystal data-source/query/setup
  docs; Docker; GitHub Actions; requirements matrix; demo checklist.
- **P7 QA/APK** — tests, accessibility/loading/empty states, web build, `cap sync
  android`, Gradle `assembleDebug`, verify APK.
- **P8 Archive** — delivery ZIP + handoff docs.

## Traceability
24 teacher requirements map 1:1 into `docs/REQUIREMENTS_MATRIX.md`. Statuses:
DONE / DONE_DEMO_PROVIDER / DEFERRED_EXTERNAL_PROVIDER /
DEFERRED_EXTERNAL_TOOL / TODO. Goal: zero TODO at end; only externally-tool items
(Crystal `.rpt`, real SMS/email, cloud, LLM key) stay deferred with exact wiring docs.
