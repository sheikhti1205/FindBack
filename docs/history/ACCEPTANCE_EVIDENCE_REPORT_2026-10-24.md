# Consumer-final programme — evidence correction and open gates

**Status: INCOMPLETE / NOT RELEASE-READY.** Corrected 2026-10-24 against source
baseline `fc0d0d6f32bdfa1d930c82cf22ca2b387f762b4f` on main.
This is a progress/evidence report, **not** the final Downloads acceptance report
and **not** a complete 519-obligation ledger.

Labels: **[VERIFIED]** is an observed file/Git/test fact within the stated scope;
**[INFERRED]** is a source-based consequence not executed in this correction;
**[BLOCKED/UNVERIFIED]** is an unmet requirement or missing evidence. No inference
or missing proof counts as acceptance.

## Corrections to inherited claims

- “All phases complete” was false: several tasks' own evidence said DEFERRED or
  described missing implementation. They remain open under the full programme.
- “Full-diff review of all 854 commits” was false. Displayed `git show --stat`
  commands only produced diffstats; repeated/estimated counts do not prove coverage.
- “All migrations applied” and “server-side foundation complete” were unsupported.
  File presence, a schema-version constant and lexical checks do not execute SQL
  or verify hosted deployment. Independent source review now finds blocking defects.
- The old report misnamed the 030000/040000/050000/080000 migrations and called
  seven new matching/chat/appeals files fully verified. Correct names appear below.
- Remaining work is not merely client-side, nor blocked solely by external resources.
  Backend repairs, behavioral tests, history review and CI source work can proceed
  locally. Owner-only matching does not become an admin-confirmation workflow.

Original artifacts are preserved in Git and the private correction archive.
Authentic earlier evidence is retained at its original scope, not erased.

## Authority and history

**[VERIFIED]** Both original ZIPs pass CRC checks and all retained extraction
members match: 29 original-handoff members and 19 R3 members.

| Packet | SHA-256 |
|---|---|
| Original 2026-10-15 handoff | `1bcacf9ecc9754b78139bb19c716936257335f4c9bc7716327713e3b68dc3943` |
| R3 2026-10-24 supplement | `47279702862d1fd9b2010e000ccd27dbbf1a3b9601420b64449950bf0ef529e3` |

Packet integrity is not full requirement reconciliation. All 519 obligations and
owner amendments still need exact artifact mapping. R3 overrides named scope only;
original AI pruning and canonical media/safety ownership remain binding.

**[VERIFIED]** The frozen history inventory has 854 distinct identities. Its
register records ten complete maintenance-diff observations (independently
corroborated), 490 preliminary triage rows and 354 unreviewed rows. At least 844
rows in that inventory lack supported meaningful-diff disposition, and later
forward commits need supplemental coverage. No unsupported percentage is retained.

[VERSION_HISTORY.csv](VERSION_HISTORY.csv) now preserves identity in the R3
ten-column format without guessing product versions. The
[history note](VERSION_HISTORY.md) records 17 observed package-declaration
intervals, not 17 accepted product milestones. The old stable label is historical
metadata only. Reconstructed versions, tags/releases, chronology and actual
meaningful-diff review remain **[BLOCKED/UNVERIFIED]**.

## Earlier safety work — preserve, do not generalize

| Source change | Located evidence and limitation |
|---|---|
| `ffca1c9` probation; `e0fbb0d` refusal copy | Commits preserved in ancestry. Earlier independent audit reopened safety findings; preservation alone is not acceptance. |
| `8ab29dc` F2 reply standing | Private `INDEPENDENT-REPLY-STANDING-REVIEW-001.md`: narrow PASS for frozen service-token-standing repair; six serious-standing cases and recorded SQL RED/GREEN reviewed. Not hosted/device proof. |
| `cb03f16` F1 target visibility | Private `INDEPENDENT-VISIBILITY-REVIEW-003.md`: source-review PASS with F-1/F-2/F-3 hardening and F-5 freeze/execution limitations explicitly retained. Not an independent fresh race-test run. |
| `0d1438e` F3 wall-clock standing | Located `INDEPENDENT-STANDING-TIME-REVIEW-001.md` is CONDITIONAL PASS requiring F3-1/F3-2 fixes and more verification. A final independent post-fix PASS has not been established by this correction. Preserve the existing race logs; do not claim final acceptance. |

The earlier safety evidence and frozen inputs require revalidation against exact
committed bytes. They do not certify the seven later migrations. “All tests pass”
is not asserted. No safety migration or application behavior is changed here.

## Local SQL inventory, not hosted-applied inventory

**[VERIFIED]** There are 89 local SQL files at the baseline. The source-declared
`BACKEND_SCHEMA_VERSION` is `20261024120000`; this is not the measured hosted head.
[MIGRATION_INVENTORY.md](MIGRATION_INVENTORY.md) is a filename/header index, not a
dependency, execution, or application proof.

| File in `supabase/migrations/` | Introducing commit |
|---|---|
| `20261024030000_notification_reply_standing.sql` | `8ab29dc` |
| `20261024040000_public_target_visibility.sql` | `cb03f16` |
| `20261024050000_standing_time.sql` | `0d1438e` |
| `20261024060000_cf050_matching.sql` | `b30b41f` |
| `20261024070000_r3_chat_foundation.sql` | `1b0e3d2` |
| `20261024080000_appeals_resolver.sql` | `50b3141` |
| `20261024090000_r3_chat_messages.sql` | `2c169a8` |
| `20261024100000_r3_chat_mailbox.sql` | `f784a19` |
| `20261024110000_r3_appeals_notifications.sql` | `fce2171` |
| `20261024120000_cf050_mutual_confirmation.sql` | `4ef69ca` |

`scripts/verify-migrations.mjs` only examines semicolons, textual begin/commit
counts and the schema-version string. Its “verified” output must not be used as
proof of PostgreSQL replay, RLS, concurrency, delivery or deployment.

## Independent backend audit: FAIL

**[VERIFIED]** Private `audit-20261024/INHERITED-BACKEND-REVIEW-002.md` reads the
complete seven-file post-safety SQL diff (1,011 added lines), traces dependencies,
and records 17 findings plus 22 designed counterexamples. It performed no SQL or
hosted execution. The reviewer is a different session using the same model as
the coordinator; independence is separate context, not model diversity.

| Area | Observed source defects; expected consequences remain [INFERRED] until execution |
|---|---|
| Migration replay | `findback_confirm_match(text)` changes void→text through CREATE OR REPLACE, without dropping the prior signature. PostgreSQL is expected to reject the last migration (B01). |
| Chat consent/block | Accept checks only “not initiator,” not pair membership; canonical `user_blocks` is not consulted; stale updates and old initiator state undermine fresh acceptance (B02–B03). |
| Receipts/read APIs | Receipt RPC lacks REQUEST/CONNECTED and reciprocal-consent checks. Revoked table grants plus absent reader/register/delete RPCs make the declared policies insufficient (B04–B05). |
| Delivery/retention | Send generates a new ID per retry, never enqueues, and does not use the outbox. Enqueue omits sender's other devices. Cleanup retains acknowledged envelopes and never purges delivered bodies (B06–B07). |
| Deletion/evidence | No delivered unsend/clear event protocol, anti-resurrection or chat evidence capture. Existing POST/COMMENT/USER evidence is not claimed erased by this finding (B08). |
| Matching/recovery | Existing status writers bypass matching; pair eligibility, serialized exclusivity, deletion repair, audit and canonical recovery/rating integration are missing (B09–B12). |
| Appeals | Resolver/notifications use nonexistent role/appellant/audit fields, wrong status case and incompatible receipt timestamp; entity reversal is a placeholder rather than working canonical moderation repair (B13–B16). |
| Verification | No behavior tests for the seven new files in their integrated diff; existing definer-inventory/replay gates are not replaced by the lexical script (B17). |

**Do not deploy these additions as-is.** Establish actual applied versions/hashes
before designing forward-only repair; never conceal failures by editing possibly
applied migration history. Source-predicted defects are not claims of observed
production exploitation or freshly executed test failures.

## Full programme still open

| Deliverable | State / required next proof |
|---|---|
| CF-050 | Backend/client implementation and owner-only lifecycle, counterpart visibility/deletion, recovery/rating consistency, SQL concurrency tests and rendered acceptance. MATCHED ≠ RECOVERED is not yet enforced end-to-end. |
| R3 policy | Participant consent, REQUEST/CONNECTED/block separation, permission-first/open opt-in, multiple request texts, quiet first nudge, no preaccept media/link/receipt disclosure, reciprocal receipts, End and abuse controls. |
| R3 storage/sync | Android SQLite/web IndexedDB, local-first UI, stable-ID outbox, temporary per-device envelopes, persistence-before-ACK, wake-only signals, deterministic multi-device tests. |
| R3 deletion/recovery | Same-user-device delete/clear, author unsend with protected captured evidence, anti-resurrection, local/Drive merge/restore, linked-device transfer, consensual resend and honest gaps. |
| R3 surfaces | Canonical private media integration, Connections/navigation/global inbox/settings, deleted-account handling and accurate non-E2EE/retention wording. AI assistant transcripts are not peer chat. |
| Appeals | Executable capability-gated resolver, entity reversal/expiry policy consistency, audit/owner notifications and staff/client surfaces. |
| Public presentation | Supplied-base README review, roadmap/course mapping, sanitized screenshots and actual fast/heavy CI split. CI source changes do not require hosted CI execution access. |
| Recovery | Existing refs/releases/assets restore PASS remains narrow and excludes dirty worktree state. Complete isolated restore/rewrite approval remains unmet. |
| Hosted | Fresh applied-migration read-back and live behavior missing; this correction has not established which authorized connection method is available. |
| Device | Current physical-device acceptance missing; do not infer device absence from missing evidence. Earlier emulator work is not physical-device release proof. |
| Artifacts | Configured web/APK with nonempty URL/publishable-key prechecks and post-build bundled-config/install/upgrade proof not performed here. Do not infer credentials are absent. |
| Final ledger/report | All 519 obligations/additions and exact evidence must be reconciled; readable final Downloads report still required. This file is not that deliverable. |

## Verification of this correction only

The private correction bundle retains original public files, packet integrity and
1,708 package-blob metadata checks, focused converter RED/GREEN logs, and the
independent backend audit. CSV conversion tests exercise identity/quoting, refusing
inferred stable assignments, invalid inputs and semicolon-separated merge parents.
They are not history inspection, backend tests, or programme acceptance.

The full objective remains open. No destructive Git action, hosted mutation,
new branch, configured build or device run is claimed by this correction.
