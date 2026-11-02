# Private comment-media maintenance

Source contract only until the exact migration/function/client cutover is verified.
Never infer hosted acceptance from local SQL/Storage stubs or mocked SDK tests.

## Ordered cutover

1. Accept the bounded integrated source diff. Do not push migration-bearing WIP:
   linked Supabase automation may apply migrations immediately.
2. Apply/read back the forward chain through `20261102220000`:
   - `20261102200000`: Like-only writes, avatar namespace and report-object ACL.
   - `20261102210000`: private comment bucket, reservation/binding/read/expiry.
   - `20261102220000`: service-only pending-maintenance check.
   Confirm the comment bucket is private, client reservation-table/DML grants
   are closed, and private object read/insert policies use caller-bound helpers.
3. Deploy `cleanup-comment-media` with **JWT gateway verification OFF**
   (`--no-verify-jwt`). The pinned canonical server wrapper validates a backend
   secret API key in `apikey`; neither user JWT nor old cron-secret auth is accepted.
   Verify inventory version, source digest and `verify_jwt=false` after deployment.
   Deployment of source alone does not prove function parity.
4. Publish the coordinated Web client using normal validated build configuration.
   Older clients that still request public comment URLs are not private-media
   compatible. Do not leave the private-bucket cutover paired with the old client.
   No APK/release/version bump is implied by this runbook.
5. In the GitHub `backend` environment confirm presence (not values) of
   `SUPABASE_SECRET_KEY` and `SUPABASE_PROJECT_REF` (or project-ref variable).
   Reuse the backend credential broker; never fetch/print secrets for evidence.
6. Dispatch **Cleanup comment media** on the exact accepted source commit.
   Read the actual job result and count-only JSON; HTTP 200 alone is insufficient.
   Missing configuration, failed byte removal/ack, fresh leases or remaining
   expired reservations must leave the run red/incomplete, not silently green.

## Bounded worker behavior

- Schedule/manual dispatch only, one invocation at a time, no push/tag trigger.
- `max_batches`: integer 1–10, default 10. Invalid HTTP controls perform no work.
- First purge at most 200 expired (24h) uncommitted reservations into the existing
  durable queue; then claim at most 200 keys/batch. New reservations are limited
  to 16 pending per account. A committed reservation cannot be composer-discarded.
- Remove bytes before acknowledging successes. Removal failure stays queued;
  interrupted/fresh leases remain pending and become claimable after 15 minutes.
- Completion requires no pending queue row or expired reservation, no failed key,
  and matching removed/acked counts. A fresh lease is pending even if claim is empty.
- Comment/report/account cascades and abandoned uploads feed the same lease/ack queue.
  Provider GIF/sticker URLs remain external, not Storage cleanup targets.

## Required live evidence (not yet passed by source checks)

Use disposable owner-authorized fixtures; record counts/results, never tokens or
personal data. Verify reserved photo upload/atomic comment commit, wrong-account
or wrong-report denial, visibility/block revocation, public object access denied,
authorized short-lived signing, committed-media discard no-op, deletion cleanup,
abandoned-reservation reclaim, and an actual authenticated bounded maintenance run.
Real two-account/physical-device acceptance remains separate and unpassed until run.

The generic deploy planner now gates this worker on `20261102220000`; its legacy
`--migrations-live` lease-only alias is deliberately insufficient. Direct backend
deploy remains owner-controlled and must follow the ordered prerequisite check.
