# Contributing

FindBack is a pre-public beta maintained by a single owner. Contributions are
welcome as issues and focused pull requests, but the project does not promise
review timelines, and large unsolicited changes are likely to be declined.

## Before you start

- Open an issue describing the problem or proposal, especially for anything that
  touches authentication, database policies, chat, media or moderation.
- Security problems go to **sheikhti1205@outlook.com**, never a public issue
  (see [SECURITY.md](SECURITY.md)).
- By contributing you agree your contribution is licensed under the project's
  [PolyForm Noncommercial License 1.0.0](LICENSE.md), and that the project may
  relicense it as part of a commercial license.

## Ground rules

- One change per pull request; no drive-by refactors mixed with a fix.
- Preserve the canonical owners: one photo viewer, one avatar renderer, one
  reaction model, one auth/session owner, one theme system, one media-preparation
  pipeline. Fix the shared owner instead of cloning it.
- Do not add features that the roadmap has not accepted, and do not advertise
  behaviour that is not implemented.
- Never commit secrets, tokens, private keys or real user data. `.env` files are
  ignored; `.env.example` files must contain names only, with empty values.

## Local checks

Run the checks that cover what you changed; the full list is in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). At minimum, before a pull request:

```bash
npm run typecheck
npm run lint
npm test
```

For UI changes, include a rendered screenshot at a representative phone width
(320 dp is the reference minimum) in light and dark themes.

## Commit messages

Short, imperative subject lines with a scope, for example
`fix(chat): keep unsent message hidden after restore`. Explain *why* in the body
when the reason is not obvious from the diff.

## Database changes

Migrations in `supabase/migrations/` are immutable once applied. Add a new
timestamped migration instead of editing an applied one. A migration that has been
applied to the hosted project is never rewritten.
