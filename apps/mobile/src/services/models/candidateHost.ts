import { Capacitor, registerPlugin } from "@capacitor/core";

export interface CandidateState {
  entryId: string;
  state: string;
  installed: boolean;
  sizeBytes: number;
  downloadedBytes: number;
  error?: string;
}

export interface CandidateProbe {
  entryId: string;
  ready: boolean;
  observedOnThisDevice: boolean;
  loadMs: number;
  inferenceMs: number;
  memoryBeforeMb?: number;
  memoryAfterMb?: number;
}

export interface CandidateProgress {
  entryId: string;
  downloadedBytes: number;
  totalBytes: number;
}

export interface CandidateUseProof {
  entryId: string;
  role: "IMAGE" | "TEXT";
  ready: boolean;
  loadMs: number;
}

export interface NativeCandidateHost {
  getCandidateStates(): Promise<{ models: CandidateState[] }>;
  downloadCandidateModel(options: { entryId: string }): Promise<void>;
  pauseCandidateDownload(options: { entryId: string }): Promise<void>;
  cancelCandidateDownload(options: { entryId: string }): Promise<void>;
  verifyCandidateModel(options: { entryId: string; imageUri?: string }): Promise<CandidateProbe>;
  deleteCandidateModel(options: { entryId: string }): Promise<void>;
  useCandidateModel(options: { entryId: string }): Promise<CandidateUseProof>;
  releaseCandidateModel(): Promise<void>;
  /**
   * Active candidate truth. `entryId` is the persisted selection pointer
   * (retained for existing clients); the additive fields are the AI-04/AI-07
   * native follow-up — all optional so older native builds still typecheck,
   * and every absent field reads fail-closed downstream.
   */
  getCandidateActive(): Promise<{
    entryId: string | null;
    selectedEntryId?: string | null;
    installedVerified?: boolean;
    residentEntryId?: string | null;
    initialized?: boolean;
  }>;
  addListener<T extends CandidateState | CandidateProgress>(name: string, listener: (event: T) => void): Promise<{ remove(): void }>;
}

/**
 * Normalized active-candidate truth: the persisted selection pointer plus
 * the installed/resident facts. `installedVerified`, `residentEntryId` and
 * `initialized` describe the genuinely resident initialized engine — never
 * the pointer. A selection that was never activated (cold restart), deleted,
 * or released reads selected-but-not-resident here.
 */
export interface CandidateActiveStatus {
  readonly entryId: string | null;
  readonly selectedEntryId: string | null;
  readonly installedVerified: boolean;
  readonly residentEntryId: string | null;
  readonly initialized: boolean;
}

export interface CandidateHost {
  getStates(): Promise<CandidateState[]>;
  download(entryId: string): Promise<void>;
  pause(entryId: string): Promise<void>;
  cancel(entryId: string): Promise<void>;
  verify(entryId: string, imageUri?: string): Promise<CandidateProbe>;
  delete(entryId: string): Promise<void>;
  use(entryId: string): Promise<CandidateUseProof>;
  releaseUse(): Promise<void>;
  getActive(): Promise<string | null>;
  /**
   * Full selection/residency truth. Optional so older hand-built hosts keep
   * working; callers must fail closed when it is absent (a bare pointer is
   * never residency proof).
   */
  getActiveStatus?(): Promise<CandidateActiveStatus | null>;
  onState(listener: (event: CandidateState) => void): Promise<() => void>;
  onProgress(listener: (event: CandidateProgress) => void): Promise<() => void>;
}

/**
 * Normalizes a raw `getCandidateActive` payload. Absent additive fields fail
 * closed (unverified, not resident). `initialized` only counts when the
 * resident engine is the selected entry — belt-and-braces on top of the
 * native guarantee.
 */
export function normalizeCandidateActiveStatus(
  raw: {
    entryId?: string | null;
    selectedEntryId?: string | null;
    installedVerified?: boolean;
    residentEntryId?: string | null;
    initialized?: boolean;
  } | null | undefined,
): CandidateActiveStatus {
  const selected = raw?.selectedEntryId ?? raw?.entryId ?? null;
  const resident = raw?.residentEntryId ?? null;
  return {
    entryId: raw?.entryId ?? selected,
    selectedEntryId: selected,
    installedVerified: raw?.installedVerified === true,
    residentEntryId: resident,
    initialized: raw?.initialized === true && selected != null && resident === selected,
  };
}

/**
 * True only when `entryId` is genuinely resident: selected, hash-verified on
 * disk, and running as the initialized resident engine. A selection pointer
 * alone (cold restart, deleted bytes, released, verify-evicted) is never
 * enough — that was AI-04/AI-07.
 */
export function isCandidateResidentReady(
  status: CandidateActiveStatus | null | undefined,
  entryId: string,
): boolean {
  if (status == null) return false;
  return (
    status.selectedEntryId === entryId &&
    status.installedVerified === true &&
    status.initialized === true &&
    status.residentEntryId === entryId
  );
}

export function candidateHostFrom(native: NativeCandidateHost): CandidateHost {
  return {
    getStates: async () => (await native.getCandidateStates()).models,
    download: (entryId) => native.downloadCandidateModel({ entryId }),
    pause: (entryId) => native.pauseCandidateDownload({ entryId }),
    cancel: (entryId) => native.cancelCandidateDownload({ entryId }),
    verify: (entryId, imageUri) => native.verifyCandidateModel({ entryId, imageUri }),
    delete: (entryId) => native.deleteCandidateModel({ entryId }),
    use: (entryId) => native.useCandidateModel({ entryId }),
    releaseUse: () => native.releaseCandidateModel(),
    getActive: async () => (await native.getCandidateActive()).entryId,
    getActiveStatus: async () => normalizeCandidateActiveStatus(await native.getCandidateActive()),
    onState: async (listener) => (await native.addListener("candidateStateChange", listener)).remove,
    onProgress: async (listener) => (await native.addListener("candidateDownloadProgress", listener)).remove,
  };
}

let cached: CandidateHost | null = null;
export function getCandidateHost(): CandidateHost | null {
  if (Capacitor.getPlatform() !== "android") return null;
  cached ??= candidateHostFrom(registerPlugin<NativeCandidateHost>("LocalVlm"));
  return cached;
}
