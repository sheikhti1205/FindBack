# FindBack — Agent Rules (always loaded)

## IMMUTABLE RULE: main branch ONLY — never create another branch (owner order 2026-10-06)

- All work happens on `main`, committed and pushed directly. No feature branches, no release branches, no side branches — for any reason, no exceptions.
- Never run `git checkout -b`, `git switch -c`, or any command that creates a branch. If a workflow seems to need a branch, STOP and do it on `main` instead.
- This rule is permanent, survives compaction, and overrides any skill, playbook, or past pattern that suggests branching (including the deleted `release/0.8.0-beta.1` approach — the v8 beta ships single-line from `main`).
- Pre-existing stale branches (`phase2/*`, `plan/*`, `archive/*`) are left untouched; just never add new ones.

## Hard rules

1. **No secrets.** Never commit API keys, tokens, passwords, or credentials.
2. **FindBack server URL is mandatory on every build.** Any web build, APK build, or device-bound artifact REQUIRES `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (publishable key only) present and non-empty pre-build, plus post-build proof via `scripts/check-release-config.mjs`. Missing URL = build failure, not a warning.
3. **Evidence before claims.** No completion claims without fresh verification.
