# FindBack Migration Inventory

**Generated:** 2026-10-24
**Total migrations:** 89
**Latest:** 20261024120000_cf050_mutual_confirmation.sql

**Source-file index only — NOT an applied-migration or dependency inventory.**
Descriptions below are truncated migration-header excerpts, not validated behavior.
They may contain stale references or unsupported claims (for example, the 110000
header names a nonexistent 050000 appeals file; the actual resolver is 080000).
File count and schema-version metadata do not prove SQL replay or hosted state.
The post-safety additions have failed independent source review; see the
[acceptance correction](ACCEPTANCE_EVIDENCE_REPORT_2026-10-24.md) before using them.

| Migration File | Purpose |
|---|---|
| 20260912000000_init.sql | FindBack — initial PostgreSQL schema (Supabase). Mirrors services/api/src/db/sqliteAdapter.ts (SQLITE_SCHEMA). Apply wit |
| 20260912170500_restrict_rls_auto_enable.sql | Harden the Supabase-managed `public.rls_auto_enable()` function.  Context: |
| 20260912181321_supabase_feed_and_report_rpcs.sql | FindBack — backend-only RPCs for the two operations that PostgREST table queries cannot express cleanly: * findback_quer |
| 20260912190128_auth_password_hash_nullable.sql | Prepare public.users for the Supabase Auth cutover.  Supabase Auth will own password storage, so a production profile ro |
| 20260914062145_create_findback_images_bucket.sql | FindBack listing images.  A single PUBLIC bucket the Node backend writes to and everyone may read from |
| 20260914120000_direct_auth_profiles.sql | FindBack — direct Supabase Auth profile provisioning + users RLS bootstrap.  Mobile now authenticates directly against S |
| 20260914130000_direct_auth_profiles_legacy_tolerant.sql | FindBack — make auth.users profile provisioning tolerant of the legacy Node registration path.  |
| 20260914140000_auth_profile_delete_cascade.sql | FindBack — keep public.users in sync when an auth user is deleted.  public.users.id stores the Supabase Auth UUID as tex |
| 20260914150000_tighten_function_security.sql | FindBack — tighten function security flagged by the Supabase advisors.  1. findback_uid(): pin an empty search_path (it  |
| 20260914160000_drop_username_login_resolver.sql | FindBack — login is email-only; drop the anonymous username->email resolver.  Block 10B.1 removed username-based login.  |
| 20260914170000_username_availability_lookup.sql | FindBack — anon username availability lookup (Block 10C).  The Register screen checks whether a username is free before  |
| 20260914180000_client_post_reads.sql | FindBack — authenticated post reads straight from Supabase (Block 10D).  Goal: the mobile app reads the feed, a single p |
| 20260914190000_post_mutations.sql | FindBack — direct authenticated post mutations (Block 10E).  Mobile creates and changes the status of its own posts stra |
| 20260914191000_fix_rls_initplan.sql | FindBack — RLS initplan fix for the 10E write policies.  The Supabase performance advisor flags `auth.uid()` called dire |
| 20260914200000_social_client_rpcs.sql | FindBack — direct comments / reactions / ratings (Block 10F).  Mobile no longer calls Node for social features. Everythi |
| 20260914210000_realtime_broadcast.sql | FindBack — Supabase Realtime cutover (Block 10G).  Mobile subscribes to Supabase Realtime Broadcast instead of the Node  |
| 20260914220000_direct_storage_uploads.sql | FindBack — direct Storage uploads (Block 10H).  Mobile normalizes an image on-device and uploads it straight to the publ |
| 20260914230000_enable_pg_graphql.sql | FindBack — enable the Supabase GraphQL API (Block 10I).  Exposes pg_graphql at /graphql/v1. Auth/RLS are unchanged: Post |
| 20260916000000_consume_staging_upload.sql | FindBack - consume the staging upload inside the create-post transaction.  A successful publish previously left its `upl |
| 20260916010000_add_staging_upload_lock_prerequisites.sql | PostgreSQL requires UPDATE privilege and an UPDATE policy for FOR UPDATE. Restrict the grant to the primary key and reje |
| 20260918000000_realtime_change_kind.sql | FindBack — Realtime feed change kinds.  The `feed` topic previously sent `{postId, op}` for item_posts and bare |
| 20260918010000_feed_insert_metadata.sql | FindBack — feed INSERT metadata for honest new-post pills.  The `feed` topic told clients *that* a post was inserted but |
| 20260919000000_validation_alignment.sql | FindBack — validation alignment for create/update (W6 #17, #16).  This migration tightens server-side validation to matc |
| 20260919000001_feed_total_contract.sql | FindBack — feed total contract (#11): total_count is the full filter-matching total BEFORE the keyset cursor is applied. |
| 20260920000000_users_privacy_convergence.sql | FindBack — users privacy convergence (RC Phase B).  Live drift: the hosted project exposes public.users to anon with a b |
| 20260925000000_fix_calendar_date_subscript.sql | FindBack — fix report publishing: invalid text subscripting in the date helper.  20260919000000_validation_alignment.sql |
| 20260926000000_multi_image_report.sql | FindBack — multi-image report support (packet D1, forward-only).  Design (see temp-Com/D1.log.md): extend the existing p |
| 20260926000001_category_expansion.sql | FindBack — additive category taxonomy expansion (Report P3).  STATUS: STAGED PROPOSAL — NOT APPLIED. Owner approval + st |
| 20260928000000_notifications.sql | FindBack — real notifications inbox.  Mobile reads a per-user notification inbox directly from Supabase via narrow |
| 20260929000000_feed_reaction_state_client.sql | FindBack — batched caller reaction/rating hydration for the Home feed (UXN-2).  ADDITIVE ONLY: every existing social RPC |
| 20260930000000_nearby_feed_filter.sql | FindBack — Nearby discovery feed (UXN-1).  Additive ONLY: introduces `findback_query_posts_nearby_client` and touches |
| 20261002000000_notifications_inbox_actions.sql | FindBack — notification inbox actions: read/unread, soft delete, restore.  Extends 20260928000000_notifications.sql. The |
| 20261002010000_notifications_realtime_broadcast.sql | FindBack — private inbox Realtime signal.  When a notification row is inserted the badge/inbox should update without |
| 20261002020000_push_devices_and_preferences.sql | FindBack — push devices, notification preferences, and dispatch marker.  The mobile app registers an FCM device token an |
| 20261002030000_nested_comments.sql | FindBack — nested (threaded) comments.  Adds a self-referential `parent_id` plus a denormalised `depth` so the client |
| 20261002040000_push_reply_tokens.sql | FindBack — device-scoped direct-reply tokens.  When push-dispatch sends a COMMENT notification it mints one short-lived, |
| 20261002050000_push_hardening.sql | FindBack — push hardening: token ownership, atomic reply, retry bookkeeping, and revocation of direct table grants on se |
| 20261002060000_reply_mention_and_read.sql | FindBack — direct-reply fidelity: mention the actor and mark the source read.  The Android notification-shade reply shou |
| 20261006120000_auth_phone_verification_sync.sql | FBA-005: a display phone is editable metadata, never proof of ownership. Preserve email signup and privacy grants. Only  |
| 20261009000000_complete_social_profile.sql | FindBack — social profile completion RPC (W0 staged).  STAGED ONLY. DO NOT APPLY to any database without explicit owner |
| 20261009010000_harden_complete_social_profile_grants.sql | FindBack — harden complete_social_profile grants (post-v1 W0).  Supabase's default privileges grant EXECUTE to anon on e |
| 20261009020000_profile_identity.sql | FindBack — profile identity (post-v1 W1): editable display name / bio / location label, plus the public profile lookup e |
| 20261009030000_reaction_kinds.sql | FindBack — multi-kind reactions (W3.3).  ADDITIVE / NON-DESTRUCTIVE. Widens the reaction vocabulary from the original |
| 20261009040000_profile_prefix_search.sql | FindBack — profile prefix search for @mention autocomplete (post-v1 W3.2).  ADDITIVE ONLY. The Supabase GitHub integrati |
| 20261010000000_profile_avatar.sql | FindBack — profile avatar uploads (post-v1 W1): self-service avatar_url writer plus the ownership-scoped Storage prefix  |
| 20261011000000_reaction_notification_feed.sql | FindBack — W1-A: REACTION notifications + feed reaction truth + attachment order.  ADDITIVE / NON-DESTRUCTIVE. Never edi |
| 20261011010000_reaction_notification_fix.sql | FindBack — W1-A-FIX: kind-keyed REACTION dedupe (follow-up to 20261011000000).  ADDITIVE / NON-DESTRUCTIVE. This file on |
| 20261011020000_comment_attachments_relation.sql | FindBack — typed comment attachment relation (FBX-014).  WHY: comment attachments travelled only as Markdown lines in th |
| 20261011030000_comment_media_bucket_policies.sql | FindBack — dedicated comment media bucket (FBX-013).  WHY: comment attachments are capped client-side at 25 MB |
| 20261011040000_least_privilege_grants.sql | FindBack — least-privilege grants on server-only tables (FBX-034).  WHY: `notifications`, `device_tokens`, `notification |
| 20261012000000_phone_cooldown_avatar_key.sql | FindBack — phone-change cooldown + avatar object-key discipline (W5-IDENTITY).  ADDITIVE ONLY. The Supabase GitHub integ |
| 20261012010000_phone_cooldown_hardening.sql | FindBack — phone-change cooldown hardening (follow-up to 20261012000000).  ADDITIVE ONLY. The Supabase GitHub integratio |
| 20261012020000_comment_attachments_parity.sql | FindBack — comment attachment parity (follow-up to 20261011020000/030000).  ADDITIVE ONLY. The Supabase GitHub integrati |
| 20261012030000_avatar_url_host_bind.sql | FBX-022 server mirror: exact Storage host bind on avatar URL RPCs.  Client (`services/avatar.ts isAvatarStorageUrl`) alr |
| 20261013010000_comment_attachments_update_bind.sql | FindBack — comment attachment UPDATE bind (FB-AUD-03 follow-up to 20261011020000).  SUPERSEDES the comment_attachments_u |
| 20261013020000_comment_media_cleanup_lease.sql | 20261013020000_comment_media_cleanup_lease.sql  ADDITIVE ONLY. Lease/ack redesign for the comment-media cleanup queue |
| 20261014010000_account_deletion_storage_fence.sql | 20261014010000_account_deletion_storage_fence.sql  ADDITIVE ONLY. Account-deletion storage write fence |
| 20261015154642_attachment_dimensions.sql | FindBack - attachment display dimensions end-to-end (CF-060 M1 / IF-101).  Problem: the feed cannot lay out a natural-ra |
| 20261015163718_media_read_grants_and_dims_bound.sql | FindBack - uploaded-media read grants + a dims bound that cannot block a publish (CF-060 M1 repair, from the independent |
| 20261015174749_client_read_grants_invoker_paths.sql | FindBack - close the last two client-read column gaps in the migration chain (REVIEW-M1-REPAIR R1, from the independent  |
| 20261017052000_comment_report_reference.sql | FindBack — typed report reference on comments (CF-060 M2).  WHY: the social composer can attach a photo or a GIF to a co |
| 20261017070000_visibility_kernel_and_blocks.sql | FindBack — B1: the visibility kernel, blocking, and the D21 readers.  WHY THIS FILE EXISTS. FindBack had no way to expre |
| 20261020090000_cf060_r10_feed_block_flag.sql | =========================================================================== CF-060 Residual 10 (1/2: feed/detail/my-repo |
| 20261020090500_cf060_r10_nearby_block_flag.sql | =========================================================================== CF-060 Residual 10 (2/2: nearby reader) — pu |
| 20261021162726_post_saves.sql | FindBack — saved reports (bookmarks): the `post_saves` table and its three client RPCs.  |
| 20261021162730_lock_report_rating_writes.sql | FindBack — close the client report-rating write path.  WHY THIS FILE EXISTS. The app stopped writing a report rating (D1 |
| 20261022103000_post_update_clear_fields.sql | FindBack — an explicit way to CLEAR an optional field on your own report.  WHY THIS FILE EXISTS. |
| 20261022143000_roles_capabilities_invitations.sql | FindBack — roles, the per-moderator capability matrix, email invitations and the one-time admin claim.  |
| 20261022160000_match_candidates_reader.sql | FindBack — the match-candidate reader (CF-060 D40/D41, the CF-050 gate).  WHY THIS FILE EXISTS. |
| 20261022171000_bootstrap_claim_eligibility.sql | FindBack — the admin-claim eligibility question, asked of the server.  WHY THIS FILE EXISTS. |
| 20261022172000_moderation_visibility_privacy_precondition.sql | =========================================================================== FindBack — CF-060 B2a: the moderation-privac |
| 20261022173000_moderation_reports_sanctions_appeals.sql | =========================================================================== FindBack — CF-060 B2a reports + B2b moderati |
| 20261023020000_trust_blocks_feedback_recovery.sql | FindBack — the trust writes: block/unblock, the durable recovery record, participant return ratings, the DERIVED reputat |
| 20261023030000_last_admin_deletion_guard.sql | FindBack — the only admin account cannot be deleted.  The role RPCs already refuse to demote or revoke the last ADMIN |
| 20261023120000_moderation_single_decider.sql | 20261023120000_moderation_single_decider.sql  LIVE-PENDING. This migration has NOT been applied to the hosted project. |
| 20261023190000_post_update_youtube_clear.sql | Forward-only extension of 20261022103000. No applied migration is edited. Same eleven-argument RPC, invoker/RLS/column g |
| 20261023200000_appeal_readers.sql | LIVE-PENDING. ADDITIVE ONLY: two owner-scoped reads; no table grants, policies, writes, changes to existing outcomes, or |
| 20261024010000_comment_isolation.sql | LIVE-PENDING, incomplete local candidate: owner amendment 2026-10-24. Never apply without final integrated review, legac |
| 20261024020000_public_probation.sql | FindBack — public-only probation: 30 days by default, exactly 30 s spacing.  OWNER AMENDMENT 2026-10-24 (supersedes the  |
| 20261024030000_notification_reply_standing.sql | Fix-forward for safety re-audit F2. A notification reply is public activity by the token's author, not a service-role re |
| 20261024040000_public_target_visibility.sql | F1 fix-forward: definer authority must survive every lock wait through the mutation AND aggregate response. Never WAIT o |
| 20261024050000_standing_time.sql | F3 fix-forward: authoritative post-wait time for sanction/day decisions. now() is transaction-start time; clock_timestam |
| 20261024060000_cf050_matching.sql | CF-050: owner-confirmed matching (design revision 5, pre-implementation) report_matches table + propose/confirm/cancel R |
| 20261024070000_r3_chat_foundation.sql | R3 Chat: conversation state machine (REQUEST/CONNECTED/BLOCKED/ENDED) Foundational migration. Full implementation requir |
| 20261024080000_appeals_resolver.sql | Appeals resolver (CF-080): resolution, audit, notifications, reversal/expiry consistency. Foundational migration. Full i |
| 20261024090000_r3_chat_messages.sql | R3 Chat: message sending, read receipts, unsend, delete-for-me Extends 20261024070000_r3_chat_foundation.sql |
| 20261024100000_r3_chat_mailbox.sql | R3 Chat: per-device temporary mailbox, durable idempotent outbox, ACK tracking Extends 20261024090000_r3_chat_messages.s |
| 20261024110000_r3_appeals_notifications.sql | R3 Appeals: notification wiring, expiry handling, reversal consistency Extends 20261024050000_r3_appeals_resolver.sql |
| 20261024120000_cf050_mutual_confirmation.sql | CF-050 refinement: mutual confirmation tracking and recovery handover Extends 20261024060000_cf050_matching.sql Both own |
