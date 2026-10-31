# Catalogue hardening handoff — 2026-10-08

## Scope and state

Implemented in the shared `/home/sheikh/GitHub/FindBack` worktree on `main`.
No branch, commit, push, reset, release, build or credential access was performed.
Read the supplied Assistant/Media/Model UX master plan. Did not edit
`Help.tsx`, `applicationAi.ts`, `ChatTranscript.tsx`, or other workers' files.
The pre-existing `automaticLocalModel`, `supportsAssistantMessage`, and their
explicit defaults in `uiModelRoles.ts` were preserved.

## Exact authored paths

- `apps/mobile/src/components/ModelCatalogSheet.tsx`
- `apps/mobile/src/components/ModelCatalogSheet.test.tsx`
- `apps/mobile/src/services/ai/providerContract.ts`
- `apps/mobile/src/services/ai/uiModelRoles.ts`
- `apps/mobile/src/services/ai/uiModelRoles.test.ts`
- `apps/mobile/src/services/ai/modelCatalog.ts`
- `apps/mobile/src/services/ai/modelCatalog.test.ts`
- `apps/mobile/src/services/ai/modelDescriptors.ts` — consumerDetail only
- `apps/mobile/src/services/ai/providers/catalogueQualification.ts` — new
- `apps/mobile/src/services/ai/providers/catalogueQualification.test.ts` — new
- `apps/mobile/src/services/ai/providers/openai.ts`
- `apps/mobile/src/services/ai/providers/openrouter.ts`
- `apps/mobile/src/services/ai/providers/deepseek.ts`
- `apps/mobile/src/services/ai/providers/mistral.ts`
- `apps/mobile/src/services/ai/providers/groq.ts`
- `apps/mobile/src/services/ai/providers/xai.ts`
- `apps/mobile/src/services/ai/providers/generic.ts`
- `apps/mobile/src/services/ai/providers/offline.ts`
- `apps/mobile/src/services/ai/providers/offline.test.ts`
- `docs/catalogue-hardening-handoff.md` — this handoff

Other paths in the shared git status belong to main/other workers, not this pass.

## Unified diff / contracts

- Add optional `ModelRecord.displayName` and `qualifiedRoles`; define
  `UiModelRole` in the provider contract and re-export it from uiModelRoles.
- Cloud catalogue roles now fail closed for absent, malformed or unknown roles.
  Text or image input does not establish conversation. Offline claims always
  come from the live production descriptor registry, ignoring cached claims.
- The legacy-named `isAssistantSelectableOfflineRecord` now requires explicit
  conversational qualification for cloud rows too. Consent, entitlement, and
  per-message compatibility are still independent gates.
- Cloud adapters populate qualification from bounded documented model families
  or Mistral's explicit `capabilities.completion_chat` flag. Vision/function
  calling alone cannot qualify Mistral for Chat. Generic compatible hosts never
  borrow official-provider qualification, even for a familiar model ID.
- Speech and embedding models carry their separate roles and are absent from
  Assistant sections. Unknown image/tools/guard/generator endpoints carry no
  conversational role. New undocumented family IDs remain unqualified pending
  review; this is intentionally not a universal catalogue allowlist.
- OpenRouter adapter and pure parser use the same qualification mapping.
  `fixedFallbackCatalog` returns explicitly unqualified rows: an ID alone is
  not endpoint qualification.
- Offline listModels now exports live registry roles and consumer names without
  invoking native inference. Needle3 is Tools + Embeddings; SmolVLM2 is Vision
  only. Artifact pins, runtime IDs, task roles, bytes and install behavior were
  not changed.
- Both catalogue variants use human names, with raw IDs under native collapsed
  `details` / `summary` Technical details. Unknown titles fall back to
  `Cloud model` / `On-device model`. Speech to text and Text to speech filters
  are separate library capability chips. Existing 48px targets and native
  disclosure semantics are retained.
- Pricing, price fingerprints, entitlements, credentials, inference request
  formats, and consent rules were not changed by this pass.

## Shared display-name resolver

Import from `services/ai/uiModelRoles`:

```ts
displayNameForCatalogRecord(
  record: Pick<ModelRecord, "id" | "provider" | "displayName">,
): string
```

It does not need I/O, pricing or qualification metadata. Local titles come from
descriptor consumerDetail (Needle consumerDetail is now Needle3). Cloud titles
use a nonempty upstream displayName different from the raw ID, otherwise a
curated known-provider title, otherwise an honest generic label.

## Migration / main follow-up

1. Update Help's hand-authored `HELP_MODEL_CATALOG` free seed with
   `qualifiedRoles: ["chat"]`. An unqualified seed is intentionally no longer
   Assistant-selectable. Use the exported resolver for the composer chip.
2. Update synthetic cloud fixtures that are intended as conversational models:
   explicit `["chat"]` or `["chat", "vision"]`, and a displayName when their
   consumer title matters. Do not blanket-add Chat to speech/tools/embed cases.
   Help's injected listCatalog and old free-row fixtures are likely consumers;
   broad fixture migration remains main-owned and was not performed here.
3. Because the legacy guard now covers cloud rows, review Help rejection copy
   that describes every rejected row as an "on-device engine".
4. Existing metadata-less/stale rows retain browsing/pricing data but gain no
   conversational role. Refresh through the adapter to acquire qualification;
   do not infer roles during a cache migration. Runtime role readers validate
   the whole role array and reject malformed metadata. Adapter mappers do not
   copy untrusted wire `qualifiedRoles`. `isUiModelRole` is exported if main
   needs it in a cache validator. No persistent catalogue cache implementation
   was identified in the inspected production consumers.
5. No changes were made to the full-suite fixtures, no full suite was run, and
   no integration-complete claim is made for main's ongoing Help work.

## Verification evidence

All Vitest/lint/typecheck invocations used the same atomic repo-root lock:

```bash
while ! mkdir heavy.lock 2>/dev/null; do sleep 2; done
trap 'rm -f heavy.lock/desktop.ini; rmdir heavy.lock' EXIT
```

Commands ran from `/home/sheikh/GitHub/FindBack`.

### Red evidence

```bash
npx vitest run --root apps/mobile src/services/ai/uiModelRoles.test.ts src/services/ai/providers/catalogueQualification.test.ts src/components/ModelCatalogSheet.test.tsx
```

Initial result: 3 failed files, **12 failed / 18 passed tests**. Failures proved
the old text/image promotion, ignored explicit speech roles, missing adapter
qualification, raw local/cloud IDs as primary labels, and absent speech chips.
After implementation the same scoped run passed **30 / 30**.

```bash
npx vitest run --root apps/mobile src/services/ai/modelCatalog.test.ts src/services/ai/providers/catalogueQualification.test.ts
```

Additional endpoint-mapping red: **2 failed / 23 passed**, proving the missing
Llama dialogue qualification and Gemini/Claude/Qwen endpoint mappings.

```bash
npx vitest run --root apps/mobile src/services/ai/uiModelRoles.test.ts
```

Additional guard red: **1 failed / 12 passed**, proving that an unknown cloud
selection incorrectly passed the legacy guard before its tightening.

### Final fresh evidence, 22:38:28 local tool timestamp

```bash
npx vitest run --root apps/mobile src/services/ai/providers src/services/ai/uiModelRoles.test.ts src/services/ai/providerContract.test.ts src/services/ai/modelCatalog.test.ts src/services/ai/modelCatalog.expansion.test.ts src/services/ai/modelDescriptors.test.ts src/services/ai/offline.test.ts src/components/ModelCatalogSheet.test.tsx src/screens/AiModelsRoute.test.tsx
npx eslint apps/mobile/src/services/ai/providerContract.ts apps/mobile/src/services/ai/uiModelRoles*.ts apps/mobile/src/services/ai/modelDescriptors.ts apps/mobile/src/services/ai/modelCatalog*.ts apps/mobile/src/services/ai/providers/*.ts apps/mobile/src/components/ModelCatalogSheet*.tsx
npm run typecheck -w apps/mobile
git diff --check
```

Results: **21 test files / 376 tests passed**, ESLint exit 0, mobile TypeScript
exit 0, diff whitespace check exit 0. These ran sequentially under one lock
with `&&`. An earlier intermediate lint run found `require-yield` in the new
offline fake; it was corrected and the final lint above passed.

Additional inspection commands: `git status --short`, `git branch
--show-current`, scoped `git diff`, `git diff --stat`, `ls` of the worktree and
git directory, and read-only `rg -l` to identify catalogue/record consumers.
Source inspection used Serena and file tools; primary provider documentation
was retrieved through Context7/public read-only docs/model metadata endpoints.

Not verified: full suite, live provider calls, physical Android behavior,
browser/manual keyboard/screen-reader/reflow checks, web/APK builds, or main's
remaining Help/fixture migration. No secrets were read or printed.
