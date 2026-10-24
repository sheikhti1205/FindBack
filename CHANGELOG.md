# Changelog

All notable changes to FindBack are documented here.

## [2.0.0-beta.1] (r0697–r0854)

### Added
- R3 private chat foundation (REQUEST/CONNECTED/BLOCKED/ENDED state machine)
- CF-050 owner-confirmed matching (report_matches table, propose/confirm/cancel RPCs)
- Appeals resolver (staff-only resolve_appeal RPC)
- Permission-first default/open opt-in for chat
- Multiple text-only request-stage messages
- Quiet content-free initial nudge

### Changed
- Chat history retained on End (CONNECTED → REQUEST)
- Author-only unsend tombstones
- Wall-clock time for sanction/day decisions (clock_timestamp)

### Security
- F1: Visibility revalidated after lock waits
- F2: Reply author standing enforced (service token bypass fixed)
- F3: Transaction-start time replaced with wall-clock time

## [1.0.0] (r0532–r0696)

### Added
- Stable release line
- Auth-recovery with verified password recovery and server sync
- Sentry release parity gate

## [0.9.0-beta.1] (r0486–r0531)

### Added
- Assistant landing page
- Neutral palette
- Security closure wave

## [0.8.0-beta.2] (r0470–r0485)

### Added
- Single-line main-only v8 beta
- Immutable branch rule

## [0.7.0-beta.2] (r0448–r0469)

### Added
- Phone verification flow
- Password recovery

## [0.7.0-beta.1] (r0444–r0447)

### Added
- Release preparation

## [0.6.0-beta.1] (r0434–r0443)

### Added
- On-device SmolVLM2 default photo engine
- AI wiring fixes

## [0.5.0-beta.1] (r0430–r0433)

### Added
- Release preparation

## [0.4.0-beta.2] (r0405–r0429)

### Added
- Pinned NDK for release builds
- Per-ABI native set verification

## [0.4.0-beta.1] (r0404)

### Added
- Version cut

## [0.3.0-beta.1] (r0363–r0403)

### Added
- Release preparation
- Device waiver documentation

## [0.2.0-beta.3] (r0340–r0362)

### Added
- Report redesign (Home action tiles, owner status cards)
- Interaction gap fixes

## [0.2.0-beta.2] (r0337–r0339)

### Added
- Beta.2 UX release gaps closed

## [0.2.0-beta.1] (r0325–r0336)

### Added
- AI capability copy reconciliation
- Aria-busy on pending home love toggle

## [0.1.0-beta.1] (r0190–r0324)

### Added
- Signed beta pipeline
- Manual backend deploy
- Supabase Auth cutover
- Direct Supabase data reads/writes
- Realtime subscriptions
- Direct Storage uploads
- AI Help Edge Function
- Supabase-only mobile runtime
- Rich text editor
- VLM scaffolding and model management
- Feed, search, location, matches
- Markdown rendering
- Accessibility improvements

## [0.1.0] (r0001–r0189)

### Added
- Monorepo scaffold
- Mobile feature screens and routing
- Activity reporting endpoint
- Android/Capacitor platform
- PostgreSQL/Supabase database adapter
- RLS on all public tables
- Supabase Data API store
- Feed and reporting RPCs
- Auth provider abstraction
- Supabase Auth sessions
- Storage uploads
- Realtime cutover
path: /home/sheikh/GitHub/FindBack/CHANGELOG.md