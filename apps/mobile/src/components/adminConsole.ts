/**
 * The console's words.
 *
 * ONE place where a role id, a capability id or an audit action becomes
 * something a person can read. The raw ids stay inside the server contract
 * (`services/roles.ts`); the console only ever shows the human label, so a
 * reader never meets `reports_review`, `ROLE_GRANTED` or a raw JSON blob.
 *
 * Everything here is pure: no network, no storage, no state. The four admin
 * surfaces (team, invite, capability editor, activity log) share it so the
 * same permission is never named two different ways.
 */
import {
  ADMIN_ONLY_CAPABILITIES,
  CAPABILITY_LABELS,
  type AuditEntry,
} from "../services/roles";
import { ApiError } from "../services/session";
import { friendlyError } from "../utils/friendlyErrors";

/** What the console calls each role. */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  ADMIN: "Admin",
  MODERATOR: "Moderator",
};

/** The lowercase role word used inside a sentence. */
export function roleWord(role: string | null | undefined): string {
  if (role === "ADMIN") return "admin";
  if (role === "MODERATOR") return "moderator";
  return "";
}

/**
 * A capability id as words.
 *
 * An id the client does not know is never printed raw: it would leak the
 * server's vocabulary onto a consumer surface. It is named neutrally instead.
 */
export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? "Another permission";
}

/** Every capability id as words, in the order given. */
export function capabilityLabels(capabilities: readonly string[]): string[] {
  return capabilities.map(capabilityLabel);
}

/** The permission sentence shown under a person's name. */
export function describeCapabilities(capabilities: readonly string[]): string {
  if (capabilities.length === 0) return "No permissions yet.";
  return capabilityLabels(capabilities).join(", ");
}

/**
 * The permissions that stay with the admin.
 *
 * They are never offered for a moderator — the server refuses them — so the
 * console only names them, as the owner's own language names them.
 */
export function adminOnlySummary(): string {
  return capabilityLabels(ADMIN_ONLY_CAPABILITIES).join(", ");
}

/** The action vocabulary of the append-only log, in plain words. */
const ACTION_WORDS: Readonly<Record<string, string>> = {
  // Role and permission actions.
  BOOTSTRAP_ADMIN: "claimed the admin role",
  ROLE_GRANTED: "gave a role",
  ROLE_INVITED: "prepared an invitation",
  ROLE_REVOKED: "removed a role",
  CAPABILITIES_CHANGED: "changed what someone may do",
  INVITATION_ACCEPTED: "accepted an invitation",
  INVITATION_CAPABILITIES_CHANGED: "changed an invitation's permissions",
  INVITATION_REVOKED: "cancelled an invitation",
  // Moderation actions.
  NO_ACTION: "dismissed a report",
  PUBLISH: "published content",
  HIDE: "hid content",
  REMOVE: "removed content",
  WARN: "warned a member",
  PROBATION: "put a member on probation",
  RESTRICT_POSTING: "restricted a member's posting",
  SUSPEND: "suspended a member",
  BAN: "banned a member",
};

/** One readable line of the activity log. */
export interface ActivityLine {
  /** What happened, in words. Never an action id. */
  headline: string;
  /** The extra line, when there is one worth showing. */
  detail: string | null;
  /** When it happened, in the reader's own time zone. */
  time: string;
}

/** Reads a server state object without trusting its shape. */
function stateOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** The capability ids inside a server state object. */
function capabilitiesOf(state: Record<string, unknown>): string[] {
  const raw = state.capabilities;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/** The email inside a server state object, when it names a person. */
function emailOf(state: Record<string, unknown>, fallback: string): string | null {
  const email = state.email;
  if (typeof email === "string" && email.includes("@")) return email;
  if (fallback.includes("@")) return fallback;
  return null;
}

/**
 * One audit row, said in words.
 *
 * The server stores an action, a target and a JSON state; the reader gets a
 * sentence. A target the server did not name in words (a person id) is left
 * out rather than printed as an id.
 */
export function describeActivity(entry: AuditEntry): ActivityLine {
  const action = entry.action.trim().toUpperCase();
  const verb = ACTION_WORDS[action] ?? "changed something";
  const previous = stateOf(entry.previousState);
  const next = stateOf(entry.newState);
  const target = emailOf(next, "") ?? emailOf(previous, "") ?? (entry.targetId.includes("@") ? entry.targetId : null);
  const role = typeof next.role === "string" ? next.role : typeof previous.role === "string" ? previous.role : null;
  const word = roleWord(role);

  let headline: string;
  let detail: string | null = null;

  switch (action) {
    case "ROLE_GRANTED":
      headline = target
        ? `Gave ${target} ${word || "staff"} access`
        : "Gave a role";
      detail = permissionDetail(capabilitiesOf(next));
      break;
    case "ROLE_INVITED":
      headline = target
        ? `Invited ${target} to join as ${word || "a moderator"}`
        : "Prepared an invitation";
      detail = permissionDetail(capabilitiesOf(next));
      break;
    case "ROLE_REVOKED":
      headline = target
        ? `Removed ${word || "staff"} access from ${target}`
        : "Removed a role";
      detail = "Access ended immediately.";
      break;
    case "CAPABILITIES_CHANGED": {
      headline = target
        ? `Changed what ${target} may do`
        : "Changed what a moderator may do";
      detail = changedPermissionsDetail(capabilitiesOf(previous), capabilitiesOf(next));
      break;
    }
    case "INVITATION_ACCEPTED":
      headline = target
        ? `${target} joined as ${word || "a moderator"}`
        : "An invitation was accepted";
      break;
    case "INVITATION_REVOKED":
      headline = target ? `Cancelled the invitation for ${target}` : "Cancelled an invitation";
      break;
    case "INVITATION_CAPABILITIES_CHANGED":
      headline = target
        ? `Changed the permissions in the invitation for ${target}`
        : "Changed the permissions in an invitation";
      detail = permissionDetail(capabilitiesOf(next));
      break;
    case "BOOTSTRAP_ADMIN":
      headline = target ? `${target} claimed the admin role` : "The admin role was claimed";
      detail = "The first admin account. This can only happen once.";
      break;
    default:
      headline = target ? `${verb} (${target})` : verb;
      detail = null;
  }

  return { headline, detail, time: formatActivityTime(entry.createdAt) };
}

/** "Review reports, Hide and publish content" — the permissions held now. */
function permissionDetail(capabilities: readonly string[]): string {
  if (capabilities.length === 0) return "No permissions.";
  return `Permissions: ${capabilityLabels(capabilities).join(", ")}.`;
}

/** What the change actually did, in words. */
function changedPermissionsDetail(
  previous: readonly string[],
  next: readonly string[],
): string | null {
  const added = next.filter((item) => !previous.includes(item));
  const removed = previous.filter((item) => !next.includes(item));
  const parts: string[] = [];
  if (added.length > 0) parts.push(`Added: ${capabilityLabels(added).join(", ")}.`);
  if (removed.length > 0) parts.push(`Removed: ${capabilityLabels(removed).join(", ")}.`);
  if (parts.length === 0) return null;
  return parts.join(" ");
}

/**
 * A moment in the reader's own time zone.
 *
 * An unreadable timestamp returns an empty string: the row then shows no
 * time at all rather than a wrong one.
 */
export function formatActivityTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The server's refusal is a real answer.
 *
 * A refusal (403) is shown as the sentence the admin needs, not as a crash and
 * not as a raw database message. Everything else goes through the house's
 * error taxonomy so no backend jargon reaches the screen.
 */
export function adminErrorMessage(error: unknown, refusal: string): string {
  if (error instanceof ApiError && error.status === 403) return refusal;
  return friendlyError(error).message;
}
