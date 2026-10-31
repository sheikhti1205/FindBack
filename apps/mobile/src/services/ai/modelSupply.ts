/**
 * Acquisition helpers for retained model artifacts.
 *
 * Only the pieces the download lifecycle needs: artifact identity, byte
 * totals, mirror validation, and source ordering. There is no supply
 * catalogue here — the retained local tools are a closed, curated set owned
 * by the descriptor registry.
 */
import type { ModelDescriptor } from "./modelDescriptors";
import { safeSourceUrl } from "./download/sourcePolicy";

export type ArtifactMirrors = Readonly<Record<string, string>>;

export interface ModelArtifact {
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
  readonly sources?: readonly string[];
}

export function acquisitionArtifacts(d: ModelDescriptor): readonly ModelArtifact[] { return [d, ...(d.companions ?? [])]; }
export function acquisitionBytes(d: ModelDescriptor): number { return acquisitionArtifacts(d).reduce((n, f) => n + f.bytes, 0); }

export function validateArtifactMirrors(d: ModelDescriptor, mirrors: ArtifactMirrors): void {
  const files = new Set(acquisitionArtifacts(d).map((file) => file.fileName));
  for (const [fileName, url] of Object.entries(mirrors)) {
    if (!files.has(fileName) || !safeSourceUrl(url)) throw new Error("Mirror configuration needs a known artifact and a public credential-free HTTPS URL.");
  }
}

export function sourcesFor(d: ModelArtifact, mirror?: string): readonly string[] {
  const defaults = d.sources ?? (d.url.startsWith("https://huggingface.co/") ? [d.url, d.url + "?download=true", d.url.replace("huggingface.co", "hf.co")] : [d.url]);
  return mirror ? [...new Set([mirror, ...defaults])].slice(0, 4) : defaults;
}
