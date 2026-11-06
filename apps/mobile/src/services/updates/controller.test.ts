import { describe, expect, it, vi } from "vitest";
import { createUpdateController } from "./controller";
import type { UpdateCataloguePort } from "./controller";
import type { AndroidArtifact, AndroidCatalogue, AndroidRelease, Installation } from "./types";

const SIGNER = "ab".repeat(32);
const COMMIT = "a".repeat(40);

function artifact(overrides: Partial<AndroidArtifact> = {}): AndroidArtifact {
  return {
    url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/Norfold-arm64-v8a.apk",
    bytes: 80_000_000,
    sha256: "1".repeat(64),
    packageName: "com.findback.app",
    signingChannel: "beta",
    signerSha256: SIGNER,
    abis: ["arm64-v8a"],
    minSdk: 24,
    targetSdk: 36,
    ...overrides,
  };
}

function release(overrides: Partial<AndroidRelease> = {}): AndroidRelease {
  return {
    id: "v0.15.0-beta.1",
    platform: "android",
    versionName: "0.15.0-beta.1",
    versionCode: 15001,
    gitSha: COMMIT,
    tag: "v0.15.0-beta.1",
    publishedAt: "2026-11-04T00:00:00Z",
    summary: "Synthetic test release",
    accepted: true,
    artifacts: [artifact()],
    ...overrides,
  };
}

function catalogue(...releases: AndroidRelease[]): AndroidCatalogue {
  return { releases };
}

function installation(overrides: Partial<Installation> = {}): Installation {
  return {
    packageName: "com.findback.app",
    versionCode: 14001,
    signingChannel: "beta",
    abi: "arm64-v8a",
    sdk: 35,
    ...overrides,
  };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function source(result: Awaited<ReturnType<UpdateCataloguePort["check"]>>) {
  const check = vi.fn(async () => result);
  return { check } satisfies UpdateCataloguePort;
}

function build(
  options: {
    result?: Awaited<ReturnType<UpdateCataloguePort["check"]>>;
    installed?: Installation | null;
    storage?: ReturnType<typeof memoryStorage>;
    initialIdle?: boolean;
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const catalogueSource = source(
    options.result ?? { status: "ok", catalogue: catalogue(release()), checkedAt: 1_000 },
  );
  const installationPort = vi.fn(async () =>
    options.installed === undefined ? installation() : options.installed,
  );
  const controller = createUpdateController({
    source: catalogueSource,
    installation: installationPort,
    storage,
    now: () => 2_000,
    initialIdle: options.initialIdle ?? true,
  });
  return { controller, catalogueSource, installationPort, storage };
}

describe("update controller — passive by default", () => {
  it("can propose Android launch updates by default without overriding an explicit opt-out", async () => {
    const storage=memoryStorage();
    const buildAndroid=()=>createUpdateController({source:source({status:"ok",catalogue:catalogue(release()),checkedAt:1000}),installation:async()=>installation(),storage,defaultPopupEnabled:true});
    const first=buildAndroid();
    await first.refreshInstalled();await first.check(true);
    expect(first.getSnapshot().pending?.id).toBe("v0.15.0-beta.1");
    first.setPopupEnabled(false);
    const second=buildAndroid();await second.refreshInstalled();await second.check(true);
    expect(second.getSnapshot().pending).toBeNull();
  });
  it("keeps the same snapshot identity until the store changes", () => {
    const { controller } = build();
    const initial = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(initial);
    controller.setIdle(initial.idle);
    expect(controller.getSnapshot()).toBe(initial);
    controller.setPopupEnabled(true);
    const changed = controller.getSnapshot();
    expect(changed).not.toBe(initial);
    expect(controller.getSnapshot()).toBe(changed);
  });
  it("forwards a forced check to the catalogue source", async () => {
    const { controller, catalogueSource } = build();
    await controller.check(true);
    expect(catalogueSource.check).toHaveBeenCalledWith(true);
    await controller.check();
    expect(catalogueSource.check).toHaveBeenLastCalledWith(false);
  });
  it("never prompts unless the reader opted in", async () => {
    const { controller } = build();
    await controller.refreshInstalled();
    const snapshot = await controller.check();
    expect(snapshot.popupEnabled).toBe(false);
    expect(snapshot.eligible?.id).toBe("v0.15.0-beta.1");
    // The permanent row can still show the eligible release...
    expect(snapshot.eligible).not.toBeNull();
    // ...but nothing may interrupt.
    expect(snapshot.pending).toBeNull();
  });

  it("prompts once opted in, and only while idle", async () => {
    const { controller } = build({ initialIdle: false });
    await controller.refreshInstalled();
    controller.setPopupEnabled(true);
    await controller.check();
    // Busy (Auth/editor/upload/modal/download): queued, not shown.
    expect(controller.getSnapshot().pending).toBeNull();
    const shown = controller.setIdle(true);
    expect(shown.pending?.id).toBe("v0.15.0-beta.1");
  });

  it("returns to a quiet state as soon as the app is busy again", async () => {
    const { controller } = build();
    await controller.refreshInstalled();
    controller.setPopupEnabled(true);
    await controller.check();
    expect(controller.getSnapshot().pending).not.toBeNull();
    expect(controller.setIdle(false).pending).toBeNull();
  });
});

describe("update controller — dismissal survives restarts and rechecks", () => {
  it("keeps read history separate from dismissal even when notices were disabled", async () => {
    const storage = memoryStorage();
    const controller = build({ storage }).controller;
    await controller.refreshInstalled(); await controller.check();
    controller.markRead("v0.15.0-beta.1");
    expect(controller.getSnapshot().dismissed).toEqual([]);
    controller.setPopupEnabled(true);
    expect(controller.getSnapshot().pending).toBeNull();
    const restarted = build({ storage }).controller;
    await restarted.refreshInstalled(); await restarted.check();
    expect(restarted.getSnapshot().pending).toBeNull();
  });
  it("does not claim a stale notice another controller already consumed", async () => {
    const storage = memoryStorage();
    const a = build({ storage }).controller, b = build({ storage }).controller;
    for (const controller of [a, b]) {
      await controller.refreshInstalled(); controller.setPopupEnabled(true); await controller.check();
    }
    expect(a.claimPrompt()).not.toBeNull();
    expect(b.claimPrompt()).toBeNull();
  });
  it("suppresses notices rather than overwriting unreadable dismissal history", async () => {
    const storage = memoryStorage();
    const controller = build({ storage }).controller;
    await controller.refreshInstalled(); controller.setPopupEnabled(true); await controller.check();
    storage.setItem("findback.updates.dismissed.v1", "{corrupt");
    expect(controller.claimPrompt()).toBeNull();
    expect(storage.getItem("findback.updates.dismissed.v1")).toBe("{corrupt");
  });
  it("records a notice before presentation so a crash cannot re-nag", async () => {
    const storage = memoryStorage();
    const first = build({ storage });
    await first.controller.refreshInstalled(); first.controller.setPopupEnabled(true); await first.controller.check();
    expect(first.controller.claimPrompt()?.id).toBe("v0.15.0-beta.1");
    expect(first.controller.claimPrompt()).toBeNull();
    const restarted = build({ storage });
    await restarted.controller.refreshInstalled(); await restarted.controller.check();
    expect(restarted.controller.getSnapshot().pending).toBeNull();
  });
  it("refuses unsolicited presentation without a durable seen receipt", async () => {
    const { controller } = build({ storage: { getItem: () => null, setItem: () => { throw new Error("quota"); } } });
    await controller.refreshInstalled(); controller.setPopupEnabled(true); await controller.check();
    expect(controller.claimPrompt()).toBeNull();
    expect(controller.getSnapshot().popupEnabled).toBe(false);
  });
  it("keeps the session dismissal even if durable storage refuses writes", async () => {
    const data = new Map<string, string>();
    let blocked = false;
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => {
      if (blocked) throw new Error("quota");
      data.set(key, value);
    } };
    const { controller } = build({ storage });
    await controller.refreshInstalled();
    controller.setPopupEnabled(true);
    await controller.check();
    blocked = true;
    controller.dismiss();
    expect(controller.getSnapshot().pending).toBeNull();
    await controller.check();
    expect(controller.getSnapshot().pending).toBeNull();
    expect(controller.getSnapshot().dismissed).toContain("v0.15.0-beta.1");
  });
  it("does not re-ask about the same release", async () => {
    const storage = memoryStorage();
    const first = build({ storage });
    await first.controller.refreshInstalled();
    first.controller.setPopupEnabled(true);
    await first.controller.check();
    first.controller.dismiss();
    expect(first.controller.getSnapshot().pending).toBeNull();
    // Recheck in the same session.
    await first.controller.check();
    expect(first.controller.getSnapshot().pending).toBeNull();

    // A normal launch: a brand-new controller over the same storage.
    const restarted = build({ storage });
    await restarted.controller.refreshInstalled();
    await restarted.controller.check();
    expect(restarted.controller.getSnapshot().popupEnabled).toBe(true);
    expect(restarted.controller.getSnapshot().pending).toBeNull();
    // The permanent row still shows it — dismissal only silences the popup.
    expect(restarted.controller.getSnapshot().eligible?.id).toBe("v0.15.0-beta.1");
  });

  it("may prompt for a genuinely later release", async () => {
    const storage = memoryStorage();
    const first = build({ storage });
    await first.controller.refreshInstalled();
    first.controller.setPopupEnabled(true);
    await first.controller.check();
    first.controller.dismiss();

    const later = build({
      storage,
      result: {
        status: "ok",
        catalogue: catalogue(
          release(),
          release({
            id: "v0.16.0-beta.1",
            versionName: "0.16.0-beta.1",
            versionCode: 16001,
            tag: "v0.16.0-beta.1",
            publishedAt: "2026-11-05T00:00:00Z",
            artifacts: [
              artifact({
                url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.16.0-beta.1/Norfold-arm64-v8a.apk",
              }),
            ],
          }),
        ),
        checkedAt: 3_000,
      },
    });
    await later.controller.refreshInstalled();
    await later.controller.check();
    expect(later.controller.getSnapshot().pending?.id).toBe("v0.16.0-beta.1");
  });

  it("drops an obsolete pending prompt instead of queueing both", async () => {
    const { controller, catalogueSource } = build();
    await controller.refreshInstalled();
    controller.setPopupEnabled(true);
    await controller.check();
    expect(controller.getSnapshot().pending?.id).toBe("v0.15.0-beta.1");

    // A 0.15.1 release is now the eligible one; the 0.15 prompt must be gone.
    catalogueSource.check.mockResolvedValueOnce({
      status: "ok",
      catalogue: catalogue(
        release(),
        release({
          id: "v0.15.1-beta.1",
          versionName: "0.15.1-beta.1",
          versionCode: 15002,
          tag: "v0.15.1-beta.1",
          artifacts: [
            artifact({
              url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.15.1-beta.1/Norfold-arm64-v8a.apk",
            }),
          ],
        }),
      ),
      checkedAt: 4_000,
    });
    await controller.check();
    const snapshot = controller.getSnapshot();
    expect(snapshot.eligible?.id).toBe("v0.15.1-beta.1");
    expect(snapshot.pending?.id).toBe("v0.15.1-beta.1");
  });
});

describe("update controller — honest check results", () => {
  it("restores cached history on an offline first check after restart", async () => {
    const { controller } = build({
      result: { status: "error", code: "offline", catalogue: catalogue(release()), checkedAt: 1_000 },
    });
    await controller.refreshInstalled();
    const failed = await controller.check();
    expect(failed.history.map((entry) => entry.id)).toEqual(["v0.15.0-beta.1"]);
    expect(failed.lastCheck?.status).toBe("error");
    expect(failed.pending).toBeNull();
  });
  it("reports a failure instead of claiming the app is current", async () => {
    const { controller, catalogueSource } = build();
    await controller.refreshInstalled();
    await controller.check();
    expect(controller.getSnapshot().eligible).not.toBeNull();

    catalogueSource.check.mockRejectedValueOnce(new Error("network down"));
    const failed = await controller.check();
    expect(failed.lastCheck).toMatchObject({ status: "error", code: "offline", attemptedAt: 2_000 });
    // Last known-good history and the eligible release are retained...
    expect(failed.history.length).toBe(1);
    expect(failed.eligible?.id).toBe("v0.15.0-beta.1");
    // ...and the failure is never rendered as success.
    expect(failed.lastCheck?.status).not.toBe("ok");
  });

  it("keeps history readable offline", async () => {
    const { controller, catalogueSource } = build();
    await controller.refreshInstalled();
    await controller.check();
    catalogueSource.check.mockResolvedValueOnce({
      status: "error",
      code: "offline",
      catalogue: catalogue(release()),
      checkedAt: 1_000,
    });
    const offline = await controller.check();
    expect(offline.history.map((entry) => entry.id)).toEqual(["v0.15.0-beta.1"]);
    expect(offline.lastCheck).toMatchObject({ status: "error", code: "offline", checkedAt: 1_000 });
  });

  it("offers nothing when the installed identity cannot be verified", async () => {
    // Web, or a native bridge that could not read package/ABI/SDK.
    const { controller } = build({ installed: null });
    await controller.refreshInstalled();
    controller.setPopupEnabled(true);
    const snapshot = await controller.check();
    expect(snapshot.installed).toBeNull();
    expect(snapshot.eligible).toBeNull();
    expect(snapshot.pending).toBeNull();
    // History still renders; it is just not an install offer.
    expect(snapshot.history.length).toBe(1);
  });

  it("never claims an install from a completed job", async () => {
    const { controller, installationPort } = build();
    await controller.refreshInstalled();
    await controller.check();
    expect(controller.getSnapshot().installed?.versionCode).toBe(14001);
    // Downloading does not change installed identity; only a fresh read does.
    await controller.check();
    expect(controller.getSnapshot().installed?.versionCode).toBe(14001);

    installationPort.mockResolvedValueOnce(installation({ versionCode: 15001 }));
    const afterInstall = await controller.refreshInstalled();
    expect(afterInstall.installed?.versionCode).toBe(15001);
    // The release is now installed, so it is no longer offered as an update.
    expect(afterInstall.eligible).toBeNull();
  });

  it("coalesces concurrent checks into one request", async () => {
    const { controller, catalogueSource } = build();
    await controller.refreshInstalled();
    await Promise.all([controller.check(), controller.check(), controller.check()]);
    expect(catalogueSource.check).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers with the derived snapshot", async () => {
    const { controller } = build();
    const seen: (string | null)[] = [];
    const off = controller.subscribe((snapshot) => seen.push(snapshot.pending?.id ?? null));
    await controller.refreshInstalled();
    controller.setPopupEnabled(true);
    await controller.check();
    off();
    expect(seen[0]).toBeNull();
    expect(seen[seen.length - 1]).toBe("v0.15.0-beta.1");
    await controller.check();
    expect(seen[seen.length - 1]).toBe("v0.15.0-beta.1");
  });
});
