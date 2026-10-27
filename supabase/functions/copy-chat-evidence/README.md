# Report-media evidence copy

This server-only worker processes **one** canonical evidence lease per empty
POST. It accepts the default new-format Supabase secret API key through the
canonical `@supabase/server` auth owner. A publishable key or user JWT alone
cannot claim work. Never invoke it from consumer code or return its private
Storage paths/work tokens to consumers.

Deployment requires `--no-verify-jwt` (or equivalent function-level
`verify_jwt = false`): the handler itself verifies the secret API key. Use the
platform's injected `SUPABASE_URL` and new-format `SUPABASE_SECRET_KEYS` or
`SUPABASE_SECRET_KEY`; do not put values in this repository, logs or requests
from clients. Legacy service-role JWT keys are not supported by this auth owner.
The function-local frozen Deno lock preserves its SDK dependency graph without
changing the unrelated root lockfile. No scheduler is installed by this code.

The worker discovers jobs through `findback_claim_chat_media_evidence_job`,
verifies exact length and SHA-256 using bounded streams, writes with
`upsert:false`, verifies destination bytes, then calls only the lease-aware
`findback_finish_chat_media_evidence_job`. A matching destination can finish a
retry even if the original source is gone. An upload error or duplicate is not
success unless destination bytes match. It never deletes or transforms media.
Trusted MIME/dimensions travel with cryptographically identical bytes; this is
not a second image-intake validator.

Every operation—including the SDK upload fetch—is abort-bound to the request,
90-second invocation budget and lease/evidence deadline minus five seconds.
Failures leave the lease for later discovery/reclaim; HTTP results expose only
`idle`, `attached` or `retry`. The caller may retry a 503, but it cannot choose
the report, source, destination, metadata or batch size.

A successful finish RPC is authoritative even if the response crosses the local
safety margin. An aborted/lost response is unknown and may still report retry
after a remote commit; canonical discovery/lease fencing resolves that safely.
One active authenticated attempt is permitted per endpoint/isolate; overlapping
requests receive retry before claiming a job. Each stream is bounded to 20 MiB,
not the whole process: source, upload copy and read-back buffers can coexist
(roughly 60 MiB payload buffers before SDK/runtime/chunk overhead). This is not
a distributed concurrency/rate limit. Scheduler/deployment must bound scale and
validate the maximum-size slow-stream memory envelope before hosted acceptance.

## Acceptance still required

Local tests exercise the real auth/SDK code against a hermetic fake transport,
not a deployed service. Deployment, secret-key provisioning, scheduler fairness,
actual Storage policy/copy/delete behavior and platform-level cancellation are
not established here. Aborting fetch cannot prove cancellation of an already
accepted server-side write. Validate late-write cleanup and the SQL one-hour
grace before hosted acceptance; do not treat this implementation as proof of
physical deletion or full report-retention compliance. Gateway/client/rendered
media acceptance is separate. Physical-device/TalkBack remains owner-deferred.
