import type { ModelCatalogueEntry } from "./catalogueTypes";
import { isInstallable } from "./modelCatalogue";
import {
  bridgeModelIdForEntry,
  hasUnpublishedDistribution,
  isDistributionPublished,
} from "./shippedCatalogue";
import { isInstalledState, type VlmState } from "../vlmPlugin";

export interface LibraryRuntimeState {
  entryId: string;
  role: "TEXT" | "IMAGE" | "INFORMATION_ONLY";
  installed: boolean;
  verified: boolean;
  ready: boolean;
  active: boolean;
  canImport: boolean;
  canDownload: boolean;
  canDelete: boolean;
  canExport: boolean;
  canSelfTest: boolean;
  error?: string;
}

export function libraryRoleForEntry(
  entry: ModelCatalogueEntry,
): LibraryRuntimeState["role"] {
  if (entry.catalogOnly === true || entry.role === "catalog-reference") {
    return "INFORMATION_ONLY";
  }
  if (entry.role === "chat-text") return "TEXT";
  if (entry.role === "report-from-photo") return "IMAGE";
  return "INFORMATION_ONLY";
}

export interface LibraryRuntimeSignals {
  isActive: boolean;
  imageState?: VlmState | null;
  textInstalled?: boolean;
  textReady?: boolean;
  textRuntimePresent?: boolean;
  error?: string;
}

function staticInformationOnly(
  entry: ModelCatalogueEntry,
): LibraryRuntimeState {
  return {
    entryId: entry.id,
    role: "INFORMATION_ONLY",
    installed: false,
    verified: false,
    ready: false,
    active: false,
    canImport: false,
    canDownload: false,
    canDelete: false,
    canExport: false,
    canSelfTest: false,
  };
}

export function deriveLibraryRuntimeState(
  entry: ModelCatalogueEntry,
  signals: LibraryRuntimeSignals,
): LibraryRuntimeState {
  const role = libraryRoleForEntry(entry);
  if (role === "INFORMATION_ONLY") return staticInformationOnly(entry);
  const hasPin = entry.sha256 != null;
  const published = isDistributionPublished(entry);
  const unpublished = hasUnpublishedDistribution(entry);
  const active = signals.isActive;
  const error = signals.error;

  if (role === "TEXT") {
    const installed = signals.textInstalled ?? false;
    const textReady = signals.textReady ?? false;
    const textRuntimePresent = signals.textRuntimePresent ?? false;
    const verified = installed;
    const ready = installed && textReady;
    const installable = isInstallable(entry);
    const canDownload = installable && published && textRuntimePresent;
    const canImport = entry.catalogOnly !== true && hasPin;
    const canExport = entry.catalogOnly !== true && hasPin;
    const canDelete = installed;
    const canSelfTest = installed && textRuntimePresent;
    const state: LibraryRuntimeState = {
      entryId: entry.id,
      role,
      installed,
      verified,
      ready,
      active,
      canImport,
      canDownload,
      canDelete,
      canExport,
      canSelfTest,
    };
    if (unpublished) state.canDownload = false;
    if (error != null) state.error = error;
    return state;
  }

  const imageState = signals.imageState ?? null;
  const installed =
    imageState != null && isInstalledState(imageState);
  const verified = imageState === "READY_GPU";
  const ready = verified;
  const bridgeIdPresent = bridgeModelIdForEntry(entry.id) != null;
  const installable = isInstallable(entry);
  const canDownload = bridgeIdPresent && installable && published;
  const canImport = entry.catalogOnly !== true && hasPin;
  const canExport = entry.catalogOnly !== true && hasPin;
  const canDelete = installed;
  const canSelfTest =
    imageState === "INSTALLED_UNVERIFIED" ||
    imageState === "READY_GPU" ||
    imageState === "GPU_UNAVAILABLE" ||
    imageState === "RUNTIME_ERROR";
  const state: LibraryRuntimeState = {
    entryId: entry.id,
    role,
    installed,
    verified,
    ready,
    active,
    canImport,
    canDownload,
    canDelete,
    canExport,
    canSelfTest,
  };
  if (error != null) state.error = error;
  return state;
}
