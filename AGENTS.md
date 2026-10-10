# FindBack — Agent Rules (always loaded)

## IMMUTABLE RULE: main branch ONLY — never create another branch (owner order 2026-10-06)

- All work happens on `main`, committed and pushed directly. No feature branches, no release branches, no side branches — for any reason, no exceptions.
- Never run `git checkout -b`, `git switch -c`, or any command that creates a branch. If a workflow seems to need a branch, STOP and do it on `main` instead.
- This rule is permanent, survives compaction, and overrides any skill, playbook, or past pattern that suggests branching.
- Pre-existing stale branches are left untouched; never add new ones.

## Hard rules

1. **No secrets.** Never commit API keys, tokens, passwords, or credentials.
2. **FindBack server URL is mandatory on every build.** Any web build, APK build, or device-bound artifact REQUIRES `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` present and non-empty pre-build, plus post-build proof via `scripts/check-release-config.mjs`. Missing URL = build failure, not a warning.
3. **Evidence before claims.** No completion claims without fresh verification.
4. **No cheap UI.** Never ship a generic card-grid, oversized controls, text where an icon is expected, developer-facing copy on consumer surfaces, abrupt list replacement, or fake/native-looking controls without rendered review. UI work must load `findback-ui-quality` and `findback-mobile-interactions`.
5. **One implementer, one independent reviewer.** Every substantive wave must be reviewed by a different read-only subagent using `findback-adversarial-review`. Reviewer PASS is required before the coordinator calls the wave complete.
6. **Device feedback outranks host assumptions.** A physical-device defect reopens the relevant host-complete item. Reproduce, root-cause, fix-forward, and add regression coverage; never dismiss it because tests were green.
7. **Reuse canonical systems.** One photo viewer, one avatar renderer, one reaction model, one auth/session owner, one theme system, one media-preparation pipeline. Repair shared ownership instead of cloning it.
8. **Consumer first.** Hide diagnostics, internal model IDs, schema terms, capability jargon, privacy implementation detail, and developer state from ordinary users unless they explicitly open Advanced/Diagnostics.

## Mandatory OpenCode skills

- UI creation/refactor: `findback-ui-quality`
- Gestures, animation, refresh, sticky/floating controls: `findback-mobile-interactions`
- Image/video import, upload, AI photo analysis: `findback-media-pipeline`
- On-device model/runtime work: `findback-ai-runtime`
- Physical/device acceptance: `findback-device-audit`
- Every implementation handoff: `findback-adversarial-review`

## Rendered-review rule

For visible changes, unit tests are necessary but not sufficient. Review at representative phone widths (including 320dp), light/dark/true-black, large text, loading/empty/error/success, keyboard/IME where relevant, and touch/gesture states. Compare against the owner-provided references when supplied. If the result looks generic, bulky, or mechanically generated, it is not done.
