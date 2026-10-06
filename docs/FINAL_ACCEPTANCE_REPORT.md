# FindBack — current verification and closure report

**Decision: HOLD — NOT COMPLETE.** Reconciled 2026-10-06 (closure-review wave).

The 2026-10-05 audit baseline below is historical provenance. The active source
of truth is [`completion-ledger.json`](../completion-ledger.json) (`generatedFor`
names the exact reconciliation commit; the completion gate binds it to HEAD).
This is a verification reconciliation, **not** a final release certificate.
Photo grounding, account-bound sends, mode-honest consent, assistant modes,
phone verification, matching fixtures, SEN-01 automation, route/map QA, schema
parity and password recovery are shipped, reviewed and CI-executed; device,
live-provider and licensed-tooling acceptance remain external. See the
[register](COMPLETION_AUDIT.md) (state cells agree with the ledger).

## Current architecture

Android React/Capacitor → hosted Supabase Auth/Data API/GraphQL/private Broadcast/
Storage; Node/SQLite/Docker remains coursework/reference only. Report-photo
automatic analysis is SmolVLM2 local-first with **consented OpenRouter fallback**;
on-device-only never sends, cloud-only skips local. Help uses direct BYOK and
installed specialized local models where wired, with built-in answers when
appropriate to the selected mode. No server relay is part of mobile inference.

CPU is first-class/default. Measured GPU vision selection requires fresh
correctness evidence; both arms retain a CPU language decoder. GPU load failure
announces CPU retry. USE is default for Possible Matches; installed Needle is an
explicit session challenger, not proven superior. Physical backend/performance,
lifecycle, memory, battery and thermal results remain **NOT_EXECUTED**.

Grounding ships as a reviewed consumer with fail-closed account-bound sends and
per-engine consent copy. Assistant modes, phone flows and password recovery are
reconciled and tested; real SMS still needs configured hosted provider and live
proof, and live email delivery needs hosted redirect allowlisting. OpenRouter alone
is marked live-tested in the provider UI. All other BYOK providers remain experimental
pending actual-send evidence; adapters/catalogues/probes are not delivery proof.

## Evidence inventory and provenance

| Evidence | Status / proves | Does not prove |
|---|---|---|
| Human audit packet `FindBack_completion_audit_b472a24_2026-10-05` (README, 00–18, checklist, readiness, prompts, evidence summaries) | Read in full; 34 findings retained in [COMPLETION_AUDIT](COMPLETION_AUDIT.md), plus FBA-035/036 from the closure review. | Runtime success of newly edited code. |
| Closure-review wave CI (exact-commit CI + Web green; Docker, phone-verification-sql, SEN-01, stale-assets gate) | CI-EXECUTED on the shipped tree; mobile/API suites, AI gate 12/12, completion integrity green, `--final` RED only on genuine external/waiver items. | Whole-app completeness, flake elimination or physical Android. |
| Push dispatch 37317074620 | AUDIT_REPORTED: scheduler/function callable, `scanned=0/sent=0/pruned=0/failed=0`. | Any delivered FCM message, notification tap or direct reply. |
| Baseline privacy/navigation/credential fixes (FBA-027–031) | AUDIT_REPORTED: truth copy, boolean connection summaries, corrected routes/comments, fail-closed account credential purge. | Certification after further changes; keep regressions and rerun at final SHA. |
| Earlier Auth/Storage/Realtime/REST/GraphQL live runs | HISTORICAL_LIVE: references in API demo and archived report. | Fresh hosted RLS/grants review or candidate phone/media/realtime proof. |
| `docs/runbooks/gate-e-device-run.md` | Prepared procedures; every device row starts NOT_EXECUTED. | An executed Gate-E pass or any device availability claim. |
| Closure-review wave (evidence block below; exact-commit CI + Web green on the shipped tree) | CI-EXECUTED: mobile/API suites, AI gate 12/12, completion integrity green, `--final` RED only on genuine external/waiver items. | Whole-app completeness, flake elimination or physical Android. |
| This documentation work | Source/path review and documentation-only verification; exact local checks recorded below. | Code tests/live/SMS/Crystal/device/build/security/release acceptance. |

No automated test count is a count of completed teacher requirements. See the
[24-row requirements matrix](REQUIREMENTS_MATRIX.md) for independent implementation
and verification statuses, and [decisions/prerequisites](../DEFERRED_DECISIONS.md).

## Closure authority

`completion-ledger.json` is the machine source of truth with its whole-app
gate (`scripts/completion-gate.mjs`: integrity in CI, `--final` pre-release,
`--release` refusing to sign on HOLD). The ledger reconciles every FBA ID with
owner, real state, evidence references, manual evidence IDs and outstanding
blockers; this report and the register agree with it cell-by-cell. A green work
wave or the AI gate cannot mark rows complete without their evidence.
Missing/failed mandatory evidence keeps the gate and release on HOLD.

### Required before release/submission acceptance

1. Return/review grounding and mode UI/runtime regression evidence; finish phone
   flows and hosted SMS configuration with actual send/resend/verification proof.
2. Prove every advertised provider or explicitly gate unproven ones as owner-
   approved labs. Resolve lab TODO ownership, similarity calibration/baseline,
   Xiaomi fixture support and MapPickerSheet repeat-run reliability.
3. Resolve every required device/build `todo`/`skip` with executable tests or
   explicit manual row evidence, not a deleted marker.
4. Run clean lint/typecheck/suites/AI gate and every release-critical native/model/
   web/security workflow on **one exact final candidate SHA**. Run full-history
   secret scan, dependency/SAST policy, hosted RLS/grants/advisors, mobile/bundle
   credential boundary and real release telemetry scrubbing.
5. Build only after asserting nonempty public Supabase URL/publishable key from
   canonical environment; prove bundle/APK URL with release-config check. Verify
   signing, version metadata, ABI assets, no stale Gradle web assets and hashes.
6. Execute all Gate-E rows on an authorized physical ARM64 device, plus clean
   install, beta.2 upgrade, core flows, photo/grounding/modes/phone, accessibility,
   App Links cold/warm/background, actual FCM delivery/taps and shade reply.
7. Create/open/render genuine Crystal `.rpt` using licensed tooling and permitted
   data access, or attach explicit evaluator acceptance of the CSV/API substitute.
   A fabricated `.rpt` is never an acceptable closure path.
8. Freeze after fixes, synchronize version/versionCode, rerun exact-SHA gates,
   tag immutably only with owner approval, publish ABI/universal APKs + AAB +
   manifest/checksums, verify downloaded signatures/hashes and post-publish
   fresh-install/upgrade. Only then issue a final acceptance report.

## Historical report preserved

The former current-path report was first frozen **2026-09-15**, commit
`e813028eb350b5fa9ff2edf82d64383fd2d5013e`; it names starting HEAD `3334905` and
last prior code/doc HEAD `f9bb0e7`, not today's candidate. It also contains the
2026-09-16 `89f0e35` non-device gate and subsequent edits through `7e33787`
(2026-09-22). Its **exact bytes as read at b472a24** are preserved unchanged in
[history/FINAL_ACCEPTANCE_REPORT_2026-09-15_e813028_as-of-b472a24.md](history/FINAL_ACCEPTANCE_REPORT_2026-09-15_e813028_as-of-b472a24.md).
The archive is evidence of those dates/commits, not current final truth. Its
GPU-only policy, server `ai-help` path, count arithmetic and old release claims
must not be reused as present acceptance.

## Documentation verification record

Documentation diff/path/ID checks and targeted truth search are the acceptance
scope of this work. No web/APK build, device test, live-provider send, SMS,
Crystal designer, security scan, release/tag, or commit is performed by this
documentation owner.

### Executed local checks (2026-10-06)

- `git diff --check` — exit 0; whitespace/conflict-marker checks clean at run time.
- `git diff --check -- DEFERRED_DECISIONS.md README.md docs/REQUIREMENTS_MATRIX.md docs/FINAL_ACCEPTANCE_REPORT.md docs/DEMO_CHECKLIST.md`
  — exit 0; owned tracked-doc diff clean. New docs were also structurally checked.
- `git diff --no-index --check /dev/null docs/COMPLETION_AUDIT.md` and the same
  command for the archive — exit 0; new register/archive whitespace checks clean.
- `npm run lint` — exit 0 (`eslint .`).
- `npm run typecheck -w @findback/mobile` — earlier invocations exit 0; **latest
  final invocation failed (exit 2)** in the concurrently edited
  `src/services/similarity.test.ts(42,24)`, TS2345: heterogeneous fixture
  `candidates` union is not assignable to the inferred fixture parameter type
  (`title: undefined` not assignable to `string`). The combined
  `npm run lint && npm run typecheck -w @findback/mobile` had lint exit 0 then
  typecheck failure. This source is outside the documentation owner's scope;
  main/test owner must fix and rerun. No web/APK build/shared-output regeneration.
- Read-only inline documentation assertions — exit 0: **24 unique requirement
  rows**, separate allowed implementation/verification columns, **34 unique FBA
  rows** with explicit closure criteria, **20 valid local document links**, selected
  source references present, all current owned docs retain HOLD, and historical
  archive **byte-identical** to `b472a24:docs/FINAL_ACCEPTANCE_REPORT.md`.
- Targeted current-doc truth searches reviewed: old-status/pivot phrases survive
  only as explicit historical/baseline/disposition text, not active architecture
  or accepted device/SMS/Crystal claims. No current matrix `DONE_DEMO_PROVIDER`,
  `DEFERRED_EXTERNAL_TOOL` or placeholder deliverable row remains. Grounding/phone/
  modes stay in progress. Archive is intentionally excluded from truth rewriting.

These lint/typecheck checks ran over a **shared, concurrently changing worktree**;
they are observations at invocation time, not final worker or exact-SHA release
certification. This owner changed only seven documentation paths (including the
new register and archive). Source/migration diffs shown by git status belong to
other owners and were neither edited nor claimed verified here.

### Command / inspection provenance

Exact shell commands executed (inspection/diff checks exit 0; latest combined
lint/typecheck failed as detailed above):

```bash
git status --short && git rev-parse HEAD
git log --follow --format='%h %cs %s' -- docs/FINAL_ACCEPTANCE_REPORT.md
git show -s --format='%H %cs %s' e813028 7e33787 b472a24 && git status --short
git diff --check && git diff --stat && git status --short
git diff --check -- DEFERRED_DECISIONS.md README.md docs/REQUIREMENTS_MATRIX.md docs/FINAL_ACCEPTANCE_REPORT.md docs/DEMO_CHECKLIST.md && git diff --numstat -- DEFERRED_DECISIONS.md README.md docs/REQUIREMENTS_MATRIX.md docs/FINAL_ACCEPTANCE_REPORT.md docs/DEMO_CHECKLIST.md && git diff -- README.md
git diff --check -- DEFERRED_DECISIONS.md README.md docs/REQUIREMENTS_MATRIX.md docs/FINAL_ACCEPTANCE_REPORT.md docs/DEMO_CHECKLIST.md && git status --short -- DEFERRED_DECISIONS.md README.md docs/REQUIREMENTS_MATRIX.md docs/FINAL_ACCEPTANCE_REPORT.md docs/DEMO_CHECKLIST.md docs/COMPLETION_AUDIT.md docs/history
npm run lint && npm run typecheck -w @findback/mobile
git diff --no-index --check /dev/null docs/COMPLETION_AUDIT.md && git diff --no-index --check /dev/null docs/history/FINAL_ACCEPTANCE_REPORT_2026-09-15_e813028_as-of-b472a24.md && git diff --check -- DEFERRED_DECISIONS.md README.md docs/REQUIREMENTS_MATRIX.md docs/FINAL_ACCEPTANCE_REPORT.md docs/DEMO_CHECKLIST.md
```

The first status was clean and HEAD was b472a24; later statuses included other
owners' concurrent code changes. History established original report commit/date
and subsequent revisions. Owned diff review confirmed README edits were limited
to feature/status truth and current-doc pointers. No source/workflow/version/
machine-ledger edits, git commit, reset, push, tag or publication by this owner.

Exact read-only assertion command (uses no env/credential files):

```bash
node --input-type=module -e 'import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path"; import {execFileSync} from "node:child_process"; const files=["DEFERRED_DECISIONS.md","README.md","docs/REQUIREMENTS_MATRIX.md","docs/FINAL_ACCEPTANCE_REPORT.md","docs/DEMO_CHECKLIST.md","docs/COMPLETION_AUDIT.md"]; const matrix=fs.readFileSync(files[2],"utf8"); const rows=[...matrix.matchAll(/^\| (\d+) \|/gm)]; assert.deepEqual(rows.map(r=>Number(r[1])),Array.from({length:24},(_,i)=>i+1)); for(const r of matrix.split("\n").filter(l=>/^\| \d+ \|/.test(l))){const c=r.split("|"); assert.equal(c.length,7); assert.match(c[4],/^ (IMPLEMENTED|PARTIAL|IN_PROGRESS|EXTERNAL_BLOCKED) $/); assert.match(c[5],/SOURCE_REVIEWED|AUDIT_REPORTED|HISTORICAL_LIVE|NOT_EXECUTED|BLOCKED/);} const audit=fs.readFileSync(files[5],"utf8"); assert.deepEqual([...audit.matchAll(/^\| FBA-(\d{3}) \|/gm)].map(r=>Number(r[1])),Array.from({length:34},(_,i)=>i+1)); for(const r of audit.split("\n").filter(l=>/^\| FBA-/.test(l))){assert.equal(r.split("|").length,7); assert.ok(r.split("|")[5].trim().length>40);} const archive="docs/history/FINAL_ACCEPTANCE_REPORT_2026-09-15_e813028_as-of-b472a24.md"; assert.deepEqual(fs.readFileSync(archive),execFileSync("git",["show","b472a24:docs/FINAL_ACCEPTANCE_REPORT.md"])); let links=0; for(const f of files){const s=fs.readFileSync(f,"utf8"); assert.match(s,/HOLD/); for(const m of s.matchAll(/\]\(([^)]+)\)/g)){if(/^https?:/.test(m[1]))continue; const target=m[1].split("#")[0]; if(!target)continue; assert.ok(fs.existsSync(path.resolve(path.dirname(f),target)),`${f}: broken link ${target}`); links++;}} for(const p of ["components/ReportDatePicker.tsx","components/YouTubeEmbed.tsx","components/CategoryField.tsx","components/PostList.tsx","services/posts.test.ts","services/realtime.test.ts","vite.config.ts"]){assert.ok(fs.existsSync(p==="vite.config.ts"?`apps/mobile/${p}`:`apps/mobile/src/${p}`),p);} console.log(`PASS: 24 unique requirements with independent status columns; 34 unique FBA rows with closure criteria; archive byte-identical to b472a24; ${links} local doc links valid; selected source references exist; current docs HOLD.`);'
```

Tool-based truth search parameters: current-doc include
`{REQUIREMENTS_MATRIX,FINAL_ACCEPTANCE_REPORT,DEMO_CHECKLIST,COMPLETION_AUDIT}.md`,
pattern `OpenRouter-only|local generative runtime.*removed|no CPU fallback|RETIRED 2026-09-25|DONE_DEMO_PROVIDER|DEFERRED_EXTERNAL_TOOL|TBD|grounding.*deferred|grounding.*IN_PROGRESS`;
root status include `{README,DEFERRED_DECISIONS}.md`, pattern
`SmolVLM2|consented|CPU|Needle|experimental|IN_PROGRESS|HOLD|licensed|completion-ledger`.
Matches were reviewed in context, not treated as an automatic no-drift certificate.

**Next action:** main fixes/reverifies the observed concurrent similarity test
type error, consumes returned implementation/test evidence, populates
the completion ledger, and runs remaining external/candidate gates. Full external
prerequisites are enumerated in [COMPLETION_AUDIT](COMPLETION_AUDIT.md): device/ADB,
SMS, provider keys/consent, licensed Crystal tooling/evaluator decision, FCM/domain/
certificate access, telemetry/signing/security/hosted review authority, permitted
matching dataset/vendor fixture. No final completion claim is authorized here.
