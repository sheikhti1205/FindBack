# FindBack commit-message convention (prospective)

Applies to **new commits only** — enforced by
`scripts/check-commit-messages.mjs` over the PR/push commit range in CI and
over the release range in `release.yml`. History is never retroactively
failed: the checker only inspects the commits it is explicitly given.

## Subject shape: `scope: outcome`

- `scope` is lower-case (`[a-z0-9][a-z0-9-]*`). Canonical scopes include
  `release`, `build`, `ai`, `android`, `fix`, `docs`, `test`, `refactor`.
  Other lower-case scopes are accepted; upper-case scopes are rejected.
- One space after the colon, then the outcome: what changed for the repo,
  starting lower-case, no trailing period, max 72 characters total.
- Good: `fix: reject placeholder Supabase key in release preflight`
- Bad: `Fix: ...` (upper-case scope), `fix ...` (no colon), 90-char subjects.

## Never in the subject

- Wave/stage labels (`wave 2`, `Wave-N`, `phase 3`, ...). The outcome, not
  the work plan, is what ships.
- Worker/model/agent names (`opencode`, `sonnet`, `opus`, `haiku`, `gpt`,
  `gemini`, `copilot`, ...). No session internals in permanent history.
- Test counts (`12 tests`, `5 cases`, ...). Counts rot; the body records gates.

## Body records gates

Every non-trivial commit body names the gates that were run or observed, e.g.
`typecheck`, `lint`, `test`, `gate`, `verify`, `ci`, `e2e`, `qa`, `tsc`,
`eslint`, `vitest`. One line is enough:

```
fix: reject placeholder Supabase key in release preflight

Gates: typecheck, lint, node --test scripts/check-release-config
```

`docs`-scoped commits are exempt from the body-gate rule.

## Graceful skips (always pass)

- Merge commits (`Merge ...`), revert commits (`Revert ...`), and generated
  dependency bumps (`Bump ...`, `chore(deps)...`) pass without further checks.

## Local usage

```sh
node scripts/check-commit-messages.mjs --count 1            # just HEAD
node scripts/check-commit-messages.mjs --range origin/main...HEAD
node scripts/check-commit-messages.mjs --rev v0.1.0-beta.1  # single commit/tag
git log --format='%H' -5 | node scripts/check-commit-messages.mjs --stdin
```
