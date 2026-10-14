import type { ModelDescriptor, ModelArtifactFormat } from "../modelDescriptors";
import { safeSourceUrl } from "./sourcePolicy";

export interface ImportSpec { readonly sha256: string; readonly bytes: number; readonly format: ModelArtifactFormat; readonly modality?: "text" | "vision"; readonly license: string; readonly fileName?: string; readonly url?: string }
export function validateImportSpec(input: unknown): ImportSpec {
  const s = input as Partial<ImportSpec> | null;
  if (!s || !/^[a-f0-9]{64}$/.test(s.sha256 ?? "") || !Number.isSafeInteger(s.bytes) || (s.bytes ?? 0) <= 0 || (s.bytes ?? 0) > 4 * 1024 ** 3 ||
      !["gguf", "litertlm", "cact"].includes(s.format ?? "") || (s.modality !== undefined && !["text", "vision"].includes(s.modality)) ||
      (s.modality === "vision" && s.format !== "litertlm") || !s.license?.trim() || s.license.length > 200 || (s.url !== undefined && !safeSourceUrl(s.url))) {
    throw new Error("Import needs supported format, exact SHA-256, positive byte count, license and a public credential-free HTTPS source.");
  }
  return { sha256: s.sha256!, bytes: s.bytes!, format: s.format!, modality: s.modality ?? "text", license: s.license.trim(), ...(s.url ? { url: s.url } : {}) };
}
/** Always imported, even if bytes/filename resemble a curated profile. No alias can escalate trust. */
export function importedDescriptor(input: ImportSpec): ModelDescriptor {
  const s = validateImportSpec(input);
  return {
    modelId: `imported-${s.sha256}`, revision: s.sha256, sha256: s.sha256, bytes: s.bytes,
    format: s.format, fileName: `model.${s.format}`, url: s.url ?? "", displayName: "Imported model", consumerTitle: "Imported model",
    consumerDetail: s.sha256.slice(0, 12) + " · evaluation only", runtimeId: s.format === "gguf" ? "llamacpp-gguf" : s.format === "cact" ? "needle-cact" : s.modality === "vision" ? "smolvlm2-litertlm" : "qwen3-litertlm-text",
    capabilities: [s.modality === "vision" ? "vision" : "text"], taskRoles: [], maturity: "lab", trust: "imported", license: s.license,
    minRamMb: 2048, recommendedRamMb: 4096, abis: ["arm64-v8a"], deviceQualifiedAbis: [], tier: "advanced", downloadable: !!s.url, importable: true,
    untrustedImport: true,
  };
}

export function parseImportedCatalogue(text: string | null): readonly ModelDescriptor[] {
  try {
    const entries: unknown = JSON.parse(text ?? "[]");
    if (!Array.isArray(entries) || entries.length > 64) return [];
    return entries.map(validateImportSpec).map(importedDescriptor);
  } catch { return []; }
}
