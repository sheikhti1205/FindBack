import { beforeEach, describe, expect, it, vi } from "vitest";

const { uploadImageMock, removeStagedUploadMock, createPostMock } = vi.hoisted(() => ({
  uploadImageMock: vi.fn(),
  removeStagedUploadMock: vi.fn(),
  createPostMock: vi.fn(),
}));

vi.mock("./postsUpload", () => ({ uploadImage: (...args: unknown[]) => uploadImageMock(...args), removeStagedUpload: (...args: unknown[]) => removeStagedUploadMock(...args) }));
vi.mock("./postsCreate", () => ({ createPost: (...args: unknown[]) => createPostMock(...args) }));

import { publishReport } from "./posts";

const input = {
  type: "LOST" as const,
  title: "Lost phone",
  description: "a black phone lost on campus",
  category: "Electronics" as const,
  eventDate: "2026-09-10",
};

beforeEach(() => {
  uploadImageMock.mockReset();
  removeStagedUploadMock.mockReset();
  createPostMock.mockReset();
});

describe("publishReport", () => {
  it("creates without any upload when there is no photo", async () => {
    createPostMock.mockResolvedValue("p1");
    await expect(publishReport(input, null)).resolves.toBe("p1");
    expect(uploadImageMock).not.toHaveBeenCalled();
  });

  it("uploads, stages, creates and leaves the object on success", async () => {
    const stored = { id: "u1", objectKey: "user-1/u1.jpg", fileUrl: "https://cdn/x.jpg" };
    uploadImageMock.mockResolvedValue(stored);
    createPostMock.mockResolvedValue("p1");

    await expect(publishReport(input, new File(["x"], "p.jpg", { type: "image/jpeg" }), "test-trace-id")).resolves.toBe("p1");

    expect(createPostMock).toHaveBeenCalledWith(expect.objectContaining({ attachmentKey: "u1" }), "test-trace-id");
    expect(removeStagedUploadMock).not.toHaveBeenCalled();
  });

  it("removes the exact object and staging row when create fails", async () => {
    const stored = { id: "u1", objectKey: "user-1/u1.jpg", fileUrl: "https://cdn/x.jpg" };
    uploadImageMock.mockResolvedValue(stored);
    createPostMock.mockRejectedValue(new Error("create failed"));

    await expect(publishReport(input, new File(["x"], "p.jpg", { type: "image/jpeg" }), "test-trace-id")).rejects.toThrow("create failed");
    expect(removeStagedUploadMock).toHaveBeenCalledWith(stored, "test-trace-id");
  });

  it("does not call create when staging itself fails", async () => {
    uploadImageMock.mockRejectedValue(new Error("rls denied"));
    await expect(publishReport(input, new File(["x"], "p.jpg", { type: "image/jpeg" }))).rejects.toThrow("rls denied");
    expect(createPostMock).not.toHaveBeenCalled();
  });
});
