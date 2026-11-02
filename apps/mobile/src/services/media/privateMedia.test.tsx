// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSignedUrlMock, fromBucket, auth } = vi.hoisted(() => ({
  fromBucket: vi.fn(),
  auth: { getSession: vi.fn(), onAuthStateChange: vi.fn() },
  createSignedUrlMock: vi.fn(async (_key: string, _ttl: number) => ({
    data: { signedUrl: "https://signed.test/photo.jpg" } as { signedUrl: string } | null,
    error: null as { message: string } | null,
  })),
}));

vi.mock("../supabaseClient", () => ({
  getSupabase: () => ({ auth, storage: { from: (bucket: string) => { fromBucket(bucket); return { createSignedUrl: createSignedUrlMock }; } } }),
}));

import {
  PRIVATE_MEDIA_BUCKET,
  isPrivateMediaKey,
  peekMediaUrl,
  resolveMediaUrl,
  useMediaUrl,
} from "./privateMedia";

// The module keeps a process-wide cache; a distinct key per test keeps the
// cases independent without exposing a reset hook in production code.
const key = (suffix: string) => `11111111-1111-4111-8111-111111111111/${suffix}.jpg`;

beforeEach(() => {
  createSignedUrlMock.mockReset();
  auth.getSession.mockReset();
  fromBucket.mockClear();
  auth.getSession.mockResolvedValue({ data: { session: { user: { id: "reader-a" } } } });
  auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  createSignedUrlMock.mockResolvedValue({
    data: { signedUrl: "https://signed.test/photo.jpg" },
    error: null,
  });
});

describe("private comment media addresses", () => {
  const address = (mode = "authenticated") => `https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/${mode}/findback-comment-media/${key("comment")}`;
  it.each(["authenticated", "public"])("signs %s comment addresses with a short TTL, never as a permanent URL", async (mode) => {
    expect(isPrivateMediaKey(address(mode))).toBe(true);
    expect(peekMediaUrl(address(mode))).toBeUndefined();
    await expect(resolveMediaUrl(address(mode))).resolves.toBe("https://signed.test/photo.jpg");
    expect(fromBucket).toHaveBeenCalledWith("findback-comment-media");
    expect(createSignedUrlMock).toHaveBeenCalledWith(key("comment"), 60);
    // No cross-account/global comment cache: each request checks current authority.
    expect(peekMediaUrl(address(mode))).toBeUndefined();
    await resolveMediaUrl(address(mode));
    expect(createSignedUrlMock).toHaveBeenCalledTimes(2);
  });
  it("fails closed on denied signing, and discards an in-flight result after an account change", async () => {
    createSignedUrlMock.mockResolvedValueOnce({ data: null, error: { message: "denied" } });
    await expect(resolveMediaUrl(address())).resolves.toBeUndefined();
    auth.getSession.mockResolvedValueOnce({ data: { session: { user: { id: "reader-a" } } } })
      .mockResolvedValueOnce({ data: { session: { user: { id: "reader-b" } } } });
    await expect(resolveMediaUrl(address())).resolves.toBeUndefined();
  });
  it("clears an already-rendered comment photo when the SDK account signs out", async () => {
    function Photo() { const src=useMediaUrl(address()); return <img src={src} alt="Private comment" />; }
    render(<Photo />);
    await waitFor(() => expect(screen.getByAltText("Private comment").getAttribute("src")).toBe("https://signed.test/photo.jpg"));
    auth.getSession.mockResolvedValue({ data: { session: null } });
    act(() => { auth.onAuthStateChange.mock.calls.at(-1)![0]("SIGNED_OUT", null); });
    expect(screen.getByAltText("Private comment").getAttribute("src")).toBeNull();
  });
});

afterEach(() => {
  cleanup();
});

describe("private report media addresses", () => {
  it("treats only a bare storage key as private", () => {
    expect(isPrivateMediaKey(key("a"))).toBe(true);
    expect(isPrivateMediaKey("https://cdn.test/legacy.jpg")).toBe(false);
    expect(isPrivateMediaKey("blob:local-preview")).toBe(false);
    // An app-local path or a bare filename is not a bucket object: signing it
    // would replace a working legacy image with a broken one.
    expect(isPrivateMediaKey("/wallet.jpg")).toBe(false);
    expect(isPrivateMediaKey("assets/wallet.jpg")).toBe(false);
    expect(isPrivateMediaKey("data:image/png;base64,AA")).toBe(false);
    expect(isPrivateMediaKey("fixture:assets/x.jpg")).toBe(false);
    expect(isPrivateMediaKey("")).toBe(false);
    expect(isPrivateMediaKey(null)).toBe(false);
    expect(isPrivateMediaKey(undefined)).toBe(false);
  });

  it("passes a legacy public URL through without signing anything", async () => {
    await expect(resolveMediaUrl("https://cdn.test/legacy.jpg")).resolves.toBe("https://cdn.test/legacy.jpg");
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(peekMediaUrl("https://cdn.test/legacy.jpg")).toBe("https://cdn.test/legacy.jpg");
  });

  it("signs a storage key in the private bucket and caches the result", async () => {
    const first = await resolveMediaUrl(key("signed"));
    expect(first).toBe("https://signed.test/photo.jpg");
    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(createSignedUrlMock).toHaveBeenCalledWith(key("signed"), expect.any(Number));
    // The bucket is never spelled out by a caller: one module owns it.
    expect(PRIVATE_MEDIA_BUCKET).toBe("findback-report-media");

    // Second read is served from the cache, not another round trip.
    await expect(resolveMediaUrl(key("signed"))).resolves.toBe("https://signed.test/photo.jpg");
    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(peekMediaUrl(key("signed"))).toBe("https://signed.test/photo.jpg");
  });

  it("falls back to the raw key when signing fails, so the caller's error state runs", async () => {
    createSignedUrlMock.mockResolvedValueOnce({ data: null, error: { message: "denied" } });
    await expect(resolveMediaUrl(key("denied"))).resolves.toBeUndefined();
  });

  it("returns a public URL on the first render, with no second commit", () => {
    function Card({ value }: { value: string }) {
      const src = useMediaUrl(value);
      return <img data-testid="cover" src={src} alt="" />;
    }
    render(<Card value="https://cdn.test/legacy.jpg" />);
    expect(screen.getByTestId("cover").getAttribute("src")).toBe("https://cdn.test/legacy.jpg");
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });

  it("resolves a signed key after mount and never paints a stale URL", async () => {
    function Card({ value }: { value: string }) {
      const src = useMediaUrl(value);
      return <img data-testid="cover" src={src} alt="" />;
    }
    const { rerender } = render(<Card value={key("hook")} />);
    expect(screen.getByTestId("cover").getAttribute("src")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("cover").getAttribute("src")).toBe("https://signed.test/photo.jpg"),
    );

    // A different, still-unsigned key must not inherit the previous URL.
    rerender(<Card value={key("hook-2")} />);
    expect(screen.getByTestId("cover").getAttribute("src")).not.toBe("https://signed.test/photo.jpg");
  });
});
