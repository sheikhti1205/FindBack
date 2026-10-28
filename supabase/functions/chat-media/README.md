# Chat media upload

POST exactly one image as the request body with `x-message-id` and `x-attachment-id` containing lowercase UUIDs and `content-type` set to the matching JPEG, PNG or WebP type. The canonical wrapper verifies the user JWT; deploy with `--no-verify-jwt`. A successful response contains only attachment identity and verified metadata. Responses are not cached. No Storage target or credential is returned.

The gateway buffers a maximum of 20 MiB, checks format headers and dimensions (1–8192), and hashes the exact bytes. It reserves under the user's JWT, gets the target with the admin client, writes without upsert, verifies length and SHA-256 from Storage, and then commits through the service RPC. Duplicate immutable writes are accepted only after matching read-back. A reservation with 120 seconds or less remaining is rejected before any Storage operation. This margin allows a conservative interval for processing and communication; the attempt is also capped at 90 seconds and aborts at the earlier of that limit or 120 seconds before expiry. Actual SDK fetches receive the abort signal.

Header inspection is not full decoding, image integrity validation, metadata stripping, malware scanning, or confirmation of renderability. An image can have valid dimensions and still be corrupt elsewhere.

## Concurrency and availability

One upload runs at a time per function instance. A 20 MiB image is held in memory more than once — the buffered body, a copy handed to the immutable write, and a copy filled during read-back verification — so peak memory is several times the image size. The instance is the only place that bound is enforceable. A concurrent request in the same instance receives a generic `503` and must be retried by the client. This is a throughput limit, not a correctness limit; it has not been measured against hosted load.

## Residual risk / what this does not prove

Aborting a fetch does not establish that an already accepted remote write has stopped: bytes may still arrive afterward. The 20 MiB cap, the one-hour cleanup grace and Stage E's seven-day rechecked tombstone mitigate this: verified removal leaves a tombstone and late-arriving bytes can be swept again. Bytes are hashed and dimension-checked but never re-encoded, so metadata the client did not strip (EXIF GPS, for example) is preserved. Stripping is a client-side obligation and is not performed here.

This implementation does not establish actual hosted timing, cancellation, tombstone operation, deployment, real Storage behavior, or device acceptance; those require separate validation.
