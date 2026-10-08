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
 * - A future text model advertising answer-help → Chat.
 * - A VLM advertising answer-help AND analyze-image → Chat + Vision.
 */
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import { productionModelRegistry } from "./modelDescriptors";
import type { AiTaskId } from "./types";
import type { ModelRecord } from "./providerContract";

export type UiModelRole = "chat" | "vision" | "tools" | "embeddings" | "stt" | "tts";

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
 * Assistant-picker predicate: an offline catalogue row is selectable for chat
 * only when its model id carries a qualified conversational role. Cloud rows
 * are governed by the provider catalogue/consent path, not this predicate.
 */
export function isAssistantSelectableOfflineRecord(record: Pick<ModelRecord, "id" | "provider">): boolean {
  if (record.provider !== "offline") return true;
  return qualifiedUiRolesForOfflineModel(record.id).some(isConversationalUiRole);
}

/**
 * Consumer roles for any catalogue row (assistant picker sections + settings
 * library chips). Offline rows use qualified registry roles. Cloud provider
 * rows are general-purpose conversational products by contract: text-only
 * rows read as Chat, image-capable rows as Chat + Vision.
 */
export function rolesForCatalogRecord(record: Pick<ModelRecord, "id" | "provider" | "input">): readonly UiModelRole[] {
  if (record.provider === "offline") return qualifiedUiRolesForOfflineModel(record.id);
  return record.input.includes("image") ? ["chat", "vision"] : ["chat"];
}

/**
 * Explicit role defaults (master plan §10: no registry-order defaults).
 * Single-candidate roles resolve to their only qualified engine; the
 * multi-candidate matches role stays a persisted user preference
 * (matchesEngine: use | needle).
 */
export const DEFAULT_TOOL_MODEL_ID = NEEDLE_MODEL_ID;
export const DEFAULT_EMBEDDING_MODEL_ID = NEEDLE_MODEL_ID;
