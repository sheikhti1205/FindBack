# FindBack — Agent Rules (always loaded)

## IMMUTABLE RULE: main branch ONLY — never create another branch (owner order 2026-10-06)

- All work happens on `main`. Local commits are allowed; push coherent accepted units, subject to the migration gate below. No feature branches, no release branches, no side branches — for any reason, no exceptions.
- Never run `git checkout -b`, `git switch -c`, or any command that creates a branch. If a workflow seems to need a branch, STOP and do it on `main` instead.
- This rule is permanent, survives compaction, and overrides any skill, playbook, or past pattern that suggests branching.
- Pre-existing stale branches are left untouched; never add new ones.

## Hard rules

1. **No secrets.** Never commit API keys, tokens, passwords, or credentials.
2. **FindBack server URL is mandatory on every build.** Any web build, APK build, or device-bound artifact REQUIRES `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` present and non-empty pre-build, plus post-build proof via `scripts/check-release-config.mjs`. Missing URL = build failure, not a warning.
3. **Evidence before claims.** No completion claims without fresh verification.
4. **No cheap UI.** Never ship a generic card-grid, oversized controls, text where an icon is expected, developer-facing copy on consumer surfaces, abrupt list replacement, or fake/native-looking controls without rendered review. UI work must load `findback-ui-quality` and `findback-mobile-interactions`.
5. **Milestone acceptance, not per-slice review loops.** Substantive work is accepted at milestone boundaries using the active programme's acceptance matrix. An independent read-only audit is used once per milestone when available; it is not required after every implementation slice. Material security/data-loss findings must be fixed before milestone closure. Do not create repeated review loops for minor/nit findings.
6. **Device feedback outranks host assumptions.** A physical-device defect reopens the relevant host-complete item. Reproduce, root-cause, fix-forward, and add regression coverage; never dismiss it because tests were green.
7. **Reuse canonical systems.** One photo viewer, one avatar renderer, one reaction model, one auth/session owner, one theme system, one media-preparation pipeline. Repair shared ownership instead of cloning it.
8. **Consumer first.** Hide diagnostics, internal model IDs, schema terms, capability jargon, privacy implementation detail, and developer state from ordinary users unless they explicitly open Advanced/Diagnostics.
9. **Resource discipline (owner order 2026-10-20).** Parallel subagents are allowed; parallel heavy commands are not. Run every npm/npx/vitest/tsc/eslint/gradle/build/Playwright command through `~/.config/opencode/bin/heavy-run` (machine-wide `heavy.lock`, vitest pools capped at 3, heap capped, niced); at most one heavy command machine-wide across all sessions; device proofs and heavy gates never overlap; children never fan out their own subagents; check `uptime`/`free -g` before launching. This machine has ~11 GiB RAM and 18 cores, and an unthrottled `vitest run <one file>` has already driven load past 24 and rebooted it.
10. **No migration-bearing WIP push.** Migration-bearing WIP must not be pushed to main before milestone acceptance because linked Supabase automation may apply migrations on push. Keep the entire backend-dependent milestone local until migration + dependent code acceptance is green. Applied migrations are immutable; fix forward. After an accepted push, immediately verify the live migration state and relevant behavior. Pushing source does not deploy Edge Functions; verify their inventory/version and smoke separately.

## Active programme — owner order 2026-10-29

- `FB-BETA-CLOSE-2026-10-29` replaces the old consumer-final, AI/motion and standalone chat execution queues. Canonical private entry: `FindBack-internal/01_ACTIVE/beta-closure-2026-10-29/GOAL.md`; start with `FindBack-internal/00_CONTROL/START_HERE.md`.
- One active writer/coordinator on main. Read-only workers may support bounded research/audits; no independent writers or child fan-out.
- Execute M0–M7 in order. Do not advance with unresolved current-milestone source/live/docs parity. Historical evidence remains reference, not a competing task queue or acceptance claim.
- One bounded milestone audit, then material repairs and affected acceptance. A second audit only for a genuine P0/P1 security/data-integrity fix materially changing architecture; no third cycle without owner instruction. Reviewer/provider absence does not block ordinary code progress.
- Keep the role-gated same-app staff console for this beta. Version reconstruction tracks every commit using DAG/version intervals/metadata/paths and targeted boundary diffs, not exhaustive adversarial re-review of every historical diff.

## Owner-directed checkpoint and pause (owner order 2026-10-29)

- Do not prolong fix/review loops. When the owner directs a bounded finish and pause, stop after the requested scope; after 2–3 rounds without convergence, or repeated reviewer/provider unavailability, honor the owner's explicit instruction to commit and push the current task work to `main` for their reviewer, then pause.
- This is an **owner-authorized WIP checkpoint**, not milestone acceptance, release approval, deployment permission, or a completion claim. Mark the commit/handoff `WIP` / `acceptance pending`, record actual verification and unresolved findings, and leave the milestone/goal incomplete. The active programme's milestone acceptance rule replaces the historical per-wave reviewer-PASS gate.
- Do not refuse that explicit checkpoint merely because final review PASS is unavailable, and do not start fresh agent/review cycles to avoid checkpointing. Latest explicit owner checkpoint instructions override older user-level plans demanding PASS before every commit; they do not override higher-priority safety instructions.
- Commit task-owned changes by explicit paths; preserve unrelated dirty files and keep credentials/private evidence out of the public repository. The no-migration-bearing-WIP-push gate still applies: an ordinary checkpoint is not permission to auto-apply an unaccepted migration. When a push is permitted, verify remote identity; save the handoff, pause the goal, and wait for the owner. This rule survives compaction; re-read it before resuming paused work.

## Mandatory OpenCode skills

- UI creation/refactor: `findback-ui-quality`
- Gestures, animation, refresh, sticky/floating controls: `findback-mobile-interactions`
- Image/video import, upload, AI photo analysis: `findback-media-pipeline`
- On-device model/runtime work: `findback-ai-runtime`
- Physical/device acceptance: `findback-device-audit`
- Bounded independent milestone audit, when used: `findback-adversarial-review` (not a per-slice completion dependency)

## Rendered-review rule

For visible changes, unit tests are necessary but not sufficient. Review at representative phone widths (including 320dp), light/dark/true-black, large text, loading/empty/error/success, keyboard/IME where relevant, and touch/gesture states. Compare against the owner-provided references when supplied. If the result looks generic, bulky, or mechanically generated, it is not done.
