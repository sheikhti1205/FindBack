import { describe, expect, it } from "vitest";
import { NEEDLE_DESCRIPTOR } from "./modelDescriptors";
import { createInitialStatus } from "./offlineModelManager";
import { localSearchHelperView, localOperationNotice, isLocalIntelligenceOwnedModel } from "./localIntelligenceView";
import { NEEDLE_MODEL_ID } from "./needle/embedder";

const initial = createInitialStatus({ modelId: NEEDLE_DESCRIPTOR.modelId, sha256: NEEDLE_DESCRIPTOR.sha256, downloadBytes: NEEDLE_DESCRIPTOR.bytes, minFreeRamMb: 0 });
const view = (patch = {}, notice: string | null = null) => localSearchHelperView(NEEDLE_DESCRIPTOR, { ...initial, ...patch }, notice);

describe("local search helper presentation", () => {
  it("uses the canonical acquisition size as download size, never disk usage", () => {
    expect(view().downloadSize).toBe("35.3 MB");
    expect(view().state).toBe("Not downloaded");
    expect(view().primary).toEqual({ action: "download", label: "Download · 35.3 MB" });
  });
  it("states the download size once: on the action, or on its own line", () => {
    // The action label already carries the size here, so the surface must not
    // print it a second time.
    expect(view().sizeInAction).toBe(true);
    // No download action (installed): the size line is the only place it
    // appears, and it stays available for the repair action.
    expect(view({ download: "installed", checksumVerified: true }).sizeInAction).toBe(false);
    expect(view({ download: "failed", lastError: "checksum mismatch against catalogue pin" }).sizeInAction).toBe(false);
  });
  it("does not trust installed without verification", () => {
    // An installed-but-unverified file is only unproven: the honest action is
    // to CHECK it, and it must not borrow the integrity-failure wording.
    expect(view({ download: "installed" }).state).toBe("Downloaded file needs checking");
    expect(view({ download: "installed" }).primary?.action).toBe("verify");
    expect(view({ download: "installed" }).state).not.toBe("Needs repair");
    expect(view({ download: "installed", checksumVerified: true }).state).toBe("Installed");
  });
  it("keeps partial bytes visible and resumes instead of claiming installed", () => {
    const paused = view({ download: "paused", downloadedBytes: NEEDLE_DESCRIPTOR.bytes / 2 });
    expect(paused.state).toBe("Paused at 50%");
    expect(paused.primary?.label).toBe("Resume");
    expect(paused.removable).toBe(true);
    expect(paused.progress).toBe(50);
  });
  it("distinguishes verification, interruption, storage and repair", () => {
    expect(view({ download: "verifying" }).state).toBe("Checking downloaded file…");
    expect(view({ download: "failed", lastError: "transfer failed" }).primary?.label).toBe("Retry");
    expect(view({ download: "failed", lastError: "not enough free storage" }).state).toBe("Needs more storage");
    expect(view({ download: "failed", lastError: "checksum mismatch against catalogue pin" }).state).toBe("Needs repair");
    expect(view({ download: "failed", lastError: "checksum mismatch against catalogue pin" }).primary?.label).toBe("Download again");
    expect(view({}, "The installed file is missing. Download it again.").state).toBe("Needs repair");
  });
  it("never advertises a removal it would refuse", () => {
    expect(view({ download: "queued" }).removable).toBe(false);
    expect(view({ download: "verifying" }).removable).toBe(false);
    expect(view({ download: "installed", checksumVerified: true }).removable).toBe(true);
  });
  it("never prints raw errors or misleading verification success", () => {
    expect(localOperationNotice("runtime private/path deadbeef")).toBe("Couldn't finish. Please try again.");
    expect(localOperationNotice("On-device runtime is busy; stop inference before removing a model")).toBe("This tool is in use. Try again when it has finished.");
    expect(localOperationNotice("Installed and checksum verified.")).toBeNull();
  });
  it("separates an unreadable model store from a full disk", () => {
    // The canonical notice means "the model store could not be read" — not
    // "free some space". Telling a user to free space would be wrong advice.
    expect(localOperationNotice("Model storage could not be verified. Retry from AI & Models."))
      .toBe("Couldn't check the downloaded files on this device. Try again.");
    expect(localOperationNotice("not enough free storage for this download"))
      .toBe("Free some space on this device, then try again.");
  });
  it("owns the local search helper artifact so no second surface can offer it", () => {
    expect(isLocalIntelligenceOwnedModel(NEEDLE_MODEL_ID)).toBe(true);
    expect(isLocalIntelligenceOwnedModel("qwen3-0.6b-dynamic-int4")).toBe(false);
    expect(isLocalIntelligenceOwnedModel(undefined)).toBe(false);
  });
});
