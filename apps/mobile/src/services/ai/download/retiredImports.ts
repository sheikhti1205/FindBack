/** Decode old imports.json only to rediscover/remove bytes; never an import API. */
import { cleanupOnlyDescriptor, type ModelDescriptor, type ModelArtifactFormat } from "../modelDescriptors";
import { safeSourceUrl } from "./sourcePolicy";

export interface LegacyImportRecord { readonly sha256: string; readonly bytes: number; readonly format: ModelArtifactFormat; readonly modality?: "text" | "vision"; readonly license: string; readonly url?: string }
function validateLegacyRecord(input: unknown): LegacyImportRecord {
  const s = input as Partial<LegacyImportRecord> | null;
  if (!s || !/^[a-f0-9]{64}$/.test(s.sha256 ?? "") || !Number.isSafeInteger(s.bytes) || (s.bytes ?? 0) <= 0 || (s.bytes ?? 0) > 4 * 1024 ** 3 ||
      !["gguf", "litertlm", "cact"].includes(s.format ?? "") || (s.modality !== undefined && !["text", "vision"].includes(s.modality)) ||
      (s.modality === "vision" && s.format !== "litertlm") || !s.license?.trim() || s.license.length > 200 || (s.url !== undefined && !safeSourceUrl(s.url))) {
    throw new Error("Import needs supported format, exact SHA-256, positive byte count, license and a public credential-free HTTPS source.");
  }
  return { sha256: s.sha256!, bytes: s.bytes!, format: s.format!, modality: s.modality ?? "text", license: s.license.trim(), ...(s.url ? { url: s.url } : {}) };
}
/** Exact historical path identity, with acquisition and serving disabled. */
function cleanupIdentity(s: LegacyImportRecord): ModelDescriptor {
  return cleanupOnlyDescriptor({
    modelId: `imported-${s.sha256}`, revision: s.sha256, sha256: s.sha256, bytes: s.bytes,
    format: s.format, fileName: `model.${s.format}`, url: s.url ?? "", displayName: "Imported model", consumerTitle: "Imported model",
    consumerDetail: "Remove downloaded files", runtimeId: s.format === "gguf" ? "llamacpp-gguf" : s.format === "cact" ? "needle-cact" : s.modality === "vision" ? "smolvlm2-litertlm" : "qwen3-litertlm-text",
    capabilities: [s.modality === "vision" ? "vision" : "text"], taskRoles: [], maturity: "lab", trust: "imported", license: s.license,
    minRamMb: 2048, recommendedRamMb: 4096, abis: ["arm64-v8a"], deviceQualifiedAbis: [], tier: "advanced", downloadable: false, importable: false,
    untrustedImport: true,
  });
}

export function parseRetiredImportedModels(text: string | null): readonly ModelDescriptor[] {
  try {
    const entries: unknown = JSON.parse(text ?? "[]");
    if (!Array.isArray(entries) || entries.length > 64) return [];
    return entries.map(validateLegacyRecord).map(cleanupIdentity);
  } catch { return []; }
}
