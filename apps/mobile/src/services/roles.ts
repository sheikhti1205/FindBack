/**
 * Roles and moderator capabilities — the ONE client owner of "what may this
 * account do".
 *
 * THE SERVER IS THE AUTHORITY. The role is read from the server
 * (`findback_my_role()`), never from a client-side boolean, a stored flag or a
 * JWT claim: a revoked moderator loses power immediately, because the server
 * re-checks the role and the capability on every privileged call. The UI may
 * hide what the role does not allow, but the refusal is the server's.
 *
 * THE VOCABULARY lives here as well as in the database, because a client that
 * cannot name a capability cannot offer it: the ten moderator-assignable
 * capabilities, and the four admin-only ones (`roles_manage`,
 * `settings_manage`, `data_export`, `data_delete`) that are NEVER offered for
 * a moderator.
 *
 * The owner model this service speaks to (CONTRACT-ROLES-ADMIN-2026-10-22.md):
 * one admin account and one moderator account by default, the admin assigning
 * moderators BY EMAIL, and the admin holding absolute control over what each
 * moderator may do. The default accounts are seeded in the migration; nothing
 * here carries a password, a token or a credential — only an email address, a
 * role and a capability set.
 */
import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";

/** The two roles the server knows. A user with no row is an ordinary user. */
export type AdminRole = "MODERATOR" | "ADMIN";

/** The capabilities a moderator may hold. */
export const MODERATOR_CAPABILITIES = [
  "reports_review",
  "content_hide",
  "content_remove",
  "members_warn",
  "members_restrict",
  "members_suspend",
  "feedback_read",
  "appeals_review",
  "audit_read",
  "matches_confirm",
] as const;

export type ModeratorCapability = (typeof MODERATOR_CAPABILITIES)[number];

/** The capabilities only an admin holds. They are never offered for a moderator. */
export const ADMIN_ONLY_CAPABILITIES = [
  "roles_manage",
  "settings_manage",
  "data_export",
  "data_delete",
] as const;

export type AdminOnlyCapability = (typeof ADMIN_ONLY_CAPABILITIES)[number];

/** Every capability the server knows, in the order the console shows them. */
export const ALL_CAPABILITIES: readonly string[] = [
  ...MODERATOR_CAPABILITIES,
  ...ADMIN_ONLY_CAPABILITIES,
];

/** A human label for a capability id. The raw id is never shown to a reader. */
export const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  reports_review: "Review reports",
  content_hide: "Hide and publish content",
  content_remove: "Remove content",
  members_warn: "Warn members",
  members_restrict: "Restrict posting",
  members_suspend: "Suspend members",
  feedback_read: "Read feedback",
  appeals_review: "Decide appeals",
  audit_read: "Read the activity log",
  matches_confirm: "Confirm possible matches",
  roles_manage: "Manage roles and moderators",
  settings_manage: "Manage app settings",
  data_export: "Export data",
  data_delete: "Delete data",
};

/**
 * The human name of one capability.
 *
 * A raw capability id is never shown to a reader: it is a database word,
 * not a power anybody can picture. An id the app does not know has no
 * honest label, so it is named "Unknown capability" rather than rendered
 * raw.
 */
export function capabilityLabel(id: string): string {
  return CAPABILITY_LABELS[id] ?? "Unknown capability";
}

/** What the server says about the signed-in account. */
export interface MyRole {
  /** The role, or null for an ordinary account. */
  role: AdminRole | null;
  /** True for an admin, who holds every capability. */
  isAdmin: boolean;
  /** The capability ids the account may exercise. */
  capabilities: string[];
}

/** One member of the team. */
export interface RoleAssignment {
  userId: string;
  username: string;
  email: string;
  role: AdminRole;
  capabilities: string[];
  grantedAt: string;
}

/** One email invitation. */
export interface RoleInvitation {
  id: string;
  email: string;
  role: AdminRole;
  capabilities: string[];
  invitedAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/** One row of the append-only activity log. */
export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  previousState: unknown;
  newState: unknown;
  createdAt: string;
}

/** What a grant did: it either landed on an account or waits as an invitation. */
export interface GrantOutcome {
  kind: "account" | "invitation";
  email: string;
  role: AdminRole;
  userId?: string;
}

/** The capability set changed on an assigned account or a live invitation. */
export type CapabilityChangeOutcome =
  | { kind: "account"; email: string; userId: string }
  | { kind: "invitation"; email: string };

/**
 * What the server says about the one-time admin claim.
 *
 * The server is the authority: the app never decides on its own whether this
 * account may claim. `reason` is the server's own sentence when it may not,
 * and it is shown to the reader exactly as the server wrote it.
 */
export interface BootstrapClaimStatus {
  /** May this account make the one-time claim right now? */
  canClaim: boolean;
  /** The server's sentence explaining why not, or null when it may. */
  reason: string | null;
  /** Does THIS account already hold the admin role? */
  alreadyAdmin: boolean;
  /** Does ANY account hold the admin role? The claim is closed then. */
  hasAdmin: boolean;
}

/**
 * The server's refusal is a real answer.
 *
 * `42501` is the server saying "you may not do this" — it is not a network
 * failure and must not be retried blindly. Everything else is a transport or
 * shape problem.
 */
function roleError(message: string, code?: string): ApiError {
  // 42501 is the server's real answer: "you may not do this" (403). A
  // validation refusal (22023) is a bad request (400). Everything else is
  // NOT an answer about the role: a missing function (PGRST202, before the
  // roles migration is applied), a transport failure, a schema mismatch.
  // Those are server troubles, and reporting them as "bad request" would
  // tell the admin their own request was wrong.
  if (code === "42501") return new ApiError(message, 403, code);
  if (code === "22023") return new ApiError(message, 400, code);
  return new ApiError(message, 500, code);
}

/**
 * Only the capabilities the app knows are carried forward.
 *
 * The server is the authority, but the client still refuses to hand a name
 * it cannot label: an unknown capability id would be rendered raw somewhere,
 * and a client that can name a power can offer it. Anything outside the
 * vocabulary is dropped, exactly as a non-string is dropped.
 */
function knownCapabilities(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const known = new Set<string>(ALL_CAPABILITIES);
  return (values as unknown[]).filter(
    (value): value is string => typeof value === "string" && known.has(value),
  );
}

/** The role the server named, or null. An unknown role is never invented. */
function knownRole(value: unknown): AdminRole | null {
  return value === "ADMIN" || value === "MODERATOR" ? value : null;
}

/**
 * The caller's own role and capabilities.
 *
 * Returns an ordinary shape for an ordinary account — no role, no
 * capabilities — rather than an error, so a reader who is not staff is never
 * shown a failure.
 */
export async function fetchMyRole(): Promise<MyRole> {
  const { data, error } = await getSupabase().rpc("findback_my_role", {});
  if (error) throw roleError(error.message, error.code);
  const row = (data ?? {}) as {
    role?: unknown;
    is_admin?: unknown;
    capabilities?: unknown;
  };
  const role = knownRole(row.role);
  const capabilities = knownCapabilities(row.capabilities);
  return {
    role,
    isAdmin: row.is_admin === true || role === "ADMIN",
    capabilities,
  };
}

/** Every role assignment on the team (admin only). */
export async function listRoleAssignments(): Promise<RoleAssignment[]> {
  const { data, error } = await getSupabase().rpc("findback_role_assignments", {});
  if (error) throw roleError(error.message, error.code);
  return ((data ?? []) as Record<string, unknown>[])
    .map((row) => {
      const role = knownRole(row.role);
      if (!role) return null;
      return {
        userId: String(row.user_id ?? ""),
        username: String(row.username ?? ""),
        email: String(row.email ?? ""),
        role,
        capabilities: knownCapabilities(row.capabilities),
        grantedAt: String(row.granted_at ?? ""),
      };
    })
    .filter((row): row is RoleAssignment => row !== null);
}

/** Every email invitation (admin only). */
export async function listRoleInvitations(): Promise<RoleInvitation[]> {
  const { data, error } = await getSupabase().rpc("findback_role_invitations", {});
  if (error) throw roleError(error.message, error.code);
  return ((data ?? []) as Record<string, unknown>[])
    .map((row) => {
      const role = knownRole(row.role);
      if (!role) return null;
      return {
        id: String(row.id ?? ""),
        email: String(row.email ?? ""),
        role,
        capabilities: knownCapabilities(row.capabilities),
        invitedAt: String(row.invited_at ?? ""),
        acceptedAt: typeof row.accepted_at === "string" ? row.accepted_at : null,
        revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
      };
    })
    .filter((row): row is RoleInvitation => row !== null);
}

/**
 * Assign a role by email.
 *
 * The person does not need an account yet: the server keeps the grant as an
 * invitation and attaches it when they sign up. The caller gets back which of
 * the two happened, so the console can say the truth.
 */
export async function grantRole(
  email: string,
  role: AdminRole,
  capabilities: readonly string[] = [],
): Promise<GrantOutcome> {
  const { data, error } = await getSupabase().rpc("findback_role_grant", {
    p_email: email,
    p_role: role,
    p_capabilities: [...capabilities],
  });
  if (error) throw roleError(error.message, error.code);
  const row = (data ?? {}) as { kind?: unknown; email?: unknown; role?: unknown; user_id?: unknown };
  // The server names the outcome. A kind or a role the app does not know is
  // NOT rounded up to "invitation" or "MODERATOR": the console would then
  // show a state the server never reported.
  const kind = row.kind === "account" || row.kind === "invitation" ? row.kind : null;
  if (!kind) {
    throw new ApiError("The server did not say what the grant did.", 500, "UNEXPECTED_SHAPE");
  }
  const grantedRole = knownRole(row.role);
  if (!grantedRole) {
    throw new ApiError("The server did not name the role that was granted.", 500, "UNEXPECTED_SHAPE");
  }
  return {
    kind,
    email: String(row.email ?? email),
    role: grantedRole,
    userId: typeof row.user_id === "string" ? row.user_id : undefined,
  };
}

/** Replace a moderator's capability set and report where it landed (admin only). */
export async function setRoleCapabilities(
  email: string,
  capabilities: readonly string[],
): Promise<CapabilityChangeOutcome> {
  const { data, error } = await getSupabase().rpc("findback_role_set_capabilities", {
    p_email: email,
    p_capabilities: [...capabilities],
  });
  if (error) throw roleError(error.message, error.code);
  const row = (data ?? {}) as { kind?: unknown; email?: unknown; user_id?: unknown };
  if (typeof row.email !== "string" || !row.email.trim()) {
    throw new ApiError("The server did not name the capability-change destination.", 500, "UNEXPECTED_SHAPE");
  }
  if (row.kind === "invitation") return { kind: "invitation", email: row.email };
  if (row.kind === "account" && typeof row.user_id === "string" && row.user_id.trim()) {
    return { kind: "account", email: row.email, userId: row.user_id };
  }
  throw new ApiError("The server did not say where the capability change landed.", 500, "UNEXPECTED_SHAPE");
}

/** Revoke a role or cancel a pending invitation (admin only). */
export async function revokeRole(email: string): Promise<void> {
  const { error } = await getSupabase().rpc("findback_role_revoke", { p_email: email });
  if (error) throw roleError(error.message, error.code);
}

/**
 * The one-time admin claim.
 *
 * The server decides whether the caller may claim it: the address must be in
 * the seeded allowlist and no admin may exist yet. A refusal is a real answer
 * (403), not a failure to report.
 *
 * The server's own sentence SURVIVES: the claim raises a sentence ("An admin
 * already exists", "This account is not in the admin bootstrap list") and
 * that sentence is what the reader must be shown, so it is carried on the
 * error untouched. Only known deliberate claim sentences bypass generic UI
 * errors; database diagnostics never do.
 */
export async function bootstrapAdmin(): Promise<void> {
  const { data, error } = await getSupabase().rpc("findback_bootstrap_admin", {});
  if (error) throw roleError(serverSentence(error), error.code);
  if (data !== true) throw new ApiError("The claim was not confirmed.", 500, "UNEXPECTED_SHAPE");
}

/** Deliberate claim refusals only. Bound to the claim SQL by the parity test. */
const BOOTSTRAP_REFUSALS = [
  "Not authenticated",
  "This account has no email address, so it cannot claim the admin role",
  "Confirm your email address before claiming the admin role",
  "This account is not in the admin bootstrap list",
  "An admin already exists",
];

export function bootstrapRefusalMessage(error: unknown): string | null {
  return error instanceof ApiError &&
    (error.code === "42501" || error.code === "22023" || error.code === "28000") &&
    BOOTSTRAP_REFUSALS.includes(error.message) ? error.message : null;
}

/**
 * The text the server sent, preferring the sentence it raised.
 *
 * PostgREST puts the raised message in `message`; a gateway in front of it
 * may put it in `details` instead. Either way the reader needs the server's
 * sentence, so the first non-empty one is used. An empty text is not an
 * answer, and the role taxonomy turns it into a server fault.
 */
function serverSentence(error: {
  message?: string | null;
  details?: string | null;
}): string {
  const message = typeof error.message === "string" ? error.message.trim() : "";
  if (message) return message;
  return typeof error.details === "string" ? error.details.trim() : "";
}

/**
 * Whether THIS account may make the one-time admin claim right now.
 *
 * The answer comes from the server, which consults the caller's own address,
 * the caller's own confirmed flag and the allowlist — and tells the caller
 * the sentence explaining why not. The client never guesses, and never shows
 * the claim to somebody the server would refuse.
 */
export async function fetchBootstrapClaimStatus(): Promise<BootstrapClaimStatus> {
  const { data, error } = await getSupabase().rpc("findback_bootstrap_claim_status", {});
  if (error) throw roleError(serverSentence(error), error.code);
  const row = (data ?? {}) as {
    can_claim?: unknown;
    reason?: unknown;
    already_admin?: unknown;
    has_admin?: unknown;
  };
  return {
    // Only an explicit true is a yes. A garbled answer is never rounded up to
    // "you may claim".
    canClaim: row.can_claim === true && row.reason === null &&
      row.already_admin === false && row.has_admin === false,
    reason: typeof row.reason === "string" && row.reason.trim() ? row.reason : null,
    alreadyAdmin: row.already_admin === true,
    hasAdmin: row.has_admin === true,
  };
}

/** The append-only activity log (needs the audit_read capability). */
export async function readAuditLog(limit = 100): Promise<AuditEntry[]> {
  const { data, error } = await getSupabase().rpc("findback_audit_log", { p_limit: limit });
  if (error) throw roleError(error.message, error.code);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id ?? ""),
    actorUserId: typeof row.actor_user_id === "string" ? row.actor_user_id : null,
    action: String(row.action ?? ""),
    targetType: String(row.target_type ?? ""),
    targetId: String(row.target_id ?? ""),
    reason: typeof row.reason === "string" ? row.reason : null,
    previousState: row.previous_state ?? null,
    newState: row.new_state ?? null,
    createdAt: String(row.created_at ?? ""),
  }));
}
