/**
 * S8 update controller: one observable truth for "is there a newer release",
 * "may we interrupt", and "what do we know".
 *
 * The rules that shape it:
 *
 * - The permanent Updates row/history is always available; the unsolicited
 *   popup is opt-in (default off), idle-only, and never covers a release the
 *   reader already dismissed. No forced reload, countdown or blocker.
 * - The prompt slot holds ONE release: the current eligible, unseen, opt-in
 *   release. When a newer release becomes eligible, the older pending prompt is
 *   simply gone — there is nothing to clean up because the prompt is derived,
 *   not queued in mutable state.
 * - Installed identity comes only from the installation port. Finishing a
 *   download or an install job is not evidence that the new build is running,
 *   so nothing here can claim "installed" from job completion.
 * - A failed check is a failure, not "up to date". History keeps the last
 *   known-good catalogue so the row still works offline.
 */
import { selectInstallableRelease } from "./catalogue";
import type { CatalogueCheck } from "./catalogue";
import { createCatalogueSource } from "./catalogue";
import type { AndroidCatalogue, AndroidRelease, Installation, ReleaseHistoryRecord, FeatureAnnouncement } from "./types";
import { dismissRelease, dismissalHistoryReadable, isReleaseDismissed, loadDismissedReleases, loadUpdatePreferences, saveUpdatePreferences } from "./preferences";
import type { UpdateStorage } from "./preferences";
import { loadSeenReleases, markReleaseSeen, seenHistoryReadable } from "./preferences";

export type UpdateCheckFailure = Extract<CatalogueCheck, { status: "error" }>["code"];

export interface UpdateCheckRecord {
  /** When the check was attempted (wall clock, this session or last). */
  readonly attemptedAt: number;
  readonly status: "ok" | "cached" | "error";
  /** Present only when `status` is "error". */
  readonly code?: UpdateCheckFailure;
  /** When the payload was actually fetched; null when nothing is known. */
  readonly checkedAt: number | null;
}

export interface UpdateSnapshot {
  /** Installed identity, or null when it cannot be verified on this platform. */
  readonly installed: Installation | null;
  /** The newer release this installation may install, if any. */
  readonly eligible: AndroidRelease | null;
  /** The release an unsolicited prompt may show RIGHT NOW, or null. */
  readonly pending: AndroidRelease | null;
  readonly popupEnabled: boolean;
  readonly dismissed: readonly string[];
  readonly seen?: readonly string[];
  readonly lastCheck: UpdateCheckRecord | null;
  /** Last known-good catalogue releases, newest first. Available offline. */
  readonly history: readonly (AndroidRelease | ReleaseHistoryRecord)[];
  readonly features?: readonly FeatureAnnouncement[];
  readonly idle: boolean;
  /** True while a check is in flight. */
  readonly checking: boolean;
}

export interface UpdateCataloguePort {
  /** `force` bypasses the background rate limit; it never bypasses backoff. */
  check(force?: boolean): Promise<CatalogueCheck>;
}

export interface UpdateControllerOptions {
  readonly source: UpdateCataloguePort;
  /**
   * Reads the installed identity. Resolve null when the platform cannot supply
   * package/ABI/SDK facts (e.g. web) — that fails closed: no update is offered.
   */
  readonly installation: () => Promise<Installation | null>;
  readonly storage?: UpdateStorage;
  readonly now?: () => number;
  /** Defaults to idle; the host reports busy Auth/editor/upload/modal states. */
  readonly initialIdle?: boolean;
  /** Android proposes updates on launch unless the reader explicitly opts out. */
  readonly defaultPopupEnabled?: boolean;
}

export interface UpdateController {
  getSnapshot(): UpdateSnapshot;
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void;
  check(force?: boolean): Promise<UpdateSnapshot>;
  /** Re-read the installed identity (after a real install, never from a job). */
  refreshInstalled(): Promise<UpdateSnapshot>;
  setPopupEnabled(enabled: boolean): UpdateSnapshot;
  setIdle(idle: boolean): UpdateSnapshot;
  /** Durable dismissal of the current release; clears the pending prompt. */
  dismiss(releaseId?: string): UpdateSnapshot;
  /** Write-ahead seen receipt: never open an unsolicited notice without it. */
  claimPrompt(): AndroidRelease | null;
  markRead(releaseId: string): UpdateSnapshot;
}

function newestFirst(releases: readonly (AndroidRelease | ReleaseHistoryRecord)[]): readonly (AndroidRelease | ReleaseHistoryRecord)[] {
  return [...releases].sort(
    (a, b) => b.publishedAt.localeCompare(a.publishedAt),
  );
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const now = options.now ?? (() => Date.now());
  const storage = options.storage;
  const listeners = new Set<(snapshot: UpdateSnapshot) => void>();

  let popupEnabled = loadUpdatePreferences(storage, options.defaultPopupEnabled).popupEnabled;
  let dismissed = loadDismissedReleases(storage);
  let seen = loadSeenReleases(storage);
  let installed: Installation | null = null;
  let catalogue: AndroidCatalogue | null = null;
  let lastCheck: UpdateCheckRecord | null = null;
  let idle = options.initialIdle ?? true;
  let checking = false;
  let inFlight: Promise<UpdateSnapshot> | null = null;

  function derive(): UpdateSnapshot {
    const eligible =
      catalogue === null || installed === null
        ? null
        : selectInstallableRelease(catalogue, installed);
    const pending =
      popupEnabled && idle && !checking && lastCheck?.status !== "error" && eligible !== null && !dismissed.includes(eligible.id) && !seen.includes(eligible.id)
        ? eligible
        : null;
    return Object.freeze({
      installed,
      eligible,
      pending,
      popupEnabled,
      dismissed,
      seen,
      lastCheck,
      history: catalogue === null ? [] : newestFirst([...catalogue.releases, ...(catalogue.history ?? [])]),
      features: catalogue?.features ?? [],
      idle,
      checking,
    });
  }

  // React's external-store contract requires stable identity between writes.
  let snapshot = derive();
  function emit(): UpdateSnapshot {
    snapshot = derive();
    for (const listener of [...listeners]) listener(snapshot);
    return snapshot;
  }

  const controller: UpdateController = {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },

    check(force = false) {
      if (inFlight !== null) return inFlight;
      checking = true;
      emit();
      inFlight = (async () => {
        let result: CatalogueCheck;
        try {
          result = await options.source.check(force);
        } catch {
          // The port is documented not to throw; if it does, that is still a
          // failed check, never a silent "up to date".
          result = {
            status: "error",
            code: "offline",
            catalogue: catalogue,
            checkedAt: lastCheck?.checkedAt ?? null,
          };
        }
        const attemptedAt = now();
        if (result.status === "error") {
          // Keep the previously known catalogue: history stays readable and the
          // failure is reported truthfully.
          catalogue = result.catalogue ?? catalogue;
          lastCheck = {
            attemptedAt,
            status: "error",
            code: result.code,
            checkedAt: result.checkedAt,
          };
        } else {
          catalogue = result.catalogue;
          lastCheck = {
            attemptedAt,
            status: result.status,
            checkedAt: result.checkedAt,
          };
        }
        checking = false;
        inFlight = null;
        return emit();
      })();
      return inFlight;
    },

    async refreshInstalled() {
      try {
        installed = await options.installation();
      } catch {
        installed = null;
      }
      return emit();
    },

    setPopupEnabled(enabled) {
      popupEnabled = saveUpdatePreferences({ popupEnabled: enabled }, storage).popupEnabled;
      return emit();
    },

    setIdle(next) {
      if (idle === next) return snapshot;
      idle = next;
      return emit();
    },

    dismiss(releaseId) {
      const target = releaseId ?? snapshot.pending?.id ?? snapshot.eligible?.id;
      if (target === undefined) return snapshot;
      dismissed = [...new Set([...dismissed, ...dismissRelease(target, storage)])];
      return emit();
    },

    claimPrompt() {
      const release = snapshot.pending;
      if (!release) return null;
      if (!dismissalHistoryReadable(storage) || !seenHistoryReadable(storage)) {
        popupEnabled = false; emit(); return null;
      }
      if (isReleaseDismissed(release.id, storage) || loadSeenReleases(storage).includes(release.id)) {
        dismissed = [...new Set([...dismissed, ...loadDismissedReleases(storage)])];
        seen = [...new Set([...seen, ...loadSeenReleases(storage)])];
        emit(); return null;
      }
      seen = [...new Set([...seen, ...markReleaseSeen(release.id, storage)])];
      const durable = loadSeenReleases(storage).includes(release.id);
      // No write receipt means no interruption; history remains available.
      if (!durable) popupEnabled = false;
      emit();
      return durable ? release : null;
    },

    markRead(releaseId) {
      if (seen.includes(releaseId)) return snapshot;
      seen = [...new Set([...seen, ...markReleaseSeen(releaseId, storage)])];
      return emit();
    },
  };

  return controller;
}

/** Convenience factory for the app: a catalogue source plus the identity port. */
export function createAppUpdateController(input: {
  readonly catalogueUrl: string;
  readonly cache?: Parameters<typeof createCatalogueSource>[0]["cache"];
  readonly installation: () => Promise<Installation | null>;
  readonly storage?: UpdateStorage;
  readonly initialIdle?: boolean;
}): UpdateController {
  const source = createCatalogueSource({
    url: input.catalogueUrl,
    cache: input.cache,
  });
  return createUpdateController({
    source,
    installation: input.installation,
    storage: input.storage,
    initialIdle: input.initialIdle,
  });
}
