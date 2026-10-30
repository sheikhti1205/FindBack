# Functional source freeze — 2026-10-30

**[VERIFIED] Available internal engineering gates accepted; not beta readiness,
device acceptance, a signed release, or a stable 1.0 claim.**

## Exact source target

- Programme: `FB-BETA-CLOSE-2026-10-29`, M5.
- Frozen source commit: `cd81be0def73b69decea703fc2b2c9d9c2edd77d`.
- Frozen source tree: `dfd7f67e5539f4313bf426278ef43c3dc63d078a`.
- Parent integrated product: `8df396baa93019223353434531fb91010df2caf3`.
- Accepted five-path patch SHA256:
  `3ab95fdc402e6feb7b0c6e597db54ffee4f3079d1121c64a6e1aef642548ae50`.
- Root/mobile package declaration: `2.0.0-beta.1`; shared/API: `0.1.0`.
  These are observed declarations, not the evidence-derived pre-1.0 identity
  still to be reconstructed in M6.

The freeze commit contains three test repairs and an administrative gate/test
exception for the existing owner-device calibration reminder. It changes no
product runtime or migration. This later documentation commit records the source
target without a self-referential commit hash. M6 must preserve that product
content, applied migration bytes and the subsequent documentation history.
Unrelated dirty lock/legacy SQL/private evidence is excluded, not discarded.
Do not add product features after this freeze unless a blocker requires repair.

## Integrated evidence

| Gate | Observed result and boundary |
|---|---|
| Mobile | 519 exact files, 21 accepted batches, 7,036 passed; one manual-photo skip and three device-only TODOs retained |
| API | 20 files, 167 passed; synthetic SQLite, only dotenv loading isolated |
| Scripts / SQL Node | 42 files / 1,062 passed; 15 files / 479 passed |
| Local SQL behavior | 120 application migrations, 20 + 5 behavior-probe files; platform-only pg_graphql not emulated |
| Edge | 17 Deno files, 266 accepted tests: 261 original successes plus five unchanged admission tests in a clean isolated PostgreSQL cluster |
| Types / lint | Shared/API/mobile typecheck and five-path lint passed; production deployment check/lint passed |
| Secret / build | 1,700 tracked files clean; configured web build passed with nonempty public-config preflight and bundle URL/key proof; no APK built |
| Render | Accepted M4 representative matrices reused only for unchanged runtime inputs; original failed run and incomplete landscape exclusions retained |
| Fresh affected checks | 31 completion-gate tests and 73 tests across the three changed mobile files; mobile typecheck, five-path lint and secret scan passed |
| Evidence identity | 980 mobile/config input hashes and retained raw report hashes revalidated at 09:47:26 UTC; reviewed patch unchanged |

Original failed mobile batches, legacy SQL expectation, Node/jsr misrouting,
loader failures and contaminated admission fixture runs remain failed records.
The fresh clean-cluster admission result does not rewrite the original five
failures as a wholly green original run. Default Deno test lint also remains
failed with 71 findings; scoped test lint passed excluding only `require-await`
and `no-unversioned-import`. Production lint was not weakened. These are local
cached-dependency tests, not fresh dependency reproducibility proof.

One bounded independent milestone audit accepted the available internal state,
with no demonstrated P0/P1 security/data-integrity/runtime blocker. No new audit
cycle was used for its nonblocking findings:

- P2: the administrative debt exception is line-substring scoped; unrelated debt
  on that same allowed line could bypass the gate. No such concealed current
  feature debt was found. Same-line isolation is **not** claimed.
- P3: the recovered-status ArrowRight probe has no explicitly focused radio and
  is **not** keyboard-navigation proof.

Private raw reports, failures, source downloads, runners and audit are retained
under the programme's `sessions/M5/`; personal/operational evidence is not copied
into this public artifact. The release completion gate deliberately remains HOLD
for unmet release/owner acceptance; passing its tests does not turn HOLD green.

## Hosted state at 09:02:29 UTC

**[VERIFIED]** 121 local/remote migration-history rows equal, live head
`20261029130000`, pending migrations zero. No M5 migration authored or changed.
Applied migration files remain immutable.

| ACTIVE Edge Function | Version |
|---|---:|
| ai-help | 10 |
| push-dispatch | 7 |
| reply-comment | 4 |
| cleanup-comment-media | 1 |
| delete-account | 2 |
| chat-media | 1 |
| cleanup-chat-media | 3 |
| copy-chat-evidence | 2 |
| trust-maintenance | 1 |

Existing accepted reply-comment/delete-account source was deployed separately
to repair actual first-party TypeScript drift, preserving JWT configuration.
Downloaded first-party TS closures match for all nine functions. Three anonymous
401 refusals and chat-media malformed-payload 400 were observed; 400 is not auth
proof. Source publication alone is not a function deployment.

**[BLOCKED/UNVERIFIED]** Download APIs omit chat-media's lock-only config;
byte-complete deployed config/transitive dependency identity is not established.
Migration-history parity is not recovery of historical applied SQL bytes.
These known evidence limits are not fabricated parity passes or requests for
owner credentials. Available catalog/source evidence demonstrated no remaining
first-party TS drift; a complete deployment-byte equivalence claim is withheld.

## Acceptance retained for final closure

**Owner-deferred, not performed/passed:** actual authenticated matching/chat/trust
client sessions; two accounts/three logical devices; offline/lost ACK/restore and
native media/FCM/Drive/provider-consent flows; physical-device keyboard/IME,
TalkBack and assistive-technology acceptance; private phone-photo multilingual
matching evaluation. The maintained external checklist retains the exact actions.
Synthetic SQL, SDK doubles and browser rendering do not substitute for these.

Deliberately out of scope: groups/calls, E2EE, monetization, a separate staff app,
local generative assistant and photo/VLM report analysis. Existing narrow local
search/intelligence remains separate from cloud BYOK text chat.

M6 history/recovery/public-repository work and M7 release/final acceptance remain
unfinished. **No internal-beta-ready verdict, release tag, APK acceptance or
permission to skip the recovery archive is implied by this source freeze.**
