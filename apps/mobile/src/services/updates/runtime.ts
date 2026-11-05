/**
 * The app's single update controller instance and its React bindings.
 *
 * One controller per running app: the permanent Updates screen, the optional
 * prompt and Settings all read the same snapshot, so they cannot disagree about
 * whether a newer release exists or about what the last check said.
 *
 * Identity fails closed. The installed release is only known when the platform
 * can supply package, versionCode, owner channel, ABI and SDK. On web there is
 * nothing to install, so it is null. On Android the facts come from the same
 * optional native bridge pattern `buildInfo.ts` already uses — an absent bridge
 * means "not verifiable here", never a guessed channel or ABI.
 */
import { useSyncExternalStore } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { readBuildInfo } from "../buildInfo";
import { createUpdateController } from "./controller";
import type { UpdateController, UpdateSnapshot } from "./controller";
import { createCatalogueSource, localStorageCatalogueCache, parseAndroidCatalogue, DEFAULT_TRUSTED_HOSTS } from "./catalogue";
import bundledCatalogue from "../../../public/updates/catalogue.v1.json";
import type { Installation } from "./types";

/**
 * Public metadata, deployed from this checkout. The bundled copy preserves
 * history offline but never counts as a successful remote check.
 */
export const UPDATE_CATALOGUE_URL =
  "https://findbackapp.social/updates/catalogue.v1.json";

/** Optional native bridge (implemented by the Android update plugin). */
interface NativeUpdateIdentityBridge {
  getIdentity(): Promise<{
    packageName?: string;
    versionCode?: number;
    signingChannel?: string;
    abi?: string;
    sdk?: number;
  }>;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "unknown" ? undefined : trimmed;
}

/**
 * Read the installed identity, or null when any required fact is missing.
 * A missing fact must never be replaced by a default: that would let the
 * catalogue offer bytes this installation cannot verify or accept.
 */
export async function readInstalledIdentity(): Promise<Installation | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const build = await readBuildInfo();
  let native: Awaited<ReturnType<NativeUpdateIdentityBridge["getIdentity"]>>;
  try {
    native = await registerPlugin<NativeUpdateIdentityBridge>("FindBackUpdateIdentity").getIdentity();
  } catch {
    return null;
  }
  const packageName = text(native?.packageName);
  const versionCode = positiveInteger(native?.versionCode) ?? build.versionCode;
  const signingChannel = text(native?.signingChannel);
  const abi = text(native?.abi);
  const sdk = positiveInteger(native?.sdk);
  if (!packageName || versionCode === undefined || !signingChannel || !abi || sdk === undefined) {
    return null;
  }
  return { packageName, versionCode, signingChannel, abi, sdk };
}

let singleton: UpdateController | null = null;

/** The one controller this app runs. Tests call `resetUpdateController`. */
export function updateController(): UpdateController {
  singleton ??= createUpdateController({
    source: createCatalogueSource({
      url: UPDATE_CATALOGUE_URL,
      cache: localStorageCatalogueCache(),
      fallback: parseAndroidCatalogue(bundledCatalogue),
      policy: { packageName: "com.findback.app", trustedHosts: [...DEFAULT_TRUSTED_HOSTS, "findbackapp.social"] },
    }),
    installation: readInstalledIdentity,
    initialIdle: false,
  });
  return singleton;
}

/** Test-only reset so each test file starts from a clean controller. */
export function resetUpdateController(): void {
  singleton = null;
}

export function useUpdateSnapshot(): UpdateSnapshot {
  return useSyncExternalStore(
    subscribeUpdates,
    getUpdateSnapshot,
  );
}

function subscribeUpdates(onChange: () => void): () => void {
  return updateController().subscribe(onChange);
}

function getUpdateSnapshot(): UpdateSnapshot {
  return updateController().getSnapshot();
}

/** Run a check and keep the observable state in sync. */
export async function checkForUpdates(): Promise<UpdateSnapshot> {
  return updateController().check();
}

export async function refreshInstalledUpdates(): Promise<UpdateSnapshot> {
  return updateController().refreshInstalled();
}

export function setUpdatePopupEnabled(enabled: boolean): UpdateSnapshot {
  return updateController().setPopupEnabled(enabled);
}

export function dismissUpdate(releaseId?: string): UpdateSnapshot {
  return updateController().dismiss(releaseId);
}

export function claimUpdatePrompt() {
  return updateController().claimPrompt();
}

export function markUpdateRead(releaseId: string): UpdateSnapshot {
  return updateController().markRead(releaseId);
}

export function setUpdateIdle(idle: boolean): UpdateSnapshot {
  return updateController().setIdle(idle);
}
