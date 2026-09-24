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

export interface NativeCandidateHost {
  getCandidateStates(): Promise<{ models: CandidateState[] }>;
  downloadCandidateModel(options: { entryId: string }): Promise<void>;
  pauseCandidateDownload(options: { entryId: string }): Promise<void>;
  cancelCandidateDownload(options: { entryId: string }): Promise<void>;
  verifyCandidateModel(options: { entryId: string; imageUri?: string }): Promise<CandidateProbe>;
  deleteCandidateModel(options: { entryId: string }): Promise<void>;
  addListener<T extends CandidateState | CandidateProgress>(name: string, listener: (event: T) => void): Promise<{ remove(): void }>;
}

export interface CandidateHost {
  getStates(): Promise<CandidateState[]>;
  download(entryId: string): Promise<void>;
  pause(entryId: string): Promise<void>;
  cancel(entryId: string): Promise<void>;
  verify(entryId: string, imageUri?: string): Promise<CandidateProbe>;
  delete(entryId: string): Promise<void>;
  onState(listener: (event: CandidateState) => void): Promise<() => void>;
  onProgress(listener: (event: CandidateProgress) => void): Promise<() => void>;
}

export function candidateHostFrom(native: NativeCandidateHost): CandidateHost {
  return {
    getStates: async () => (await native.getCandidateStates()).models,
    download: (entryId) => native.downloadCandidateModel({ entryId }),
    pause: (entryId) => native.pauseCandidateDownload({ entryId }),
    cancel: (entryId) => native.cancelCandidateDownload({ entryId }),
    verify: (entryId, imageUri) => native.verifyCandidateModel({ entryId, imageUri }),
    delete: (entryId) => native.deleteCandidateModel({ entryId }),
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
