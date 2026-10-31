# RAM requirement UI design (Tasks 26-27, SPEC ONLY — no enforcement code)

## 1. What the user sees (per model entry)

Every catalogue entry displays three figures plus provenance, in this exact order:

1. **Minimum free RAM ~X GB** — install/run gate threshold (`minFreeRamMb`).
2. **Recommended ~Y GB** — comfortable headroom (`recommendedFreeRamMb`).
3. **Your device now Z GB available** — live reading at display time (later task wires the native API).
4. **Requirement source chip** — one of:
   - `Measured on-device` (source MEASURED),
   - `Vendor figure` (source VENDOR — always paired with a stack caveat, e.g. "desktop transformers stack, not LiteRT/Android"),
   - `Conservative estimate` (source CONSERVATIVE_ESTIMATE — always paired with `ramNotes` formula/derivation).

Formatting: `~X GB` = `minFreeRamMb / 1024` rounded to 1 decimal (1536 → "~1.5 GB").

## 2. Status bands (pure presentation rules for the later task)

| Band | Condition | Treatment |
|---|---|---|
| OK | available ≥ recommended | Normal install affordance |
| TIGHT | min ≤ available < recommended | Amber note: "Below recommended — may be slow or evicted under memory pressure." |
| BELOW_MIN | available < min | Red warning + **advanced-confirmation gate** (§3) |
| UNKNOWN_SOURCE | source is CONSERVATIVE_ESTIMATE | Estimate chip always visible; "Re-measure on device" footnote |

Large `catalogOnly` entries (e.g. Gemma) additionally carry the **not-verified banner**:
"Not verified on FindBack. Minimum free RAM figure is a conservative estimate, not a measurement. Listing is for reference only."

## 3. Below-minimum advanced-confirmation gate (DESIGN — do not implement yet)

Trigger: user attempts install/run while `available < minFreeRamMb`, OR any run of a `catalogOnly`/`EXPERIMENTAL` large entry.

Gate dialog (all four must hold before proceeding):
1. Shows the three figures (X / Y / Z) + source chip + `ramNotes` summary.
2. Explicit typed/checked acknowledgement (checkbox, NOT a single "OK" tap): e.g. "I understand this model needs ~X GB free and my device has Z GB available."
3. Second confirmation step for large entries ("Advanced: run unverified large model").
4. The decision + figures + catalogue version are recorded to local diagnostics log (append-only, for later support triage).

Non-goals for this gate: it MUST NOT bypass checksum verification, MUST NOT bypass the .fbmodel executable ban, and MUST NOT retry-loop the download. Enforcement, native free-RAM API wiring, and persistence are explicitly LATER tasks.

## 4. RAM figure derivation formula (v1, estimates only)

No vendor publishes per-model Android free-RAM requirements (research 2026-09-21: LiteRT-LM docs, HF cards, Liquid docs — none found; recorded as unknown, not defaulted):

- `minFreeRamMb = ceil_to_256(installedMiB + reserveMiB)`, reserve: 1150 (vision/multimodal), 700 (text ≤1.2B), 3000 (large, class floor).
- `recommendedFreeRamMb = ceil_to_256(installedMiB + 2048)` (large: class floor 6144).
- Where `installedBytes` is unknown, a **class-based floor** is used (1024/2048 for 0.6B-text-int4; 4096/6144 for large) and the entry MUST keep `ramRequirementSource: CONSERVATIVE_ESTIMATE` with the derivation in `ramNotes`.

Worked example (SmolVLM2-500M): installed 360822960 B = 344 MiB → min 344+1150=1494 → **1536**; rec 344+2048=2392 → **2560**. UI: "Minimum free RAM ~1.5 GB / Recommended ~2.5 GB".

Reference (NOT a requirement): SmolVLM paper arXiv:2504.05299 Table 1 reports 1.2 GB RAM for 500M-class at batch=1 on the transformers/desktop-GPU stack — cited in `ramNotes` as a lower-bound sanity reference with the stack caveat, never as the gate figure.

## 5. Promotion rule

`CONSERVATIVE_ESTIMATE` → `MEASURED` requires: on-device measurement, method on file (device model, OS, runtime version, KV/context settings, measurement API), recorded in `ramNotes` + provenance. Vendor figures never auto-promote to MEASURED.
