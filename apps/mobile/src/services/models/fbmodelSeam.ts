/**
 * `.fbmodel` import/export seam for Task 28 (Task 26, NEW FILE — SEAM ONLY).
 *
 * Task 26 must NOT build import/export. This module reserves the documented
 * seam the Task-28 importer/exporter will implement: package manifest types,
 * the data-only invariants from `docs/specs/model-library/fbmodel-package.md`,
 * and one pure filename predicate. No file I/O, no ZIP handling, no network.
 */

/** Package filename extension (ZIP container, APPNOTE.TXT-compatible). */
export const FBMODEL_EXTENSION = ".fbmodel" as const;

/** Package manifest version carried inside every `.fbmodel`. */
export const FBMODEL_PACKAGE_VERSION = "1" as const;

/** Compression method per interior file (STORE for weights/projector). */
export type FbmodelCompressionMethod = "STORE" | "DEFLATE";

/** One manifest-listed interior file (the extraction allow-list). */
export interface FbmodelManifestFile {
  /** Interior path, e.g. `weights/model.litertlm` (never absolute). */
  path: string;
  bytes: number;
  sha256: string;
  method: FbmodelCompressionMethod;
}

/** In-package manifest (source of truth for extraction in Task 28). */
export interface FbmodelManifest {
  packageVersion: typeof FBMODEL_PACKAGE_VERSION;
  entryId: string;
  upstream: { repo: string; rev: string; file: string };
  createdAt: string;
  files: FbmodelManifestFile[];
}

/**
 * HARD INVARIANT (fbmodel-package.md §3): data-only packages. These suffixes
 * must never appear in a package; the Task-28 importer rejects by suffix AND
 * by content sniff (magic), since suffixes alone are bypassable.
 */
export const FBMODEL_DENIED_SUFFIXES: readonly string[] = [
  ".so",
  ".dll",
  ".dylib",
  ".dex",
  ".odex",
  ".apk",
  ".aab",
  ".exe",
  ".msi",
  ".sh",
  ".bat",
  ".cmd",
  ".py",
] as const;

/** Magic prefixes the Task-28 importer must sniff for (ELF, MZ, dex). */
export const FBMODEL_DENIED_MAGICS: readonly string[] = [
  "\x7fELF",
  "MZ",
  "dex\n",
] as const;

/**
 * Pure filename check against the denied-suffix list (case-insensitive).
 * Display/validation helper only — not an import implementation.
 */
export function isFbmodelDeniedSuffix(interiorPath: string): boolean {
  const lower = interiorPath.toLowerCase();
  return FBMODEL_DENIED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Task-28 seam: the importer/exporter interface (DECLARED here, IMPLEMENTED
 * in Task 28). Task-26 code must reference this seam type only and must not
 * provide an implementation.
 */
export interface FbmodelPackageSeam {
  /** Task 28: validate + extract a package into the per-model sandbox. */
  importPackage: (args: {
    packagePath: string;
    entryId: string;
  }) => Promise<{ manifest: FbmodelManifest }>;
  /** Task 28: assemble a shareable offline package from installed files. */
  exportPackage: (args: {
    entryId: string;
    outputPath: string;
  }) => Promise<{ packagePath: string }>;
}
