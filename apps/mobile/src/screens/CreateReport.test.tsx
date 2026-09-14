// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadImageMock, suggestMock } = vi.hoisted(() => ({
  uploadImageMock: vi.fn(),
  suggestMock: vi.fn(),
}));

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../services/posts", () => ({
  uploadImage: uploadImageMock,
  createPost: vi.fn(),
}));
vi.mock("../services/ml", () => ({ suggestCategoryFromImage: suggestMock }));

import { CreateReport } from "./CreateReport";

const SUGGEST = /suggest category/i;

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  uploadImageMock.mockReset();
  suggestMock.mockReset();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("CreateReport on-device ML", () => {
  it("suggests from the selected local File even before the upload finishes", async () => {
    let resolveUpload!: (value: unknown) => void;
    uploadImageMock.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    suggestMock.mockResolvedValue({ category: "Electronics", confidence: 0.8, rawLabel: "laptop" });

    render(<CreateReport />);
    const file = new File(["abc"], "phone.jpg", { type: "image/jpeg" });
    pickFile(file);

    // The upload is still pending, yet local ML is available.
    const button = await screen.findByRole("button", { name: SUGGEST });
    fireEvent.click(button);

    await waitFor(() => expect(suggestMock).toHaveBeenCalledTimes(1));
    expect(suggestMock.mock.calls[0]![0]).toBe(file);

    resolveUpload({ id: "up1", fileUrl: "https://cdn.example.com/phone.jpg" });
  });

  it("clears the selected file and preview when the photo is removed", async () => {
    uploadImageMock.mockResolvedValue({ id: "up1", fileUrl: "https://cdn.example.com/p.jpg" });
    render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));

    await screen.findByRole("button", { name: SUGGEST });

    fireEvent.click(screen.getByRole("button", { name: /remove photo/i }));

    expect(screen.queryByRole("button", { name: SUGGEST })).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("uses the newly selected File after replacing the photo", async () => {
    uploadImageMock.mockResolvedValue({ id: "up1", fileUrl: "https://cdn.example.com/p.jpg" });
    suggestMock.mockResolvedValue({ category: "Other", confidence: 0.1, rawLabel: "thing" });
    render(<CreateReport />);

    const first = new File(["1"], "a.jpg", { type: "image/jpeg" });
    pickFile(first);
    await screen.findByRole("button", { name: SUGGEST });
    fireEvent.click(screen.getByRole("button", { name: /remove photo/i }));

    const second = new File(["2"], "b.jpg", { type: "image/jpeg" });
    pickFile(second);
    fireEvent.click(await screen.findByRole("button", { name: SUGGEST }));

    // File instances compare equal under deep-equality in jsdom, so assert identity.
    await waitFor(() => expect(suggestMock).toHaveBeenCalledTimes(1));
    expect(suggestMock.mock.calls[0]![0]).toBe(second);
  });

  it("keeps local ML usable when the cloud upload fails", async () => {
    uploadImageMock.mockRejectedValue(new Error("Upload failed"));
    suggestMock.mockResolvedValue({ category: "Electronics", confidence: 0.9, rawLabel: "laptop" });
    render(<CreateReport />);
    const file = new File(["abc"], "p.jpg", { type: "image/jpeg" });
    pickFile(file);

    await screen.findByRole("alert");
    fireEvent.click(await screen.findByRole("button", { name: SUGGEST }));

    await waitFor(() => expect(suggestMock).toHaveBeenCalledTimes(1));
    expect(suggestMock.mock.calls[0]![0]).toBe(file);
  });

  it("shows a clear message when the bundled model is unavailable", async () => {
    uploadImageMock.mockResolvedValue({ id: "up1", fileUrl: "https://cdn.example.com/p.jpg" });
    suggestMock.mockRejectedValue(
      new Error("On-device category model is unavailable in this build."),
    );
    render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));

    fireEvent.click(await screen.findByRole("button", { name: SUGGEST }));

    await screen.findByText(/model is unavailable/i);
  });
});
