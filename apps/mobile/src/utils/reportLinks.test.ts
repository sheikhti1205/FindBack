import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReportLink, reportLink } from "./reportLinks";

const origin = "https://ambitious-wave-0f1b6c500.3.azurestaticapps.net";
const id = "5b6f7c8d-1234-4abc-8def-123456789012";
afterEach(() => vi.unstubAllEnvs());

describe("external report link contract", () => {
  it("shares the canonical HTTPS origin even inside the localhost WebView", () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", origin);
    expect(reportLink(id)).toBe(`${origin}/r/${id}`);
  });
  it("routes comments and retains a validated comment ID", () => {
    expect(parseReportLink(`${origin}/r/${id}?focus=comments&comment=${id}`, origin))
      .toEqual({ postId: id, route: `/posts/${id}?comment=${id}#detail-comments`, sharedRoute: `/shared/${id}?focus=comments&comment=${id}` });
  });
  it("maps only supported focus destinations", () => {
    expect(parseReportLink(`${origin}/r/${id}?focus=activity`, origin)?.route).toBe(`/posts/${id}#detail-activity`);
    expect(parseReportLink(`${origin}/r/${id}?focus=manage`, origin)?.route).toBe(`/posts/${id}#detail-manage`);
    expect(parseReportLink(`${origin}/r/${id}`, origin)?.route).toBe(`/posts/${id}`);
  });
  it.each([
    `http://ambitious-wave-0f1b6c500.3.azurestaticapps.net/r/${id}`,
    `https://evil.test/r/${id}`,
    `https://user@ambitious-wave-0f1b6c500.3.azurestaticapps.net/r/${id}`,
    `${origin}:444/r/${id}`, `${origin}/posts/${id}`, `${origin}/r/../r/${id}`,
    `${origin}/r/p1`, `${origin}/r/${id}/extra`, `${origin}/r/%2Fsignin`,
    `${origin}/r/${id}?focus=unknown`, `${origin}/r/${id}?comment=bad`,
    `${origin}/r/${id}?focus=comments&focus=manage`, `${origin}/r/${id}?next=https://evil.test`,
    `${origin}/r/${id}#/signin`, "javascript:alert(1)", "broken",
  ])("rejects untrusted or malformed input: %s", (url) => {
    expect(parseReportLink(url, origin)).toBeNull();
  });
  it("fails sharing rather than emitting an unconfigured local URL", () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "");
    expect(() => reportLink(id)).toThrow(/share origin/i);
  });
});
