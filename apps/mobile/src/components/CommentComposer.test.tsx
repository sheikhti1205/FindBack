// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./CommentComposer";

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

describe("CommentComposer emoji", () => {
  it("opens a web picker panel and inserts at the caret (no vendor keyboard)", () => {
    render(<CommentComposer {...baseProps()} />);
    expect(screen.queryByTestId("comment-emoji-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("comment-emoji"));
    expect(screen.getByTestId("comment-emoji-panel").getAttribute("role")).toBe("dialog");
    fireEvent.change(screen.getByTestId("comment-input"), { target: { value: "Wow " } });
    fireEvent.click(screen.getByTestId("comment-emoji-🔥"));
    expect((screen.getByTestId("comment-input") as HTMLTextAreaElement).value).toContain("Wow 🔥");
  });
});

describe("CommentComposer attachments", () => {
  it("uploads a picked photo with progress, then posts its https URL (never base64)", async () => {
    let resolveUpload: (() => void) | null = null;
    attachMock.upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = () => resolve({ remoteUrl: "https://cdn/p.jpg", objectKey: "u-9/x.jpg" });
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
    expect(body).toContain("![photo](https://cdn/p.jpg)");
    expect(body).not.toContain("data:");
    expect(body).not.toContain("blob:");
  });

  it("retries a failed upload and removes entries", async () => {
    attachMock.upload.mockRejectedValueOnce(new Error("offline blip"));
    render(<CommentComposer {...baseProps()} />);
    const picker = screen.getByTestId("comment-file-input") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file("v.mp4", "video/mp4")] } });
    expect(await screen.findByTestId("comment-attach-error")).toBeTruthy();
    expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", true);
    const retry = screen.getByRole("button", { name: /retry attaching/i });
    attachMock.upload.mockResolvedValue({ remoteUrl: "https://cdn/v.mp4", objectKey: "u-9/v.mp4" });
    fireEvent.click(retry);
    await waitFor(() => expect(attachMock.upload).toHaveBeenCalledTimes(2));
    const remove = screen.getByRole("button", { name: /remove v\.mp4/i });
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

describe("CommentComposer Klipy", () => {  it("hides the GIF control when the key is absent (graceful)", () => {
    render(<CommentComposer {...baseProps()} />);
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
