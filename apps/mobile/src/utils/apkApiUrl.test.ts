import { describe, expect, it } from "vitest";
import { resolveApkApiUrl } from "@findback/shared";

describe("resolveApkApiUrl", () => {
  it("requires a value for an APK build", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const result = resolveApkApiUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/VITE_API_URL is required/);
    }
  });

  it("rejects a URL that points at the device itself", () => {
    for (const raw of ["http://localhost:4000", "http://127.0.0.1:4000", "http://0.0.0.0:4000"]) {
      const result = resolveApkApiUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/device itself/);
    }
  });

  it("rejects malformed or non-http(s) URLs", () => {
    for (const raw of ["not a url", "ftp://192.168.1.5", "192.168.1.5:4000", "http://"]) {
      expect(resolveApkApiUrl(raw).ok).toBe(false);
    }
  });

  it("accepts a LAN IPv4 base for a physical phone", () => {
    expect(resolveApkApiUrl("http://192.168.1.20:4000")).toEqual({
      ok: true,
      url: "http://192.168.1.20:4000",
    });
  });

  it("accepts the emulator loopback alias 10.0.2.2", () => {
    expect(resolveApkApiUrl("http://10.0.2.2:4000")).toEqual({
      ok: true,
      url: "http://10.0.2.2:4000",
    });
  });

  it("accepts an https base and trims a trailing slash", () => {
    expect(resolveApkApiUrl("https://api.findback.example/")).toEqual({
      ok: true,
      url: "https://api.findback.example",
    });
  });

  it("only allows localhost when explicitly opted in", () => {
    expect(resolveApkApiUrl("http://localhost:4000", { allowLocalhost: true })).toEqual({
      ok: true,
      url: "http://localhost:4000",
    });
  });
});
