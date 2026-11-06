import { describe, expect, it, vi } from "vitest";
import {
  CatalogueError,
  createCatalogueSource,
  localStorageCatalogueCache,
  parseAndroidCatalogue,
  releaseFromManifest,
  selectArtifact,
  selectInstallableRelease,
  SUPPORTED_ABIS,
} from "./catalogue";
import type { AndroidArtifact, AndroidCatalogue, AndroidRelease, Installation } from "./types";

const SIGNER = "ab".repeat(32);
const COMMIT = "a".repeat(40);

function artifact(overrides: Partial<AndroidArtifact> = {}): AndroidArtifact {
  return {
    url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/Norfold-arm64-v8a.apk",
    bytes: 80_000_000,
    sha256: "1".repeat(64),
    packageName: "com.findback.app",
    signingChannel: "synthetic-beta",
    signerSha256: SIGNER,
    abis: ["arm64-v8a"],
    minSdk: 24,
    targetSdk: 36,
    ...overrides,
  };
}

function release(overrides: Partial<AndroidRelease> = {}): AndroidRelease {
  return {
    id: "synthetic-0.15",
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
    signingChannel: "synthetic-beta",
    abi: "arm64-v8a",
    sdk: 35,
    ...overrides,
  };
}

describe("catalogue validation", () => {
  it("accepts a well-formed release and freezes it", () => {
    const parsed = parseAndroidCatalogue(catalogue(release()));
    expect(parsed.releases).toHaveLength(1);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.releases[0])).toBe(true);
    expect(parsed.releases[0]!.artifacts[0]!.signerSha256).toBe(SIGNER);
  });

  it("allows an assetless tag as metadata (v0.10.0-beta.1 really has no assets)", () => {
    // The published tag exists with no APKs; that is valid metadata and must
    // not be rejected — selection is what refuses to offer it.
    const parsed = parseAndroidCatalogue(
      catalogue(release({ id: "v0.10.0-beta.1", versionName: "0.10.0-beta.1", versionCode: 100500, artifacts: [] })),
    );
    expect(parsed.releases[0]!.artifacts).toEqual([]);
  });

  it("rejects duplicate release ids", () => {
    expect(() => parseAndroidCatalogue(catalogue(release(), release()))).toThrow(/duplicates/);
  });

  it("rejects duplicate artifact URLs across releases", () => {
    const second = release({
      id: "other",
      tag: "v0.16.0-beta.1",
      versionName: "0.16.0-beta.1",
      versionCode: 16001,
    });
    expect(() => parseAndroidCatalogue(catalogue(release(), second))).toThrow(/duplicates another artifact/);
  });

  it.each([
    ["versionName", { versionName: "latest" }],
    ["versionCode", { versionCode: 0 }],
    ["gitSha", { gitSha: "abc123" }],
    ["publishedAt", { publishedAt: "yesterday" }],
    ["platform", { platform: "ios" as never }],
    ["tag", { tag: "v0.15 with space" }],
  ])("rejects an invalid %s", (_field, patch) => {
    expect(() => parseAndroidCatalogue(catalogue(release(patch as Partial<AndroidRelease>)))).toThrow(CatalogueError);
  });

  it("rejects a wrong package or channel", () => {
    expect(() =>
      parseAndroidCatalogue(catalogue(release({ artifacts: [artifact({ packageName: "com.evil.app" })] }))),
    ).toThrow(/must be com\.findback\.app/);
    expect(() =>
      parseAndroidCatalogue(catalogue(release({ artifacts: [artifact({ signingChannel: "" })] }))),
    ).toThrow(/signingChannel/);
  });

  it("rejects an unsupported ABI and an impossible SDK range", () => {
    expect(() =>
      parseAndroidCatalogue(catalogue(release({ artifacts: [artifact({ abis: ["mips"] })] }))),
    ).toThrow(/not a supported ABI/);
    expect(() =>
      parseAndroidCatalogue(catalogue(release({ artifacts: [artifact({ minSdk: 40, targetSdk: 36 })] }))),
    ).toThrow(/targetSdk/);
  });

  it("rejects an artifact whose channel or SDK disagrees with its siblings", () => {
    const universal = artifact({
      url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/Norfold-universal.apk",
      abis: [...SUPPORTED_ABIS],
      signingChannel: "other-channel",
    });
    expect(() => parseAndroidCatalogue(catalogue(release({ artifacts: [artifact(), universal] })))).toThrow(
      /differs from its sibling/,
    );
    const wrongSdk = artifact({
      url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/Norfold-universal.apk",
      abis: [...SUPPORTED_ABIS],
      minSdk: 26,
    });
    expect(() => parseAndroidCatalogue(catalogue(release({ artifacts: [artifact(), wrongSdk] })))).toThrow(
      /SDK levels differ/,
    );
  });

  it.each([
    "http://github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/x.apk",
    "https://user:pass@github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/x.apk",
    "https://cdn.example.com/x.apk",
    "https://github.com.evil.example/x.apk",
  ])("rejects the unsafe artifact URL %s", (url) => {
    expect(() => parseAndroidCatalogue(catalogue(release({ artifacts: [artifact({ url })] })))).toThrow(CatalogueError);
  });

  it("rejects a malformed digest or size", () => {
    expect(() =>
      parseAndroidCatalogue(catalogue(release({ artifacts: [artifact({ sha256: "xyz" })] }))),
    ).toThrow(/sha256/);
    expect(() =>
      parseAndroidCatalogue(catalogue(release({ artifacts: [artifact({ bytes: 0 })] }))),
    ).toThrow(/bytes/);
    expect(() =>
      parseAndroidCatalogue(catalogue(release({ artifacts: [artifact({ signerSha256: "abc" })] }))),
    ).toThrow(/signerSha256/);
  });
});

describe("installable release selection", () => {
  it("does not treat an assetless tag as an installable update", () => {
    // Higher code than the installation, and still not an update: there are no
    // bytes to install. This is the real v0.10.0-beta.1 shape.
    const assetless: AndroidCatalogue = {
      releases: [
        release({
          id: "v0.10.0-beta.1",
          versionName: "0.10.0-beta.1",
          versionCode: 100501,
          tag: "v0.10.0-beta.1",
          artifacts: [],
        }),
      ],
    };
    expect(selectInstallableRelease(assetless, installation())).toBeNull();
  });

  it("never downgrades a newer installation", () => {
    // The published v0.9.0-beta.1 release (real version/code/SHA from its
    // release-manifest.json) is not an update for anything newer than 100471.
    const published: AndroidCatalogue = {
      releases: [
        release({
          id: "v0.9.0-beta.1",
          versionName: "0.9.0-beta.1",
          versionCode: 100471,
          gitSha: "2c0880ef767085c645b738cf6ab4efec50aabf3e",
          tag: "v0.9.0-beta.1",
          artifacts: [
            artifact({
              url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.9.0-beta.1/FindBack-v0.9.0-beta.1-arm64-v8a.apk",
              bytes: 79_357_214,
              sha256: "5c095ef6789abc56c7ee4a8689ba86f11b3b7107fde714fe90a6357a3bf22a60",
            }),
          ],
        }),
      ],
    };
    expect(selectInstallableRelease(published, installation({ versionCode: 100471 }))).toBeNull();
    expect(selectInstallableRelease(published, installation({ versionCode: 100988 }))).toBeNull();
    // ...but it IS the update for an older installation, so the rejection above
    // is about direction, not a blanket refusal.
    expect(selectInstallableRelease(published, installation({ versionCode: 100400 }))?.id).toBe(
      "v0.9.0-beta.1",
    );
  });

  it("offers a newer accepted release with a compatible artifact", () => {
    expect(selectInstallableRelease(catalogue(release()), installation())?.id).toBe("synthetic-0.15");
  });

  it("ignores an unaccepted release", () => {
    expect(selectInstallableRelease(catalogue(release({ accepted: false })), installation())).toBeNull();
  });

  it("ignores a release whose only artifact is for another package, channel, ABI or SDK", () => {
    const cases: Partial<AndroidArtifact>[] = [
      { packageName: "com.evil.app" },
      { signingChannel: "other-channel" },
      { abis: ["armeabi-v7a"] },
      { minSdk: 40 },
    ];
    for (const patch of cases) {
      const bad = catalogue(release({ artifacts: [artifact(patch)] }));
      expect(selectInstallableRelease(bad, installation()), JSON.stringify(patch)).toBeNull();
    }
  });

  it("picks the highest accepted compatible code, not the latest tag string", () => {
    const newerButWrongAbi = release({
      id: "newer-wrong-abi",
      versionCode: 16001,
      versionName: "0.16.0-beta.1",
      tag: "v0.16.0-beta.1",
      artifacts: [artifact({ abis: ["x86_64"] })],
    });
    const compatible = release({ id: "compatible", versionCode: 15001 });
    expect(
      selectInstallableRelease(catalogue(newerButWrongAbi, compatible), installation())?.id,
    ).toBe("compatible");
  });

  it("fails closed on unknown installation facts", () => {
    const good = catalogue(release());
    expect(selectInstallableRelease(good, installation({ signingChannel: "" }))).toBeNull();
    expect(selectInstallableRelease(good, installation({ versionCode: 0 }))).toBeNull();
    expect(selectInstallableRelease(good, installation({ abi: "" }))).toBeNull();
    expect(selectInstallableRelease(good, installation({ sdk: 0 }))).toBeNull();
  });
});

describe("artifact selection", () => {
  const universal = artifact({
    url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/Norfold-universal.apk",
    bytes: 156_000_000,
    abis: [...SUPPORTED_ABIS],
  });

  it("prefers the exact-ABI artifact over the larger universal one", () => {
    const r = release({ artifacts: [universal, artifact()] });
    expect(selectArtifact(r, installation())?.url).toBe(artifact().url);
  });

  it("falls back to a universal artifact that really carries the ABI", () => {
    const r = release({ artifacts: [universal] });
    expect(selectArtifact(r, installation())?.url).toBe(universal.url);
  });

  it("returns null when no artifact matches the installation", () => {
    expect(selectArtifact(release({ artifacts: [artifact({ abis: ["x86_64"] })] }), installation())).toBeNull();
    expect(selectArtifact(release(), installation({ signingChannel: "other-channel" }))).toBeNull();
  });

  it("is deterministic among equal candidates", () => {
    const a = artifact({ url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/b.apk" });
    const b = artifact({ url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.15.0-beta.1/a.apk" });
    expect(selectArtifact(release({ artifacts: [a, b] }), installation())?.url).toBe(b.url);
  });
});

/* ------------------------------------------------------------------------- */
/* Bounded fetch                                                             */
/* ------------------------------------------------------------------------- */

const CATALOGUE_URL =
  "https://github.com/sheikhti1205/Norfold/releases/download/catalogue/android-updates.json";

function jsonResponse(payload: unknown, url = CATALOGUE_URL) {
  return {
    ok: true,
    status: 200,
    url,
    json: async () => payload,
  } as unknown as Response;
}

function memoryCache(initial: unknown = null) {
  let value = initial;
  return {
    reads: 0,
    writes: 0,
    read: async () => {
      return value;
    },
    write: async (raw: unknown) => {
      value = raw;
    },
    peek: () => value,
  };
}

describe("bounded catalogue source", () => {
  it("refuses an untrusted or non-HTTPS endpoint at construction", () => {
    expect(() => createCatalogueSource({ url: "http://github.com/x.json" })).toThrow(/must be https/);
    expect(() => createCatalogueSource({ url: "https://cdn.example.com/x.json" })).toThrow(
      /trusted release host/,
    );
  });

  it("validates and caches a fresh payload", async () => {
    const cache = memoryCache();
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl: async () => jsonResponse(catalogue(release())),
      cache,
      now: () => 1_000,
    });
    const result = await source.check();
    expect(result).toMatchObject({ status: "ok", checkedAt: 1_000 });
    expect(cache.peek()).toMatchObject({ checkedAt: 1_000 });
    expect((cache.peek() as { catalogue: AndroidCatalogue }).catalogue.releases).toHaveLength(1);
  });

  it("does not re-fetch inside the minimum interval", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalogue(release())));
    let clock = 1_000;
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl,
      cache: memoryCache({ checkedAt: 900, catalogue: catalogue(release()) }),
      now: () => clock,
      minIntervalMs: 60_000,
    });
    const first = await source.check();
    expect(first).toMatchObject({ status: "cached", reason: "rate-limited" });
    expect(fetchImpl).not.toHaveBeenCalled();
    clock = 100_000;
    await source.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches on a forced check even inside the minimum interval", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalogue(release())));
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl,
      cache: memoryCache({ checkedAt: 900, catalogue: catalogue(release()) }),
      now: () => 1_000,
      minIntervalMs: 60_000,
    });
    const forced = await source.check(true);
    expect(forced.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure backoff even when the check is forced", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("network down"); });
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl,
      now: () => 1_000,
      backoffBaseMs: 30_000,
    });
    expect((await source.check(true)).status).toBe("error");
    expect(await source.check(true)).toMatchObject({ status: "error", code: "backoff" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores a corrupted cache instead of trusting it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalogue(release())));
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl,
      cache: memoryCache({ checkedAt: 1, catalogue: { releases: "nope" } }),
      now: () => 10_000,
    });
    expect((await source.check()).status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the last known-good catalogue when the response is invalid", async () => {
    const good = catalogue(release());
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl: async () => jsonResponse({ releases: [{ id: "" }] }),
      cache: memoryCache({ checkedAt: 5, catalogue: good }),
      now: () => 10_000,
      // Past the minimum interval, so this exercises refresh-and-fail rather
      // than the rate-limit branch (which is covered separately).
      minIntervalMs: 1_000,
    });
    const result = await source.check();
    expect(result).toMatchObject({ status: "error", code: "invalid", checkedAt: 5 });
    if (result.status !== "error") return;
    expect(result.catalogue?.releases[0]!.id).toBe("synthetic-0.15");
  });

  it("reports an HTTP failure without claiming freshness", async () => {
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl: async () => ({ ok: false, status: 503, url: CATALOGUE_URL, json: async () => ({}) }) as unknown as Response,
      now: () => 10_000,
    });
    expect(await source.check()).toMatchObject({ status: "error", code: "http", catalogue: null });
  });

  it("rejects a redirect off the trusted origin", async () => {
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl: async () => jsonResponse(catalogue(release()), "https://evil.example/catalogue.json"),
      now: () => 10_000,
    });
    expect(await source.check()).toMatchObject({ status: "error", code: "untrusted" });
  });

  it("reports offline and then backs off instead of hammering", async () => {
    let clock = 10_000;
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl,
      now: () => clock,
      backoffBaseMs: 1_000,
      maxBackoffMs: 60_000,
    });
    expect(await source.check()).toMatchObject({ status: "error", code: "offline" });
    expect(await source.check()).toMatchObject({ status: "error", code: "backoff" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock = 12_000;
    await source.check();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds a hanging request", async () => {
    const source = createCatalogueSource({
      url: CATALOGUE_URL,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      timeoutMs: 5,
      now: () => 10_000,
    });
    expect(await source.check()).toMatchObject({ status: "error", code: "timeout" });
  });

  it("treats an unreadable browser cache as absent", async () => {
    const broken = { getItem: () => "{not json", setItem: () => {} };
    const cache = localStorageCatalogueCache("test", broken);
    expect(await cache.read()).toBeNull();
    const healthy = (() => {
      const data = new Map<string, string>();
      return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) };
    })();
    const roundTrip = localStorageCatalogueCache("test", healthy);
    await roundTrip.write(catalogue(release()));
    expect(await roundTrip.read()).toEqual(catalogue(release()));
  });
});


describe("release from a verified manifest", () => {
  // Shape produced by generate-release-manifest.mjs with --facts.
  function manifest(patch: Record<string, unknown> = {}) {
    return {
      versionName: "0.9.0-beta.1",
      versionCode: 100471,
      gitSha: "2c0880ef767085c645b738cf6ab4efec50aabf3e",
      tag: "v0.9.0-beta.1",
      minSdk: 24,
      targetSdk: 36,
      packageName: "com.findback.app",
      signingChannel: "beta",
      artifacts: [
        {
          file: "Norfold-v0.9.0-beta.1-arm64-v8a.apk",
          sha256: "5c095ef6789abc56c7ee4a8689ba86f11b3b7107fde714fe90a6357a3bf22a60",
          bytes: 79_357_214,
          kind: "apk",
          packageName: "com.findback.app",
          signingChannel: "beta",
          signerSha256: SIGNER,
          abis: ["arm64-v8a"],
          minSdk: 24,
          targetSdk: 36,
          versionName: "0.9.0-beta.1",
          versionCode: 100471,
        },
        {
          file: "Norfold-v0.9.0-beta.1.aab",
          sha256: "15c7fdbfbb3049726e4f8d8173eb54e8e68fbd3de0f64257addfbee4f1fd981c",
          bytes: 126_597_725,
          kind: "bundle",
        },
      ],
      ...patch,
    };
  }

  const input = {
    id: "v0.9.0-beta.1",
    summary: "Signed beta",
    accepted: true,
    downloadBaseUrl: "https://github.com/sheikhti1205/Norfold/releases/download/v0.9.0-beta.1/",
    publishedAt: "2026-10-06T19:52:08Z",
  };

  it("builds a valid release from the real published manifest shape", () => {
    const release = releaseFromManifest(manifest(), input);
    expect(release.versionCode).toBe(100471);
    expect(release.artifacts).toHaveLength(1); // the AAB is not installable
    expect(release.artifacts[0]!.url).toBe(
      "https://github.com/sheikhti1205/Norfold/releases/download/v0.9.0-beta.1/Norfold-v0.9.0-beta.1-arm64-v8a.apk",
    );
    // And it is selectable for an older installation.
    expect(
      selectInstallableRelease(
        { releases: [release] },
        // The published artifact's owner channel is `beta`; an installation on
        // another channel is not offered it.
        installation({ versionCode: 100400, signingChannel: "beta" }),
      )?.id,
    ).toBe("v0.9.0-beta.1");
  });

  it("refuses a manifest whose APKs carry no verified facts", () => {
    const legacy = manifest({
      artifacts: [
        {
          file: "Norfold-v0.9.0-beta.1-arm64-v8a.apk",
          sha256: "5c095ef6789abc56c7ee4a8689ba86f11b3b7107fde714fe90a6357a3bf22a60",
          bytes: 79_357_214,
          kind: "apk",
        },
      ],
    });
    expect(() => releaseFromManifest(legacy, input)).toThrow(CatalogueError);
  });

  it("refuses a bundle-only manifest", () => {
    const bundleOnly = manifest({
      artifacts: [{ file: "Norfold.aab", sha256: "1".repeat(64), bytes: 1, kind: "bundle" }],
    });
    expect(() => releaseFromManifest(bundleOnly, input)).toThrow(/no verified APK/);
  });
});
