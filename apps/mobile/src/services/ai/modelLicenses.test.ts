import { expect, it } from "vitest";
import { productionModelRegistry } from "./modelDescriptors";
import { acquisitionArtifacts } from "./modelSupply";
import { modelLicenseFor } from "./modelLicenses";

it("ships exact artifact-linked license and attribution snapshots for every curated acquisition", () => {
  for (const d of productionModelRegistry().descriptors) {
    if (d.trust !== "curated" || !d.downloadable) continue;
    const notice = modelLicenseFor(d.modelId);
    expect(notice, d.modelId).toBeDefined();
    expect(notice!.revision).toBe(d.revision);
    expect(notice!.artifacts).toEqual(acquisitionArtifacts(d).map((file) => ({ fileName: file.fileName, bytes: file.bytes, sha256: file.sha256 })));
    expect(notice!.licenseText).toMatch(d.license === "LFM-1.0" ? /LFM Open License/i : /Apache License/);
    expect(notice!.cardText).not.toBe("");
  }
});
it("does not lend a curated license/provenance packet to unknown imports", () => {
  expect(modelLicenseFor("imported-" + "a".repeat(64))).toBeUndefined();
});
