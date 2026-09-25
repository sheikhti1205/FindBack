/**
 * Request assembler: builds a `NormalizedRequest` from trust-layered inputs
 * (packet R1, Context & Memory Contract §1–2).
 *
 * Layer order on every send: app-controlled immutable system policy, current
 * versioned knowledge (rebuilt by the caller each call, never summarized),
 * authorized result references and the per-chat compaction summary (both
 * untrusted data, never instructions), recent verbatim turns, then the
 * current message exactly once. Image and result references are ids only:
 * never bytes, never credentials.
 */
import { hasNoInlineImageBytesOrKeys, isChatCheckpoint } from "./providerContract";
import type {
  AiSelection,
  ChatCheckpoint,
  ChatTurn,
  NormalizedRequest,
  TaskScope,
} from "./providerContract";

export class AssemblerError extends Error {
  constructor(
    readonly code:
      | "missing-policy"
      | "missing-knowledge"
      | "invalid-summary"
      | "invalid-turn"
      | "invalid-text"
      | "invalid-image-id"
      | "invalid-result-id"
      | "invalid-cap"
      | "request-shape",
    message: string,
  ) {
    super(message);
    this.name = "AssemblerError";
  }
}

export type VersionedText = {
  readonly version: string;
  readonly text: string;
};

export type AssemblerInput = {
  readonly selection: AiSelection;
  readonly task: TaskScope;
  readonly systemPolicy: VersionedText;
  readonly knowledge: VersionedText;
  readonly summary?: ChatCheckpoint;
  readonly recentTurns: readonly ChatTurn[];
  readonly currentText: string;
  readonly approvedImageIds: readonly string[];
  readonly authorizedResultIds: readonly string[];
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
};

export type WireLayerKind =
  | "system-policy"
  | "knowledge"
  | "untrusted-result"
  | "untrusted-summary"
  | "recent-turn"
  | "current";

export type WireLayer = {
  readonly layer: WireLayerKind;
  /** System/knowledge are app-controlled; everything else is untrusted data. */
  readonly trust: "system" | "knowledge" | "untrusted-data";
  readonly text: string;
};

function requireVersioned(value: VersionedText, kind: "policy" | "knowledge"): void {
  if (value.version.trim() === "" || value.text.trim() === "") {
    throw new AssemblerError(
      kind === "policy" ? "missing-policy" : "missing-knowledge",
      `Assembler requires a fresh versioned ${kind} on every send.`,
    );
  }
}

function isReferenceId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("data:")) return false;
  if (lower.includes("base64,")) return false;
  return !/\s/.test(trimmed);
}

function requireTurn(turn: ChatTurn, index: number): void {
  if (turn.id.trim() === "" || (turn.role !== "user" && turn.role !== "assistant")) {
    throw new AssemblerError("invalid-turn", `Recent turn ${index} has no stable identity or role.`);
  }
  if (typeof turn.text !== "string") {
    throw new AssemblerError("invalid-turn", `Recent turn ${index} carries no text.`);
  }
  for (const id of turn.attachmentIds) {
    if (!isReferenceId(id)) {
      throw new AssemblerError("invalid-image-id", `Recent turn ${index} carries an inline payload, not a reference.`);
    }
  }
}

/**
 * Describe the trust-layered wire order for one send. Malicious listing,
 * summary, or image text can only ever appear in `untrusted-data` layers;
 * the system layer always carries exactly the app-controlled policy text.
 */
export function buildWireLayers(input: AssemblerInput): WireLayer[] {
  requireVersioned(input.systemPolicy, "policy");
  requireVersioned(input.knowledge, "knowledge");
  if (input.summary !== undefined && !isChatCheckpoint(input.summary)) {
    throw new AssemblerError("invalid-summary", "Compaction summary failed checkpoint validation.");
  }
  input.recentTurns.forEach(requireTurn);

  const layers: WireLayer[] = [
    { layer: "system-policy", trust: "system", text: input.systemPolicy.text },
    { layer: "knowledge", trust: "knowledge", text: input.knowledge.text },
  ];
  for (const id of input.authorizedResultIds) {
    layers.push({ layer: "untrusted-result", trust: "untrusted-data", text: `authorized result reference: ${id}` });
  }
  if (input.summary !== undefined) {
    layers.push({ layer: "untrusted-summary", trust: "untrusted-data", text: input.summary.summaryText });
  }
  for (const turn of input.recentTurns) {
    layers.push({ layer: "recent-turn", trust: "untrusted-data", text: `${turn.role}: ${turn.text}` });
  }
  layers.push({ layer: "current", trust: "untrusted-data", text: input.currentText });
  return layers;
}

/**
 * Build the provider-neutral request. The struct carries only id references;
 * a final shape guard rejects any smuggled credential field or inline bytes.
 */
export function assembleRequest(input: AssemblerInput): NormalizedRequest {
  requireVersioned(input.systemPolicy, "policy");
  requireVersioned(input.knowledge, "knowledge");
  if (
    input.selection.accountId.trim() === "" ||
    input.selection.modelId.trim() === "" ||
    input.selection.provider.trim() === ""
  ) {
    throw new AssemblerError("missing-policy", "Assembler requires an explicit account selection.");
  }
  if (input.currentText.trim() === "") {
    throw new AssemblerError("invalid-text", "Current message must be present exactly once.");
  }
  if (input.summary !== undefined && !isChatCheckpoint(input.summary)) {
    throw new AssemblerError("invalid-summary", "Compaction summary failed checkpoint validation.");
  }
  input.recentTurns.forEach(requireTurn);
  for (const id of input.approvedImageIds) {
    if (!isReferenceId(id)) {
      throw new AssemblerError("invalid-image-id", "Approved images must be reference ids, never bytes.");
    }
  }
  for (const id of input.authorizedResultIds) {
    if (!isReferenceId(id)) {
      throw new AssemblerError("invalid-result-id", "Authorized results must be reference ids, never content.");
    }
  }
  if (!Number.isFinite(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    throw new AssemblerError("invalid-cap", "Output cap must be a positive token count.");
  }

  const request: NormalizedRequest = {
    selection: input.selection,
    task: input.task,
    policyVersion: input.systemPolicy.version,
    knowledgeVersion: input.knowledge.version,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    recentTurns: [...input.recentTurns],
    currentText: input.currentText,
    approvedImageIds: [...input.approvedImageIds],
    authorizedResultIds: [...input.authorizedResultIds],
    maxOutputTokens: Math.floor(input.maxOutputTokens),
    signal: input.signal,
  };
  if (!hasNoInlineImageBytesOrKeys(request)) {
    throw new AssemblerError("request-shape", "Assembled request failed the id-reference shape guard.");
  }
  return request;
}
