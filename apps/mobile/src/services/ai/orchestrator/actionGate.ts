/**
 * WS1 action gate: validates a raw model proposal (op + args + permissions)
 * and returns a typed allow/deny decision. Fail-closed: anything outside the
 * `PROPOSAL_OPS` allowlist, anything with malformed args, or anything the
 * caller lacks permission for is denied. Deny decisions always carry the
 * caller's `traceId` so allows and denies correlate end to end.
 */
import { isProposalOp, type Proposal } from "./proposals";

export type GateDenyCode =
  | "UNKNOWN_OP"
  | "DESTRUCTIVE_OP"
  | "INVALID_ARGS"
  | "PERMISSION_DENIED"
  | "BAD_TRACE";

/** What the caller may do: signed-in account plus the comment capability. */
export interface GatePermissions {
  readonly accountId: string | null;
  readonly canProposeComments: boolean;
}

export interface GateContext {
  readonly modelId: string;
  readonly traceId: string;
  readonly permissions: GatePermissions;
}

export type GateAllow = {
  readonly decision: "allow";
  readonly proposal: Proposal;
};

export type GateDeny = {
  readonly decision: "deny";
  readonly code: GateDenyCode;
  readonly reason: string;
  readonly traceId: string;
  readonly op?: string;
};

export type GateDecision = GateAllow | GateDeny;

/**
 * Op stems that are never proposable. A non-allowlisted op matching one of
 * these is denied as `DESTRUCTIVE_OP` (explicitly destructive); any other
 * non-allowlisted op is denied as `UNKNOWN_OP`.
 */
const DESTRUCTIVE_STEMS = [
  "publish",
  "edit",
  "status",
  "direct-db",
  "direct_db",
  "directdb",
  "tool",
  "navigate",
  "delete",
  "update",
  "write",
] as const;

const TRACE_ID_MAX = 128;
const REPORT_SLOT_KEYS = ["title", "description", "category", "dateText", "locationNote"] as const;
const TEXT_FIELD_MAX = 2000;
const COMMENT_BODY_MAX = 1000;
const REFERENCE_ID_MAX = 256;

/** Coordinate-like text is never accepted in draft slots (R5). */
const COORDINATE_PATTERN = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Id reference: non-empty, bounded, no whitespace, never inline bytes. */
function isReferenceId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > REFERENCE_ID_MAX) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("data:")) return false;
  if (lower.includes("base64,")) return false;
  return !/\s/.test(trimmed);
}

function isBoundedText(value: unknown, max: number, allowEmpty = false): value is string {
  if (typeof value !== "string") return false;
  if (!allowEmpty && value.trim().length === 0) return false;
  return value.length <= max;
}

function isDestructiveOp(op: string): boolean {
  const lower = op.toLowerCase();
  return DESTRUCTIVE_STEMS.some((stem) => lower.includes(stem));
}

function deny(
  code: GateDenyCode,
  reason: string,
  traceId: string,
  op?: string,
): GateDeny {
  return op === undefined ? { decision: "deny", code, reason, traceId } : { decision: "deny", code, reason, traceId, op };
}

function validateOpenMyReports(args: unknown): boolean {
  return isRecord(args) && Object.keys(args).length === 0;
}

function validateFillReportFields(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const keys = Object.keys(args);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!(REPORT_SLOT_KEYS as readonly string[]).includes(key)) return false;
    const value = args[key];
    if (!isBoundedText(value, TEXT_FIELD_MAX)) return false;
    if (COORDINATE_PATTERN.test(value)) return false;
  }
  return true;
}

function validateProposeComment(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const keys = new Set(Object.keys(args));
  if (keys.size !== 2 || !keys.has("reportId") || !keys.has("body")) return false;
  return isReferenceId(args["reportId"]) && isBoundedText(args["body"], COMMENT_BODY_MAX);
}

function validateAnalyzePhoto(args: unknown): boolean {
  if (!isRecord(args)) return false;
  if (!isReferenceId(args["imageId"])) return false;
  const keys = new Set(Object.keys(args));
  if (keys.size > 2 || keys.size < 1) return false;
  if (!keys.has("imageId")) return false;
  if (keys.has("userContext") && !isBoundedText(args["userContext"], TEXT_FIELD_MAX, true)) {
    return false;
  }
  return true;
}

function validateAnswerHelp(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const keys = Object.keys(args);
  return keys.length === 1 && keys[0] === "question" && isBoundedText(args["question"], TEXT_FIELD_MAX);
}

function hasCommentPermission(permissions: GatePermissions): boolean {
  return permissions.accountId !== null && permissions.canProposeComments;
}

/**
 * Validate raw model output against the allowlist, arg shapes, and caller
 * permissions. Pure and synchronous: no I/O, no side effects.
 */
export function evaluateProposal(raw: unknown, context: GateContext): GateDecision {
  const traceId =
    typeof context.traceId === "string" &&
    context.traceId.trim() !== "" &&
    context.traceId.length <= TRACE_ID_MAX
      ? context.traceId
      : "";
  if (traceId === "") {
    return { decision: "deny", code: "BAD_TRACE", reason: "Missing or malformed traceId.", traceId: "" };
  }
  if (!isRecord(raw) || typeof raw["op"] !== "string") {
    return deny("UNKNOWN_OP", "Proposal carries no recognizable op.", traceId);
  }
  const op = raw["op"];
  const args = raw["args"] ?? {};

  if (!isProposalOp(op)) {
    if (isDestructiveOp(op)) {
      return deny("DESTRUCTIVE_OP", `Op "${op}" is destructive and never proposable.`, traceId, op);
    }
    return deny("UNKNOWN_OP", `Op "${op}" is not in the proposal allowlist.`, traceId, op);
  }

  let argsValid = false;
  if (op === "open_my_reports") argsValid = validateOpenMyReports(args);
  else if (op === "fill_report_fields") argsValid = validateFillReportFields(args);
  else if (op === "propose_comment") argsValid = validateProposeComment(args);
  else if (op === "analyze_photo") argsValid = validateAnalyzePhoto(args);
  else argsValid = validateAnswerHelp(args);

  if (!argsValid) {
    return deny("INVALID_ARGS", `Args for op "${op}" failed validation.`, traceId, op);
  }
  if (op === "propose_comment" && !hasCommentPermission(context.permissions)) {
    return deny(
      "PERMISSION_DENIED",
      "propose_comment requires a signed-in account with comment permission.",
      traceId,
      op,
    );
  }
  return {
    decision: "allow",
    proposal: {
      op,
      args: args as Proposal["args"],
      modelId: context.modelId,
      traceId,
    },
  };
}
