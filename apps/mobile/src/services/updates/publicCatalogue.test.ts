import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCatalogueSource, parseAndroidCatalogue, selectInstallableRelease } from "./catalogue";

describe("curated public update catalogue", () => {
  it("retains bundled history offline without reporting a successful remote check", async () => {
    const fallback = parseAndroidCatalogue(JSON.parse(readFileSync(new URL("../../../public/updates/catalogue.v1.json", import.meta.url), "utf8")));
    const source = createCatalogueSource({ url: "https://github.com/sheikhti1205/Norfold/catalogue.json", fallback,
      fetchImpl: async () => { throw new Error("offline"); } });
    const check = await source.check();
    expect(check.status).toBe("error");
    expect(check.catalogue?.history).toHaveLength(2);
  });
  it("preserves assetless and unverified historical releases without inventing installable bytes", () => {
    const catalogue = parseAndroidCatalogue(JSON.parse(readFileSync(new URL("../../../public/updates/catalogue.v1.json", import.meta.url), "utf8")));
    expect(catalogue.history?.map(record => record.id)).toEqual(["v0.10.0-beta.1", "v0.9.0-beta.1"]);
    expect(catalogue.releases).toEqual([]);
    expect(selectInstallableRelease(catalogue, {
      packageName: "com.findback.app", versionCode: 1, signingChannel: "beta", abi: "arm64-v8a", sdk: 36,
    })).toBeNull();
  });
  it("validates historical identities, text and feature destinations rather than silently discarding them", () => {
    expect(() => parseAndroidCatalogue({ releases: [], history: [{ id: "broken" }] })).toThrow();
    expect(() => parseAndroidCatalogue({ releases: [], features: [{ id: "bad", destinationId: "missing" }] })).toThrow();
  });
});
