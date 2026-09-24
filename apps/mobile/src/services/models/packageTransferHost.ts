import { Capacitor, registerPlugin } from "@capacitor/core";
import type { FbmodelManifest } from "./fbmodelSeam";

export interface ImportPick {
  uri?: string;
  name?: string;
  cancelled?: boolean;
}

export interface InspectedImport {
  inspectionId: string;
  entryId: string;
  packageSha256: string;
  unknown: boolean;
  manifest: FbmodelManifest;
}

export interface ExportFileResult {
  entryId: string;
  fileName: string;
  ok: boolean;
  reason?: string;
}

export type ImportedModelRole = "Text" | "Vision";

export interface ProbeInspectedOptions {
  inspectionId: string;
  role: ImportedModelRole;
  imageUri?: string;
}

export interface ProbeInspectedResult {
  ready: boolean;
  lowMemory: boolean;
  loadMs?: number;
  inferenceMs?: number;
  memoryBeforeMb?: number;
  observedPeakMb?: number;
  reason?: string;
}

export interface CommitInspectedOptions {
  inspectionId: string;
  name?: string;
  description?: string;
  role?: ImportedModelRole;
  keepUnverified?: boolean;
}

export interface ImportedModelRecord {
  entryId: string;
  label: string;
  description?: string | null;
  role: ImportedModelRole;
  state: string;
  bytes: number;
  error?: string | null;
  loadMs?: number | null;
  inferenceMs?: number | null;
  memoryBeforeMb?: number | null;
  observedPeakMb?: number | null;
}

export interface NativeTransferHost {
  pickImportPackage(): Promise<ImportPick>;
  inspectImportPackage(options: { sourceUri: string }): Promise<InspectedImport>;
  commitInspectedPackage(options: { inspectionId: string } & Partial<Omit<CommitInspectedOptions, "inspectionId">>): Promise<{ ok: boolean; entryId: string }>;
  discardInspectedPackage(options: { inspectionId: string }): Promise<void>;
  probeInspectedPackage?(options: ProbeInspectedOptions): Promise<ProbeInspectedResult>;
  getImportedModels?(): Promise<{ models: ImportedModelRecord[] }>;
  deleteImportedModel?(options: { entryId: string }): Promise<void>;
  importPackageFromUri(options: {
    entryId: string;
    sourceUri: string;
    expectedSha256: string;
  }): Promise<{ ok: boolean }>;
  exportSelectedModels(options: { entryIds: string[] }): Promise<{ results: ExportFileResult[] }>;
}

export interface TransferHost {
  pickImport(): Promise<ImportPick>;
  inspect(sourceUri: string): Promise<InspectedImport>;
  commit(inspectionId: string): Promise<{ entryId: string }>;
  commitDetailed(options: CommitInspectedOptions): Promise<{ entryId: string }>;
  probe(options: ProbeInspectedOptions): Promise<ProbeInspectedResult>;
  getImported(): Promise<ImportedModelRecord[]>;
  deleteImported(entryId: string): Promise<void>;
  discard(inspectionId: string): Promise<void>;
  importKnown(entryId: string, sourceUri: string, expectedSha256: string): Promise<void>;
  exportAll(entryIds: string[]): Promise<ExportFileResult[]>;
}

const JOINT_VERIFICATION_NOTE =
  "Native peer method has not landed in this build — needs joint verification with the Android session.";

export function transferHostFrom(native: NativeTransferHost): TransferHost {
  return {
    pickImport: () => native.pickImportPackage(),
    inspect: (sourceUri) => native.inspectImportPackage({ sourceUri }),
    commit: async (inspectionId) => native.commitInspectedPackage({ inspectionId }),
    commitDetailed: async (options) => native.commitInspectedPackage({ ...options }),
    probe: async (options) => {
      if (typeof native.probeInspectedPackage !== "function") {
        throw new Error(`probeInspectedPackage unavailable. ${JOINT_VERIFICATION_NOTE}`);
      }
      return native.probeInspectedPackage(options);
    },
    getImported: async () => {
      if (typeof native.getImportedModels !== "function") return [];
      return (await native.getImportedModels()).models ?? [];
    },
    deleteImported: async (entryId) => {
      if (typeof native.deleteImportedModel !== "function") {
        throw new Error(`deleteImportedModel unavailable. ${JOINT_VERIFICATION_NOTE}`);
      }
      await native.deleteImportedModel({ entryId });
    },
    discard: (inspectionId) => native.discardInspectedPackage({ inspectionId }),
    importKnown: async (entryId, sourceUri, expectedSha256) => {
      await native.importPackageFromUri({ entryId, sourceUri, expectedSha256 });
    },
    exportAll: async (entryIds) => (await native.exportSelectedModels({ entryIds })).results,
  };
}

let cached: TransferHost | null = null;
export function getTransferHost(): TransferHost | null {
  if (Capacitor.getPlatform() !== "android") return null;
  cached ??= transferHostFrom(registerPlugin<NativeTransferHost>("LocalVlm"));
  return cached;
}
