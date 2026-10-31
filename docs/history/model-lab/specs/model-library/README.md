# Curated Model Library — spec index (SPECIFICATION ONLY)

No production downloader/runtime integration is specified here. No new
dependencies. No modifications to existing code, schemas, or migrations.

## Files

| File | Contents |
|---|---|
| `catalogue.schema.json` | JSON Schema (draft 2020-12) for catalogue entries. `recommended >= min` is a REVIEW rule (vanilla JSON Schema cannot compare two properties — enforced by checklist below, and by the later importer task). |
| `catalogue.v1.json` | v1 catalogue data: 7 entries across `vision` / `text` / `multimodal` / `experimental-large`. Shipped-pin design: app bundles this file, never a mutable remote list. |
| `ram-ui.md` | RAM UI design: Min ~X / Rec ~Y / device Z + source chip; below-minimum advanced-confirmation gate (designed, enforcement later); estimate formula + promotion rule. |
| `releases-distribution.md` | GitHub limits with doc citations; chunking verdict (unnecessary except Gemma-class); `FindBack-Models` layout; shipped-pin hard rule. |
| `fbmodel-package.md` | `.fbmodel` layout (manifest + weights + tokenizer + projector-if-required + checksums); no-executables hard invariant; STORE-vs-DEFLATE bench + policy. |
| `threat-surface.md` | Zip-slip / decompression bombs / checksum bypass / executable injection / rollback — surface only, for the later security review. |
| `../../apps/mobile/src/services/models/catalogueTypes.ts` | TypeScript mirror of the schema (types + sentinels only, no logic). |

## v1 review checklist (before any implementation consumes this spec)

- [ ] `catalogue.v1.json` validates against `catalogue.schema.json`.
- [ ] Every entry: `recommendedFreeRamMb >= minFreeRamMb`.
- [ ] Every VERIFIED entry has non-null `downloadBytes`/`installedBytes`/`sha256` + pinned `revision`.
- [ ] Every `catalogOnly` entry has `requiresAdvancedConfirm: true`.
- [ ] No entry invents numbers: all unknowns are `null` / `UNKNOWN_NOT_ESTABLISHED` with an `UNKNOWN` provenance item.
- [ ] No forbidden files touched (CreateReport.tsx, LocationPicker.tsx, VLM kotlin, migrations, downloader/runtime).
