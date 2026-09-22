# Runbook X4 — LFM 29A fixB-only eval run (ISOLATED)

This runbook is **fully separate from production validation**: fixB is an
eval-only candidate, never a catalogue entry, never a download, never a
runtime. Nothing here may leak into shipped paths. Evidence lands in
`test-evidence/devprep/lfm-29a/` — a lane no other runbook writes to.

Eval pin (litert-lm eval run only):

- arm: `LFM2.5-VL-450M-int4-fixB`
- rev: `1abed04b6fe71314d8c446a1371c03d7c332266d`
- sha256: `6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033`
- maturity: `eval-only` (`modelProfiles.ts`); the shipped catalogue test
  asserts fixB bytes are never distributed.

## Steps

1. Confirm isolation preconditions: shipped catalogue contains no `fixB`
   id and no `6854cd96…` hash; `bridgeModelIdForEntry("lfm2.5-vl-450m")`
   is null (eval slot, no download offered). Record in `00-isolation.json`.
2. Load the fixB bytes in the lab harness only (same harness shape as the
   coded vision corpus), run the 12 BV probes, and score each as
   valid / loop / invented with the exact loop string and length on loops
   (reference arms: stock 5/12 valid, fixB 6/12 valid per `modelProfiles.ts`
   role notes — re-tally, do not copy).
3. Re-run the BV06 passport probe specifically (known fixB failure mode:
   'Laptop' loop). Evidence: `01-fixb-scores.json`, `02-bv06-retest.json`.

## Explicitly out of scope (do not run, do not record, do not explore)

- INT8 packaging or distribution of any LFM artifact.
- The Gemma reference entry.
- The stock LFM2.5-VL arm (`45a02241…`) except as the already-recorded
  comparison tally — no fresh stock runs.
- Any extra runtime exploration (new backends, new delegates, new devices).
- Any change to production validation, catalogue, or download paths.
