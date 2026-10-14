/**
 * Consumer-facing UI model roles (master plan §8).
 *
 * A MODEL is a downloadable artifact; a UI ROLE is what the consumer can use
 * it for. Roles are a SET, never mutually exclusive: one installed model may
 * be cross-listed (e.g. a qualified general VLM under Chat + Vision).
 *
 * Qualification is evidence-based and derives from the production registry
 * descriptor's taskRoles — never from technical I/O shape. A text-in/text-out
 * engine is NOT a chat model unless a prose task role is advertised.
 *
 * Current qualification:
 * - Needle3 (extract-*, classify-category, embed-texts) → Tools + Embeddings.
 * - SmolVLM2 (analyze-image, ground-objects) → Vision only.
 * - Qwen3 0.6B (answer-help) → Chat only. Structured extraction/
 *   classification runs on Needle's tool schemas, so Qwen does not
 *   advertise the extraction roles.
 * - A VLM advertising answer-help AND analyze-image → Chat + Vision.
 */
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import { productionModelRegistry, QWEN_TEXT_MODEL_ID, SMOL_VISION_MODEL_ID } from "./modelDescriptors";
import type { AiTaskId } from "./types";
import type { ModelRecord, UiModelRole } from "./providerContract";
import { curatedCloudModelName } from "./providers/catalogueQualification";

export type { UiModelRole } from "./providerContract";

/** Roles that can answer the Assistant conversation. Tool/embedding/speech engines cannot. */
export const ASSISTANT_CONVERSATIONAL_ROLES: readonly UiModelRole[] = ["chat", "vision"];

/** Prose task roles: the only task roles that qualify a model for Chat. */
const CHAT_TASK_ROLES: readonly AiTaskId[] = ["answer-help", "summarize-local-context"];

/** Image-understanding task roles qualify a model for Vision. */
const VISION_TASK_ROLES: readonly AiTaskId[] = ["analyze-image", "ground-objects"];

/** Structured-action task roles qualify a model for Tools. */
const TOOL_TASK_ROLES: readonly AiTaskId[] = [
  "extract-report-fields",
  "extract-search-filters",
  "classify-category",
  "classify-intent",
  "route-intent",
];

/** Vector task roles qualify a model for Embeddings. */
const EMBEDDING_TASK_ROLES: readonly AiTaskId[] = ["embed-texts"];

/**
 * Qualified consumer roles for an installed on-device model id. Unknown ids
 * (no registry descriptor, hence no qualification evidence) yield no roles —
 * fail closed, never inferred from input/output modality.
 */
export function qualifiedUiRolesForOfflineModel(modelId: string): readonly UiModelRole[] {
  const descriptor = productionModelRegistry().descriptorFor(modelId);
  if (descriptor === undefined) return [];
  const roles = new Set<UiModelRole>();
  const taskRoles = descriptor.taskRoles;
  if (CHAT_TASK_ROLES.some((task) => taskRoles.includes(task))) roles.add("chat");
  if (VISION_TASK_ROLES.some((task) => taskRoles.includes(task))) roles.add("vision");
  if (TOOL_TASK_ROLES.some((task) => taskRoles.includes(task))) roles.add("tools");
  if (
    EMBEDDING_TASK_ROLES.some((task) => taskRoles.includes(task)) ||
    descriptor.capabilities.includes("embedding") ||
    descriptor.capabilities.includes("matching")
  ) {
    roles.add("embeddings");
  }
  return [...roles];
}

/** True when the role can produce an Assistant conversational answer. */
export function isConversationalUiRole(role: UiModelRole): boolean {
  return role === "chat" || role === "vision";
}

/**
 * Legacy-named Assistant-picker predicate: all rows require conversational
 * qualification. Offline uses the registry; cloud uses adapter-owned roles.
 * Entitlement, consent and message compatibility remain separate gates.
 */
export function isAssistantSelectableOfflineRecord(record: Pick<ModelRecord, "id" | "provider" | "qualifiedRoles">): boolean {
  return rolesForCatalogRecord(record).some(isConversationalUiRole);
}

/**
 * Consumer roles for any catalogue row (assistant picker sections + settings
 * library chips). Offline rows use the live registry, not cached claims.
 * Cloud rows require explicit adapter qualification; I/O proves no role.
 */
export function rolesForCatalogRecord(record: Pick<ModelRecord, "id" | "provider" | "qualifiedRoles"> & Partial<Pick<ModelRecord, "input">>): readonly UiModelRole[] {
  if (record.provider === "offline") return qualifiedUiRolesForOfflineModel(record.id);
  // Persisted rows may predate qualification or have malformed metadata.
  if (!Array.isArray(record.qualifiedRoles) || !record.qualifiedRoles.every(isUiModelRole)) return [];
  return [...new Set(record.qualifiedRoles)];
}

export function isUiModelRole(value: unknown): value is UiModelRole {
  return value === "chat" || value === "vision" || value === "tools" || value === "embeddings" || value === "stt" || value === "tts";
}

/** Shared consumer title for catalogue rows and the Assistant composer chip. */
export function displayNameForCatalogRecord(record: Pick<ModelRecord, "id" | "provider" | "displayName">): string {
  if (record.provider === "offline") {
    const descriptor = productionModelRegistry().descriptorFor(record.id);
    return descriptor?.consumerDetail.trim() || "On-device model";
  }
  const title = typeof record.displayName === "string" ? record.displayName.trim() : "";
  if (title !== "" && title !== record.id) return title;
  return curatedCloudModelName(record.provider, record.id) ?? "Cloud model";
}

/**
 * Explicit role defaults (master plan §10: no registry-order defaults).
 * Single-candidate roles resolve to their only qualified engine; the
 * multi-candidate matches role stays a persisted user preference
 * (matchesEngine: use | needle).
 */
export const DEFAULT_TOOL_MODEL_ID = NEEDLE_MODEL_ID;
export const DEFAULT_EMBEDDING_MODEL_ID = NEEDLE_MODEL_ID;
/**
 * Explicit chat default: Qwen3 0.6B, the first production text engine with
 * an evidence-backed answer-help role. Automatic resolves against installed
 * rows (never catalogue order), so this default applies only when Qwen is
 * installed and verified — otherwise text falls back per the privacy mode.
 */
export const DEFAULT_CHAT_MODEL_ID: string = QWEN_TEXT_MODEL_ID;
export const DEFAULT_VISION_MODEL_ID = SMOL_VISION_MODEL_ID;

export function supportsAssistantMessage(record: ModelRecord, hasImages: boolean): boolean {
  return rolesForCatalogRecord(record).includes(hasImages ? "vision" : "chat");
}

/** Explicit role default, not catalogue order. An unqualified default fails closed. */
export function automaticLocalModel(rows: readonly ModelRecord[], hasImages: boolean): ModelRecord | null {
  const id = hasImages ? DEFAULT_VISION_MODEL_ID : DEFAULT_CHAT_MODEL_ID;
  return rows.find((row) => row.provider === "offline" && row.id === id && supportsAssistantMessage(row, hasImages)) ?? null;
}
