# Phase 9 — Release Hardening and Human/Agent Handoff

This phase starts after the Phase 8 checkpoint. The codebase already has all 24 teacher requirements represented, a passing web/API CI run, and a locally built debug APK. Phase 9 turns that implementation checkpoint into a reliable teacher-demo/release candidate.

## What the agent can complete autonomously

- Keep lint, typecheck, API tests, mobile tests, and web build green.
- Build the Android debug APK **locally** with `npm run apk` (GitHub Actions does not build the app).
- Audit the Android manifest, SDK targets, Capacitor configuration, runtime permissions, network-security assumptions, and package metadata.
- Add or improve automated tests for the required feature paths.
- Harden local/demo provider abstractions without choosing a production provider.
- Keep `docs/REQUIREMENTS_MATRIX.md` and `docs/DEMO_CHECKLIST.md` synchronized with actual implementation.
- Prepare Crystal Reports data exports, SQL/query documentation, and sample datasets.
- Prepare release/demo documentation, screenshots, and a reproducible build path.

## Human decisions / actions that should remain gated

1. **Backend/cloud provider** — choose Supabase, Firebase, or another production backend.
2. **Email/phone verification provider** — requires external accounts, credentials, quotas, and possibly billing.
3. **Cloud object storage** — requires a provider account/project and bucket/security-policy decisions.
4. **LLM provider** — optional because the deterministic fallback already demonstrates the UI flow; a real provider requires an API key and cost/privacy decision.
5. **Google Maps production setup** — if a production Maps API key or billing-backed API is required, the owner must configure it. The current embedded-map path remains usable for the minimum course requirement.
6. **Crystal Reports `.rpt` file** — must be created/tested in SAP Crystal Reports on a compatible Windows machine with the required tooling.
7. **Final Android application ID and signing key** — the owner must choose the final package identity and securely create/store the release keystore.
8. **Physical-device acceptance test** — install the APK on at least one real Android phone and perform the teacher demo end-to-end.
9. **Production deployment URL** — choose hosting and configure DNS/HTTPS/environment variables if internet-hosted demonstration is desired.

## Release candidate acceptance checklist

### Automated gate
- [ ] Shared package builds.
- [ ] Typecheck passes.
- [ ] Lint passes.
- [ ] API tests pass.
- [ ] Mobile tests pass.
- [ ] Mobile production bundle builds.
- [ ] Android debug APK builds locally (`npm run apk`).

### Android/device gate
- [ ] Install APK on Android 14/15/16-capable device or emulator.
- [ ] Launch from a cold start without crash.
- [ ] Registration/login works against the selected demo backend.
- [ ] Username availability check updates without page reload.
- [ ] Verification flow works with the configured demo or production provider.
- [ ] Create lost/found report with image, date, dropdowns, and approximate location.
- [ ] On-device ML category suggestion executes on the device.
- [ ] Post appears in feed and pagination works.
- [ ] Two sessions demonstrate live comment, reaction count, and rating update.
- [ ] YouTube embed plays.
- [ ] Map embed/location display works.
- [ ] Minimal AI Help Assistant responds.
- [ ] Logout clears the authenticated session.

### Teacher-evidence gate
- [ ] ERD PDF opens and remains sharp when zoomed.
- [ ] GraphQL endpoint can be demonstrated.
- [ ] REST endpoint can be demonstrated.
- [ ] Git history is present.
- [ ] Tailwind and Framer Motion usage can be pointed out in code.
- [ ] Docker/CI workflow can be shown.
- [ ] Crystal Report or the final instructor-accepted reporting artifact is available.
- [ ] Requirement matrix accurately says which items use demo providers.

## Recommended division of labour

**Agent:** code, tests, CI, build scripts, provider interfaces, documentation, release checks, bug fixes.

**Human:** provider/account creation, API keys/secrets, billing decisions, release signing, Crystal Reports GUI work, Play Console/production deployment decisions, and physical-device UX acceptance.

Do not merge provider-specific production wiring merely to remove a `DEFERRED` label. A reversible demo adapter is preferable until the owner explicitly chooses the provider.
