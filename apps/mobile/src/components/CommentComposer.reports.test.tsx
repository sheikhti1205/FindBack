// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer, toCommentAttachmentDescriptors } from "./CommentComposer";
import { ApiError } from "../services/session";

const state = vi.hoisted(() => ({
  enabled: false, fetchPost: vi.fn(), native: false, choose: vi.fn(), prepare: vi.fn(), upload: vi.fn(),
}));
vi.mock("../services/commentAttachments", async (original) => ({
  ...await original<typeof import("../services/commentAttachments")>(),
  get COMMENT_REPORTS_ENABLED() { return state.enabled; },
  isNativeCommentPhotoIntakeAvailable: async () => state.native,
  importCommentPhotoFromNativeUri: state.prepare,
  uploadCommentAttachment: state.upload,
}));
vi.mock("../services/posts", () => ({ fetchPost: state.fetchPost }));
vi.mock("../services/media/nativeMedia", () => ({ chooseNativeImages: state.choose }));

const reportId = "11111111-1111-4111-8111-111111111111";
const reportUrl = `https://findback.example/r/${reportId}`;
const staged = {
  id: `report-${reportId}`, kind: "report" as const, status: "uploaded" as const,
  reportPostId: reportId, title: "Found blue wallet",
};

function props() {
  return { postId: "parent", participants: [], onSubmit: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
}
async function stageReport() {
  fireEvent.click(screen.getByRole("button", { name: "Attach a report" }));
  fireEvent.change(screen.getByLabelText("Report link"), { target: { value: reportUrl } });
  fireEvent.click(screen.getByRole("button", { name: "Add report" }));
  await screen.findByRole("button", { name: "Remove report: Found blue wallet" });
  await waitFor(() => expect(screen.queryByLabelText("Report link")).toBeNull());
}

beforeEach(() => {
  state.enabled = true;
  state.native = false;
  state.choose.mockReset(); state.prepare.mockReset(); state.upload.mockReset();
  state.fetchPost.mockReset().mockResolvedValue({ id: reportId, title: "Found blue wallet" });
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://findback.example");
  vi.stubEnv("VITE_KLIPY_API_KEY", "");
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("typed report references in the composer", () => {
  it("renders no picker affordance when the release gate is off", () => {
    state.enabled = false;
    render(<CommentComposer {...props()} />);
    expect(screen.queryByRole("button", { name: "Attach a report" })).toBeNull();
    expect(screen.queryByLabelText("Report link")).toBeNull();
  });

  it("sends a report-only comment with an empty body and no media fields", async () => {
    const p = props();
    render(<CommentComposer {...p} />);
    await stageReport();
    expect(screen.getByRole("button", { name: "Send comment" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() => expect(p.onSubmit).toHaveBeenCalledWith("", [
      { kind: "report", display_order: 1, report_post_id: reportId },
    ]));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Remove report:/ })).toBeNull());
  });

  it("removes the reference and restores the empty-draft send guard", async () => {
    const p = props();
    render(<CommentComposer {...p} />);
    await stageReport();
    fireEvent.click(screen.getByRole("button", { name: "Remove report: Found blue wallet" }));
    expect(screen.getByRole("button", { name: "Send comment" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() => expect(p.onSubmit).toHaveBeenCalledWith("hello"));
  });

  it("keeps the draft and removable reference after a coded unavailable-target failure", async () => {
    const p = props();
    p.onSubmit.mockRejectedValue(new ApiError("Report not found", 404, "P0002"));
    render(<CommentComposer {...p} />);
    await stageReport();
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() => expect(p.onError).toHaveBeenCalledWith("Report unavailable — remove the reference to post your comment."));
    expect(screen.getByRole("button", { name: "Remove report: Found blue wallet" })).toHaveProperty("disabled", false);
  });

  it.each([
    [new ApiError("Post not found", 404), "bare 404"],
    [new ApiError("Post not found", 404, "P0002"), "parent gone without a reference"],
  ])("retains ordinary send failure copy for %s (%s)", async (error) => {
    const p = props();
    p.onSubmit.mockRejectedValue(error);
    render(<CommentComposer {...p} />);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() => expect(p.onError).toHaveBeenCalledWith("Couldn't post your comment. Try again."));
  });

  it("rejects foreign links before resolving them", () => {
    render(<CommentComposer {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach a report" }));
    fireEvent.change(screen.getByLabelText("Report link"), { target: { value: `https://other.example/r/${reportId}` } });
    fireEvent.click(screen.getByRole("button", { name: "Add report" }));
    expect(screen.getByRole("alert").textContent).toBe("Paste a FindBack report link.");
    expect(state.fetchPost).not.toHaveBeenCalled();
  });

  it.each([
    [new ApiError("not readable", 404), "Report unavailable"],
    [new Error("private transport detail"), "Couldn't load that report. Try again."],
  ])("refuses unresolved reports without leaking the raw error (%s)", async (error, copy) => {
    state.fetchPost.mockRejectedValue(error);
    render(<CommentComposer {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach a report" }));
    fireEvent.change(screen.getByLabelText("Report link"), { target: { value: reportUrl } });
    fireEvent.click(screen.getByRole("button", { name: "Add report" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(copy));
    expect(screen.getByRole("button", { name: "Send comment" })).toHaveProperty("disabled", true);
  });

  it("ignores a pending resolution after closing the picker", async () => {
    let resolve!: (value: unknown) => void;
    state.fetchPost.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<CommentComposer {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach a report" }));
    fireEvent.change(screen.getByLabelText("Report link"), { target: { value: reportUrl } });
    fireEvent.click(screen.getByRole("button", { name: "Add report" }));
    fireEvent.keyDown(screen.getByLabelText("Report link"), { key: "Escape" });
    await act(async () => resolve({ id: reportId, title: "Found blue wallet" }));
    expect(screen.queryByRole("button", { name: /Remove report:/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Attach a report" })).toBe(document.activeElement);
  });

  it("can resolve again after being disabled during a pending lookup", async () => {
    let resolve!: (value: unknown) => void;
    state.fetchPost.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const p = props();
    const { rerender } = render(<CommentComposer {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach a report" }));
    fireEvent.change(screen.getByLabelText("Report link"), { target: { value: reportUrl } });
    fireEvent.click(screen.getByRole("button", { name: "Add report" }));
    rerender(<CommentComposer {...p} disabled />);
    await act(async () => resolve({ id: reportId, title: "Old result" }));
    rerender(<CommentComposer {...p} />);
    expect(screen.getByRole("button", { name: "Add report" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Add report" }));
    await screen.findByRole("button", { name: "Remove report: Found blue wallet" });
    expect(screen.queryByRole("button", { name: "Remove report: Old result" })).toBeNull();
  });

  it("does not let the same report occupy multiple attachment slots", async () => {
    render(<CommentComposer {...props()} />);
    await stageReport();
    await stageReport();
    expect(screen.getAllByRole("button", { name: "Remove report: Found blue wallet" })).toHaveLength(1);
  });

  it("keeps generic copy for a bare 404 even when a reference is staged", async () => {
    const p = props();
    p.onSubmit.mockRejectedValue(new ApiError("Post not found", 404));
    render(<CommentComposer {...p} />);
    await stageReport();
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() => expect(p.onError).toHaveBeenCalledWith("Couldn't post your comment. Try again."));
  });

  it("locks staged reference removal while a send is pending", async () => {
    const p = props();
    let resolve!: () => void;
    p.onSubmit.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    render(<CommentComposer {...p} />);
    await stageReport();
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    const remove = screen.getByRole("button", { name: /Remove report:/ });
    expect(remove).toHaveProperty("disabled", true);
    fireEvent.click(remove);
    expect(screen.getByRole("button", { name: /Remove report:/ })).toBeTruthy();
    await act(async () => resolve());
  });

  it("counts reports toward the shared attachment cap and frees a slot on removal", async () => {
    state.fetchPost.mockImplementation(async (id: string) => ({ id, title: id }));
    render(<CommentComposer {...props()} />);
    for (let i = 1; i <= 4; i++) {
      const id = `${i}1111111-1111-4111-8111-111111111111`;
      fireEvent.click(screen.getByRole("button", { name: "Attach a report" }));
      fireEvent.change(screen.getByLabelText("Report link"), { target: { value: `https://findback.example/r/${id}` } });
      fireEvent.click(screen.getByRole("button", { name: "Add report" }));
      await screen.findByRole("button", { name: `Remove report: ${id}` });
    }
    expect(screen.getByRole("button", { name: "Attach a report" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getAllByRole("button", { name: /Remove report:/ })[0]!);
    expect(screen.getByRole("button", { name: "Attach a report" })).toHaveProperty("disabled", false);
  });

  it("reserves the final slot while native photo preparation overlaps a report-selection attempt", async () => {
    const p = props();
    state.fetchPost.mockImplementation(async (id: string) => ({ id, title: id }));
    state.native = true;
    state.choose.mockResolvedValue(["content://fixture/photo"]);
    let finish!: (value: unknown) => void;
    state.prepare.mockReturnValue(new Promise((r) => { finish = r; }));
    state.upload.mockResolvedValue({ remoteUrl: "https://media.klipy.com/photo.jpg", objectKey: "u/photo.jpg" });
    render(<CommentComposer {...p} />);
    for (let i = 1; i <= 3; i++) {
      const id = `${i}1111111-1111-4111-8111-111111111111`;
      fireEvent.click(screen.getByRole("button", { name: "Attach a report" }));
      fireEvent.change(screen.getByLabelText("Report link"), { target: { value: `https://findback.example/r/${id}` } });
      fireEvent.click(screen.getByRole("button", { name: "Add report" }));
      await screen.findByRole("button", { name: `Remove report: ${id}` });
    }
    fireEvent.click(screen.getByRole("button", { name: "Attach a photo" }));
    await waitFor(() => expect(state.prepare).toHaveBeenCalledTimes(1));
    const reportControl = screen.getByRole("button", { name: "Attach a report" });
    expect(reportControl).toHaveProperty("disabled", true);
    fireEvent.click(reportControl);
    expect(screen.queryByLabelText("Report link")).toBeNull();
    expect(screen.getByRole("button", { name: "Send comment" })).toHaveProperty("disabled", true);
    await act(async () => finish({
      entry: { id: "native-photo", kind: "photo", status: "ready", progress: 0, previewUrl: "blob:fixture", fileName: "photo.jpg", mimeType: "image/jpeg" },
      file: new File(["image"], "photo.jpg", { type: "image/jpeg" }),
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send comment" })).toHaveProperty("disabled", false));
    expect(screen.getByRole("group", { name: "Attachments, 4 of 4" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() => expect(p.onSubmit).toHaveBeenCalledTimes(1));
    expect(p.onSubmit.mock.calls[0]![1]).toHaveLength(4);
  });

  it("serializes mixed kinds in one-based order and strips every media field from reports", () => {
    const contaminated = { ...staged, remoteUrl: "https://bad.example/a.jpg", mimeType: "image/jpeg", previewUrl: "https://bad.example/p.jpg", objectKey: "bad" };
    expect(toCommentAttachmentDescriptors([
      { id: "photo", kind: "photo", status: "uploaded", fileName: "photo.jpg", mimeType: "image/jpeg", progress: 1,
        previewUrl: "blob:preview", remoteUrl: "https://storage.example/a.jpg" },
      contaminated,
    ])).toEqual([
      { kind: "photo", display_order: 1, remote_url: "https://storage.example/a.jpg", mime_type: "image/jpeg", file_name: "photo.jpg" },
      { kind: "report", display_order: 2, report_post_id: reportId },
    ]);
  });
});
