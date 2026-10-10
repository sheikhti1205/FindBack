---
name: findback-adversarial-review
description: Use after every substantive FindBack implementation wave, before integration or completion claims, especially for UI, auth, database, media, AI, or realtime changes.
---

# Independent adversarial review

The reviewer did not implement the change and must not trust the implementer's summary.

1. Read the owner requirement and the actual base..head diff.
2. Trace the real production path end-to-end.
3. Check that tests assert behavior rather than implementation trivia or weakened expectations.
4. Invent at least five counterexamples: failure, interruption, stale state, account switch, slow network, long content, accessibility/keyboard, repeat gesture, or malformed input as applicable.
5. For UI, inspect rendered evidence and compare with owner references. Green tests cannot approve cheap or incorrect interaction design.
6. For backend/schema, inspect RLS/grants, ownership, idempotency, private/public data, realtime payloads, rollback/failure behavior.
7. For AI, verify role/capability routing, model/runtime compatibility, failure/refusal normalization, no hidden privacy boundary crossing, and no benchmark claim without measured evidence.
8. Return exactly PASS, PARTIAL, or FAIL with concrete evidence and file/line references. PARTIAL/FAIL goes back to the same implementer for fix, then re-review.

Never edit product files from the reviewer role.
