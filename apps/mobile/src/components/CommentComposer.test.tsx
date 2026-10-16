// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer, toCommentAttachmentDescriptors } from "./CommentComposer";

const { attachMock, profileMock } = vi.hoisted(() => ({
  attachMock: {
    upload: vi.fn(),
    remove: vi.fn(),
  },
  profileMock: {
    search: vi.fn(),
  },
}));

vi.mock("../services/commentAttachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/commentAttachments")>();
  return {
    ...actual,
    uploadCommentAttachment: attachMock.upload,
    removeCommentAttachment: attachMock.remove,
    // The real helper dynamically imports @capacitor/core; steer it here so
    // web/jsdom stays on the file input unless a test opts into native.
    isNativeCommentPhotoIntakeAvailable: async () => nativeMediaMock.available,
  };
});

vi.mock("../services/profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/profile")>();
  return {
    ...actual,
    searchProfilesByPrefix: profileMock.search,
  };
});

const { klipyMock } = vi.hoisted(() => ({
  klipyMock: {
    searchGifs: vi.fn(),
    searchStickers: vi.fn(),
    track: vi.fn(),
  },
}));

vi.mock("../services/klipy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/klipy")>();
  return {
    ...actual,
    searchKlipyGifs: klipyMock.searchGifs,
    searchKlipyStickers: klipyMock.searchStickers,
    trackKlipyShare: klipyMock.track,
  };
});

const { nativeMediaMock } = vi.hoisted(() => ({
  nativeMediaMock: {
    available: false,
    chooseImages: vi.fn(),
    importUri: vi.fn(),
    toFile: vi.fn(),
  },
}));

vi.mock("../services/media/nativeMedia", () => ({
  isNativeMediaIntakeAvailable: () => nativeMediaMock.available,
  chooseNativeImages: (...args: unknown[]) =>
    (nativeMediaMock.chooseImages as (...a: unknown[]) => unknown)(...args),
  importNativeImageUri: (...args: unknown[]) =>
    (nativeMediaMock.importUri as (...a: unknown[]) => unknown)(...args),
  importedImageToFile: (...args: unknown[]) =>
    (nativeMediaMock.toFile as (...a: unknown[]) => unknown)(...args),
}));

function file(name: string, type: string, size = 2048): File {
  return new File([new Uint8Array(size)], name, { type });
}

function baseProps(overrides: Partial<React.ComponentProps<typeof CommentComposer>> = {}) {
  return {
    postId: "p1",
    replyToUsername: null,
    currentUser: { id: "u-9", username: "reader", avatarUrl: null },
    participants: [{ username: "owner", displayName: "Owner", avatarUrl: null }],
    owner: { username: "owner", displayName: "Owner", avatarUrl: null },
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  attachMock.upload.mockReset();
  attachMock.remove.mockReset();
  attachMock.remove.mockResolvedValue(undefined);
  profileMock.search.mockReset();
  profileMock.search.mockResolvedValue([]);
  klipyMock.searchGifs.mockReset();
  klipyMock.searchStickers.mockReset();
  klipyMock.track.mockReset();
  klipyMock.searchGifs.mockResolvedValue([]);
  klipyMock.searchStickers.mockResolvedValue([]);
  nativeMediaMock.available = false;
  nativeMediaMock.chooseImages.mockReset();
  nativeMediaMock.importUri.mockReset();
  nativeMediaMock.toFile.mockReset();
  vi.stubEnv("VITE_KLIPY_API_KEY", "");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("CommentComposer social layout", () => {
  it("renders avatar, expandable input, and a send icon (disabled while empty)", () => {
    render(<CommentComposer {...baseProps()} />);
    expect(screen.getByTestId("user-avatar")).toBeTruthy();
    expect(screen.getByTestId("comment-input").tagName.toLowerCase()).toBe("textarea");
    expect(screen.getByTestId("comment-send").getAttribute("aria-label")).toMatch(/send/i);
    expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "hello" } });
    expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", false);
  });

  it("posts plain text through the parent and clears", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onSent = vi.fn();
    render(<CommentComposer {...baseProps({ onSubmit, onSent })} />);
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "  hello  " } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("hello"));
    expect(onSent).toHaveBeenCalled();
    expect(screen.getByTestId("comment-input")).toHaveProperty("value", "");
  });

  it("surfaces parent failures through onError (never silent)", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("offline down"));
    const onError = vi.fn();
    render(<CommentComposer {...baseProps({ onSubmit, onError })} />);
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "hi" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("offline down"));
  });
});

describe("CommentComposer mentions", () => {
  it("inserts a picked mention (avatar + displayName + @username) and restores the caret", async () => {
    profileMock.search.mockResolvedValue([]);
    render(<CommentComposer {...baseProps()} />);
    const input = screen.getByTestId("comment-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi @ow" } });
    input.setSelectionRange(6, 6);
    fireEvent.keyUp(input);
    fireEvent.click(input);
    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Owner");
    expect(option.textContent).toContain("@owner");
    fireEvent.mouseDown(option);
    await waitFor(() => expect((screen.getByTestId("comment-input") as HTMLTextAreaElement).value).toContain("@owner "));
  });
});

describe("CommentComposer has no emoji affordance (packet `08` §5)", () => {
  it("renders no emoji control and no panel — the platform keyboard is the remaining path", () => {
    globalThis.localStorage?.clear();
    render(<CommentComposer {...baseProps()} />);
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "Wow " } });
    expect(screen.queryByTestId("comment-emoji")).toBeNull();
    expect(screen.queryByTestId("comment-emoji-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: /emoji/i })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /emoji/i })).toBeNull();
  });

  it("never truncates an over-limit draft (validation blocks send, content untouched)", () => {
    render(<CommentComposer {...baseProps()} />);
    const draft = `hi 👨‍👩‍👧${"x".repeat(1000)}`;
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: draft } });
    expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("comment-limit-hint")).toBeTruthy();
    // The draft is preserved verbatim — no sequence is ever split.
    expect((screen.getByTestId("comment-input") as HTMLTextAreaElement).value).toBe(draft);
  });
});

describe("CommentComposer attachments", () => {
  it("refuses a video pick with photos-only copy and stages nothing (packet `08` §7)", async () => {
    render(<CommentComposer {...baseProps()} />);
    fireEvent.change(screen.getByTestId("comment-file-input") as HTMLInputElement, {
      target: { files: [file("clip.mp4", "video/mp4", 4096)] },
    });
    const notice = await screen.findByTestId("comment-attach-notice");
    expect(notice.textContent).toMatch(/photos, not video/i);
    // Nothing staged, nothing uploaded, send stays disabled with an empty draft.
    expect(screen.queryByTestId("comment-attachments")).toBeNull();
    expect(attachMock.upload).not.toHaveBeenCalled();
    expect((screen.getByTestId("comment-file-input") as HTMLInputElement).accept).toBe("image/*");
  });

  it("keeps the accepted file types photos-only in the picker", () => {
    render(<CommentComposer {...baseProps()} />);
    const picker = screen.getByTestId("comment-file-input") as HTMLInputElement;
    expect(picker.accept).toBe("image/*");
    expect(picker.accept).not.toContain("video/");
  });

  it("uploads a picked photo with progress, then posts its https URL (never base64)", async () => {
    let resolveUpload: (() => void) | null = null;
    attachMock.upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = () => resolve({ remoteUrl: "https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-comment-media/u-9/x.jpg", objectKey: "u-9/x.jpg" });
        }),
    );
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CommentComposer {...baseProps({ onSubmit })} />);
    const picker = screen.getByTestId("comment-file-input") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("p.jpg", "image/jpeg")] } });
    // Uploading state blocks send and shows progress (deterministic gate).
    expect(await screen.findByTestId("comment-attachments")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", true));
    expect(screen.queryByTestId("comment-attach-error")).toBeNull();
    resolveUpload!();
    await waitFor(() => expect(attachMock.upload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", false));
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "look" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0]![0] as string;
    expect(body).toContain("![photo](https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-comment-media/u-9/x.jpg)");
    expect(body).not.toContain("data:");
    expect(body).not.toContain("blob:");
  });

  it("exposes staged attachments as ordered descriptors at submit (FB-AUD-02)", async () => {
    const STORAGE_URL =
      "https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-comment-media/u-9/x.jpg";
    attachMock.upload.mockResolvedValue({ remoteUrl: STORAGE_URL, objectKey: "u-9/x.jpg" });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CommentComposer {...baseProps({ onSubmit })} />);
    fireEvent.change(screen.getByTestId("comment-file-input") as HTMLInputElement, {
      target: { files: [file("p.jpg", "image/jpeg")] },
    });
    await waitFor(() => expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", false));
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "look" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Body still carries the https media line for legacy readers.
    expect(onSubmit.mock.calls[0]![0] as string).toContain(`![photo](${STORAGE_URL})`);
    // Ordered descriptors travel alongside for the atomic RPC.
    expect(onSubmit.mock.calls[0]![1]).toEqual([
      {
        kind: "photo",
        display_order: 1,
        storage_key: "u-9/x.jpg",
        remote_url: STORAGE_URL,
        mime_type: "image/jpeg",
        file_name: "p.jpg",
      },
    ]);
  });

  it("submits body-only with no descriptors (backward compat)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CommentComposer {...baseProps({ onSubmit })} />);
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "plain hello" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toBe("plain hello");
    expect(onSubmit.mock.calls[0]).toHaveLength(1);
  });

  describe("toCommentAttachmentDescriptors (FB-AUD-02)", () => {
    it("maps uploaded entries to ordered descriptors, storage first then klipy", () => {
      expect(
        toCommentAttachmentDescriptors([
          {
            id: "a1",
            fileName: "a.jpg",
            mimeType: "image/jpeg",
            kind: "photo",
            status: "uploaded",
            progress: 1,
            previewUrl: "blob:local",
            remoteUrl: "https://cdn.test/a.jpg",
            objectKey: "u-9/a.jpg",
          },
          {
            id: "a2",
            fileName: "Happy",
            mimeType: "image/gif",
            kind: "gif",
            status: "uploaded",
            progress: 1,
            previewUrl: "https://media.klipy.com/happy-preview.gif",
            remoteUrl: "https://media.klipy.com/happy.gif",
            klipySlug: "happy-1",
            klipyKind: "gifs",
          },
        ]),
      ).toEqual([
        {
          kind: "photo",
          display_order: 1,
          storage_key: "u-9/a.jpg",
          remote_url: "https://cdn.test/a.jpg",
          mime_type: "image/jpeg",
          file_name: "a.jpg",
        },
        {
          kind: "gif",
          display_order: 2,
          klipy_slug: "happy-1",
          klipy_kind: "gifs",
          remote_url: "https://media.klipy.com/happy.gif",
          preview_url: "https://media.klipy.com/happy-preview.gif",
          mime_type: "image/gif",
          file_name: "Happy",
        },
      ]);
    });

    it("drops non-uploaded entries and never leaks blob: previews", () => {
      expect(
        toCommentAttachmentDescriptors([
          {
            id: "a1",
            fileName: "pending.jpg",
            mimeType: "image/jpeg",
            kind: "photo",
            status: "uploading",
            progress: 0.5,
            previewUrl: "blob:local",
          },
          {
            id: "a2",
            fileName: "ok.jpg",
            mimeType: "image/jpeg",
            kind: "photo",
            status: "uploaded",
            progress: 1,
            previewUrl: "blob:local",
            remoteUrl: "https://cdn.test/ok.jpg",
            objectKey: "u-9/ok.jpg",
          },
        ]),
      ).toEqual([
        {
          kind: "photo",
          display_order: 1,
          storage_key: "u-9/ok.jpg",
          remote_url: "https://cdn.test/ok.jpg",
          mime_type: "image/jpeg",
          file_name: "ok.jpg",
        },
      ]);
    });

    it("maps a klipy sticker pick to the sticker kind", () => {
      expect(
        toCommentAttachmentDescriptors([
          {
            id: "a1",
            fileName: "Star",
            mimeType: "image/gif",
            kind: "gif",
            status: "uploaded",
            progress: 1,
            previewUrl: "https://media.klipy.com/star-preview.gif",
            remoteUrl: "https://media.klipy.com/star.gif",
            klipySlug: "star-1",
            klipyKind: "stickers",
          },
        ]),
      ).toEqual([
        {
          kind: "sticker",
          display_order: 1,
          klipy_slug: "star-1",
          klipy_kind: "stickers",
          remote_url: "https://media.klipy.com/star.gif",
          preview_url: "https://media.klipy.com/star-preview.gif",
          mime_type: "image/gif",
          file_name: "Star",
        },
      ]);
    });
  });

  it("retries a failed upload and removes entries", async () => {
    attachMock.upload.mockRejectedValueOnce(new Error("offline blip"));
    render(<CommentComposer {...baseProps()} />);
    const picker = screen.getByTestId("comment-file-input") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("p.jpg", "image/jpeg")] } });
    expect(await screen.findByTestId("comment-attach-error")).toBeTruthy();
    expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", true);
    const retry = screen.getByRole("button", { name: /retry attaching/i });
    attachMock.upload.mockResolvedValue({ remoteUrl: "https://cdn/p.jpg", objectKey: "u-9/p.jpg" });
    fireEvent.click(retry);
    await waitFor(() => expect(attachMock.upload).toHaveBeenCalledTimes(2));
    const remove = screen.getByRole("button", { name: /remove p\.jpg/i });
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByTestId("comment-attachments")).toBeNull());
    expect(attachMock.remove).toHaveBeenCalledTimes(1);
  });

  it("rejects non-media files with consumer copy", async () => {
    render(<CommentComposer {...baseProps()} />);
    const picker = screen.getByTestId("comment-file-input") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("doc.pdf", "application/pdf")] } });
    expect(await screen.findByTestId("comment-attach-notice")).toBeTruthy();
    expect(screen.queryByTestId("comment-attachments")).toBeNull();
  });
});

describe("CommentComposer pasted data URLs", () => {
  it("blocks free-text sends holding a data: URL with copy (never inlines base64)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    render(<CommentComposer {...baseProps({ onSubmit, onError })} />);
    fireEvent.change(screen.getByTestId("comment-input"), {
      target: { value: "look data:image/png;base64,AAA" },
    });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0] as string).toMatch(/pasted image data|attach the photo/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("still posts ordinary text with no inline data", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    render(<CommentComposer {...baseProps({ onSubmit, onError })} />);
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "plain hello" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("plain hello"));
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("CommentComposer attachment tiling (display_order + provenance)", () => {
  const STORAGE_URL =
    "https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-comment-media/u-9/x.jpg";

  it("tiles uploads in pick order with position badges and a Storage chip once uploaded", async () => {
    attachMock.upload.mockResolvedValue({ remoteUrl: STORAGE_URL, objectKey: "u-9/x.jpg" });
    render(<CommentComposer {...baseProps()} />);
    const picker = screen.getByTestId("comment-file-input") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("p.jpg", "image/jpeg")] } });
    expect(await screen.findByTestId("comment-attachments")).toBeTruthy();
    const strip = screen.getByTestId("comment-attachments");
    expect(strip.className).toMatch(/grid/);
    await waitFor(() => expect(screen.getByText("Storage")).toBeTruthy());
    const order = screen.getByText("1");
    expect(order.getAttribute("data-testid")).toMatch(/^comment-attachment-order-/);
    const source = screen.getByText("Storage");
    expect(source.getAttribute("data-provenance")).toBe("storage");
  });

  it("tiles a Klipy pick second with order 2 and a KLIPY chip (no redesign)", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    attachMock.upload.mockResolvedValue({ remoteUrl: STORAGE_URL, objectKey: "u-9/x.jpg" });
    klipyMock.searchGifs.mockResolvedValue([
      {
        kind: "gifs",
        slug: "happy-1",
        title: "Happy",
        mediaUrl: "https://media.klipy.com/happy.gif",
        previewUrl: "https://media.klipy.com/happy-preview.gif",
        raw: {},
      },
    ]);
    render(<CommentComposer {...baseProps()} />);
    fireEvent.change(screen.getByTestId("comment-file-input") as HTMLInputElement, {
      target: { files: [file("p.jpg", "image/jpeg")] },
    });
    await waitFor(() => expect(screen.getByText("Storage")).toBeTruthy());
    fireEvent.click(screen.getByTestId("comment-gif"));
    fireEvent.change(screen.getByTestId("comment-gif-search"), { target: { value: "happy" } });
    fireEvent.click(await screen.findByTestId("comment-gif-result-happy-1"));
    await waitFor(() => expect(screen.getByText("KLIPY")).toBeTruthy());
    // Display order follows pick order: photo first, gif second.
    const orders = ["1", "2"].map((n) => screen.getByText(n));
    expect(orders[0]!.compareDocumentPosition(orders[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("KLIPY").getAttribute("data-provenance")).toBe("klipy");
  });
});

describe("CommentComposer Klipy", () => {  it("hides the GIF control when the key is absent (graceful)", () => {    render(<CommentComposer {...baseProps()} />);
    expect(screen.queryByTestId("comment-gif")).toBeNull();
  });

  it("searches Klipy, picks a result, and tracks the share only on post", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    klipyMock.searchGifs.mockResolvedValue([
      {
        kind: "gifs",
        slug: "happy-1",
        title: "Happy",
        mediaUrl: "https://media.klipy.com/happy.gif",
        previewUrl: "https://media.klipy.com/happy-preview.gif",
        raw: {},
      },
    ]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CommentComposer {...baseProps({ onSubmit })} />);
    fireEvent.click(screen.getByTestId("comment-gif"));
    expect(screen.getByTestId("comment-gif-search").getAttribute("placeholder")).toBe("Search KLIPY");
    fireEvent.change(screen.getByTestId("comment-gif-search"), { target: { value: "happy" } });
    const result = await screen.findByTestId("comment-gif-result-happy-1");
    // Direct provider media loading in the grid.
    expect(result.querySelector("img")?.getAttribute("src")).toBe(
      "https://media.klipy.com/happy-preview.gif",
    );
    expect(screen.getByText("Powered by KLIPY")).toBeTruthy();
    // Selecting never tracks (share-tracking is post-only).
    fireEvent.click(result);
    expect(klipyMock.track).not.toHaveBeenCalled();
    expect(await screen.findByTestId("comment-attachments")).toBeTruthy();
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "mood" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const body = onSubmit.mock.calls[0]![0] as string;
    expect(body).toContain("![gif](https://media.klipy.com/happy.gif)");
    await waitFor(() => expect(klipyMock.track).toHaveBeenCalledTimes(1));
    expect(klipyMock.track).toHaveBeenCalledWith("gifs", "happy-1", expect.any(String));
  });
});

describe("CommentComposer Klipy search states", () => {
  function klipyResult(slug: string) {
    return {
      kind: "gifs" as const,
      slug,
      title: slug,
      mediaUrl: `https://media.klipy.com/${slug}.gif`,
      previewUrl: `https://media.klipy.com/${slug}.gif`,
      raw: {},
    };
  }

  it("keeps the latest search results when responses race (latest-wins)", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    let resolveFirst!: (items: unknown[]) => void;
    let resolveSecond!: (items: unknown[]) => void;
    klipyMock.searchGifs
      .mockImplementationOnce(() => new Promise<unknown[]>((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise<unknown[]>((r) => { resolveSecond = r; }));
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-gif"));
    // Panel open fires the trending search; typing supersedes it.
    await waitFor(() => expect(klipyMock.searchGifs).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("comment-gif-search"), { target: { value: "ab" } });
    await waitFor(() => expect(klipyMock.searchGifs).toHaveBeenCalledTimes(2));
    // Stale first response resolves first — and must be discarded.
    resolveFirst([klipyResult("stale-1")]);
    resolveSecond([klipyResult("fresh-1")]);
    expect(await screen.findByTestId("comment-gif-result-fresh-1")).toBeTruthy();
    expect(screen.queryByTestId("comment-gif-result-stale-1")).toBeNull();
  });

  it("shows a retryable error when search fails, then recovers", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    klipyMock.searchGifs.mockRejectedValueOnce(new Error("offline"));
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-gif"));
    expect(await screen.findByTestId("comment-gif-retry")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't load/i);
    klipyMock.searchGifs.mockResolvedValue([]);
    fireEvent.click(screen.getByTestId("comment-gif-retry"));
    await waitFor(() => expect(screen.queryByTestId("comment-gif-retry")).toBeNull());
  });
});

describe("CommentComposer Klipy picker feel", () => {
  function sized(slug: string, width: number, height: number) {
    return {
      kind: "gifs" as const,
      slug,
      title: slug,
      mediaUrl: `https://media.klipy.com/${slug}.gif`,
      previewUrl: `https://media.klipy.com/${slug}.gif`,
      width,
      height,
      raw: {},
    };
  }

  it("shows a skeleton (not a bare text label) while a search is in flight", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    let resolve!: (items: unknown[]) => void;
    klipyMock.searchGifs.mockImplementation(() => new Promise<unknown[]>((r) => { resolve = r; }));
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-gif"));
    await waitFor(() => expect(klipyMock.searchGifs).toHaveBeenCalled());
    // Progress is announced for assistive tech but not shown as visible text.
    expect(screen.getByText("Searching GIFs")).toBeTruthy();
    expect(screen.getByTestId("comment-gif-panel").querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    resolve([sized("resolved-1", 400, 300)]);
    expect(await screen.findByTestId("comment-gif-result-resolved-1")).toBeTruthy();
    expect(screen.queryByText("Searching GIFs")).toBeNull();
  });

  it("lays results out as a natural-aspect waterfall tile", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    klipyMock.searchGifs.mockResolvedValue([sized("wide", 400, 200), sized("unknown", 0, 0)]);
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-gif"));
    const wide = await screen.findByTestId("comment-gif-result-wide");
    expect(wide.getAttribute("style")).toContain("aspect-ratio: 2 / 1");
    // Missing dimensions fall back to a square tile, never a broken layout.
    const unknown = screen.getByTestId("comment-gif-result-unknown");
    expect(unknown.getAttribute("style")).toContain("aspect-ratio: 1 / 1");
  });

  it("clamps an absurd provider aspect ratio to a sane tile", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    klipyMock.searchGifs.mockResolvedValue([sized("tall", 10, 5000)]);
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-gif"));
    const tall = await screen.findByTestId("comment-gif-result-tall");
    expect(tall.getAttribute("style")).toContain("aspect-ratio: 0.5 / 1");
  });

  it("keeps the tab and retry controls at the repo 44px touch-target minimum", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    klipyMock.searchGifs.mockRejectedValueOnce(new Error("offline"));
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-gif"));
    for (const tab of ["comment-gif-tab-gifs", "comment-gif-tab-stickers"]) {
      expect(screen.getByTestId(tab).className).toContain("min-h-[44px]");
    }
    expect(screen.getByTestId("comment-gif-search").className).toContain("min-h-[44px]");
    const retry = await screen.findByTestId("comment-gif-retry");
    expect(retry.className).toContain("min-h-[44px]");
  });

  it("clears the query with a dedicated control (returns to trending)", async () => {
    vi.stubEnv("VITE_KLIPY_API_KEY", "testing-key");
    klipyMock.searchGifs.mockResolvedValue([sized("happy-1", 400, 200)]);
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-gif"));
    const search = screen.getByTestId("comment-gif-search") as HTMLInputElement;
    expect(screen.queryByTestId("comment-gif-search-clear")).toBeNull();
    fireEvent.change(search, { target: { value: "happy" } });
    expect(await screen.findByTestId("comment-gif-search-clear")).toBeTruthy();
    fireEvent.click(screen.getByTestId("comment-gif-search-clear"));
    expect(search.value).toBe("");
    expect(screen.queryByTestId("comment-gif-search-clear")).toBeNull();
  });
});

describe("CommentComposer native photo intake (FBX-038)", () => {
  it("picks photos through the canonical intake on Android and uploads them", async () => {
    nativeMediaMock.available = true;
    nativeMediaMock.chooseImages.mockResolvedValue(["content://media/external/1"]);
    nativeMediaMock.importUri.mockResolvedValue({ id: "img_1" });
    nativeMediaMock.toFile.mockReturnValue(file("photo.jpg", "image/jpeg"));
    attachMock.upload.mockResolvedValue({
      remoteUrl:
        "https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-comment-media/u-9/x.jpg",
      objectKey: "u-9/x.jpg",
    });
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-attach"));
    await waitFor(() =>
      expect(nativeMediaMock.chooseImages).toHaveBeenCalledWith({ source: "photos", limit: 4 }),
    );
    expect(await screen.findByTestId("comment-attachments")).toBeTruthy();
    await waitFor(() => expect(attachMock.upload).toHaveBeenCalledTimes(1));
  });

  it("keeps prepared siblings when one native URI fails", async () => {
    nativeMediaMock.available = true;
    nativeMediaMock.chooseImages.mockResolvedValue(["content://media/1", "content://media/2"]);
    nativeMediaMock.importUri
      .mockRejectedValueOnce(new Error("bad item"))
      .mockResolvedValueOnce({ id: "img_2" });
    nativeMediaMock.toFile.mockReturnValue(file("photo.jpg", "image/jpeg"));
    attachMock.upload.mockResolvedValue({
      remoteUrl:
        "https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-comment-media/u-9/x.jpg",
      objectKey: "u-9/x.jpg",
    });
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-attach"));
    await waitFor(() => expect(nativeMediaMock.chooseImages).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("comment-attachments")).toBeTruthy();
    expect(await screen.findByTestId("comment-attach-notice")).toBeTruthy();
    expect(screen.getByTestId("comment-attach-notice").textContent).toMatch(/rest are uploading/i);
    await waitFor(() => expect(attachMock.upload).toHaveBeenCalledTimes(1));
  });

  it("treats a cancelled native pick as a silent no-op", async () => {
    nativeMediaMock.available = true;
    nativeMediaMock.chooseImages.mockResolvedValue(null);
    render(<CommentComposer {...baseProps()} />);
    fireEvent.click(screen.getByTestId("comment-attach"));
    await waitFor(() => expect(nativeMediaMock.chooseImages).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("comment-attachments")).toBeNull();
    expect(screen.queryByTestId("comment-attach-notice")).toBeNull();
    expect(attachMock.upload).not.toHaveBeenCalled();
  });
});

describe("CommentComposer abandon sweep (FB-AUD-04)", () => {
  const STORAGE_URL =
    "https://nfjhpigbsyyoaaktfaev.supabase.co/storage/v1/object/public/findback-comment-media/u-9/x.jpg";

  function stageUploadedPhoto() {
    attachMock.upload.mockResolvedValue({ remoteUrl: STORAGE_URL, objectKey: "u-9/x.jpg" });
    fireEvent.change(screen.getByTestId("comment-file-input") as HTMLInputElement, {
      target: { files: [file("p.jpg", "image/jpeg")] },
    });
    return waitFor(() => expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", false));
  }

  it("best-effort-deletes staged uploaded keys on unmount without submit (never console.error)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Even a storage-remove failure must stay silent at error level.
    attachMock.remove.mockRejectedValueOnce(new Error("sweep failed"));
    try {
      const { unmount } = render(<CommentComposer {...baseProps()} />);
      await stageUploadedPhoto();
      expect(attachMock.remove).not.toHaveBeenCalled();
      unmount();
      await waitFor(() => expect(attachMock.remove).toHaveBeenCalledTimes(1));
      expect(attachMock.remove.mock.calls[0]![0]).toMatchObject({
        objectKey: "u-9/x.jpg",
        remoteUrl: STORAGE_URL,
      });
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does NOT delete row-referenced keys after a successful submit (unmount-safe)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<CommentComposer {...baseProps({ onSubmit })} />);
    await stageUploadedPhoto();
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "look" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    unmount();
    expect(attachMock.remove).not.toHaveBeenCalled();
  });

  it("explicit remove still deletes the staged object (no double-sweep on unmount)", async () => {
    const { unmount } = render(<CommentComposer {...baseProps()} />);
    await stageUploadedPhoto();
    fireEvent.click(screen.getByRole("button", { name: /remove p\.jpg/i }));
    await waitFor(() => expect(attachMock.remove).toHaveBeenCalledTimes(1));
    expect(attachMock.remove.mock.calls[0]![0]).toMatchObject({ objectKey: "u-9/x.jpg" });
    unmount();
    expect(attachMock.remove).toHaveBeenCalledTimes(1);
  });

  it("failed submit keeps staged entries for retry (no sweep, still sendable)", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("offline down")).mockResolvedValue(undefined);
    const onError = vi.fn();
    render(<CommentComposer {...baseProps({ onSubmit, onError })} />);
    await stageUploadedPhoto();
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "look" } });
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    // Staged upload survives for retry: strip still present, nothing deleted.
    expect(screen.getByTestId("comment-attachments")).toBeTruthy();
    expect(attachMock.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("comment-send"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });
});
