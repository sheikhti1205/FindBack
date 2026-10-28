# cleanup-chat-media

Service-only sweep that removes private chat media bytes **after** their
database metadata is gone, and keeps a bounded tombstone so a late write cannot
silently orphan an object.

## Contract

- `POST` with an **empty body** only. The endpoint authenticates through
  `@supabase/server` `auth: "secret"` (server secret API key). Deploy with
  `--no-verify-jwt`. No anonymous, public or user route can claim or delete.
- One sweep per endpoint/isolate; an overlapping call returns `503 {status:"retry"}`.
- Bounded work: 25 candidates per batch, up to 20 batches, 90 s invocation cap.
- Results contain counts and a status only — never buckets, object keys,
  generations, media ids or raw SDK errors.

## Per-candidate protocol

1. `findback_chat_media_cleanup_candidates(p_limit)` — canonical due work.
2. `storage.remove([objectKey])` on the candidate's own bucket.
3. `storage.exists(objectKey)` — absence is accepted only on an exact 404. A
   400, 403, 5xx, proxy response or malformed error **defers** the candidate.
4. If bytes are still present: wait briefly, remove once more, verify again.
5. Only after verified absence: `findback_chat_media_cleanup_done(...)`.
6. If bytes reappear immediately after the acknowledgement,
   `findback_chat_media_cleanup_recheck(...)` re-arms the tombstone.

## Tombstones

`findback_chat_media_cleanup_done` no longer deletes the provenance row on the
first success. It records `removed_at`, re-checks once a day for seven days
(`next_check_at`, `purge_after`) and purges the row after that window. This is
what makes a late upload visible instead of orphaned. Object keys are random
UUIDs and are never reused.

## Scheduling

`public.findback_schedule_chat_media_workers()` (migration
`20261028060000_chat_media_worker_schedule.sql`) registers:

| job | cadence | endpoint |
| --- | --- | --- |
| `findback_chat_evidence_copy` | every minute | `/functions/v1/copy-chat-evidence` |
| `findback_chat_media_cleanup` | every 10 minutes | `/functions/v1/cleanup-chat-media` |

Registration is idempotent, deletes any prior job of the same name, and is
secret-free: the cron command reads the API key from Supabase Vault
(`chat_media_worker_secret`) at run time. It returns `unavailable` without
`pg_cron` + `pg_net` + Vault, `unconfigured` without
`chat_media_worker_url`/`chat_media_worker_secret`, and `invalid-url` for a
non-https origin. It is executable only by the migration owner.

Operator runbook (hosted, not yet performed):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'chat_media_worker_url');
select vault.create_secret('<server-secret-api-key>', 'chat_media_worker_secret');
select public.findback_schedule_chat_media_workers();  -- expect 'scheduled'
select jobname, schedule, active from cron.job where jobname like 'findback_chat_%';
```

## Verification performed locally

- `deno test supabase/functions/_shared/chatMediaCleanup_test.ts`
- `deno test supabase/functions/cleanup-chat-media/handler_test.ts`
- `deno check` on the endpoint and shared core.
- Full media SQL probe chain, including the new settle/tombstone, purge and
  late-write re-check assertions and the scheduler guard probe.

## Not verified

Deployed function behaviour, hosted `pg_cron`/`pg_net` execution, real Storage
delete/HEAD semantics and eventual consistency, scheduler throughput, and
physical-device acceptance. No credentials were read.
