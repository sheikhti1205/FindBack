// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, suggestMock } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  suggestMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../services/posts", () => ({ publishReport: publishReportMock }));
vi.mock("../services/ml", () => ({ suggestCategoryFromImage: suggestMock }));

import { CreateReport } from "./CreateReport";

const SUGGEST = /suggest category/i;

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  publishReportMock.mockReset();
  suggestMock.mockReset();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("CreateReport on-device ML", () => {
  it("suggests from the selected local File", async () => {
    suggestMock.mockResolvedValue({ category: "Electronics", confidence: 0.8, rawLabel: "laptop" });

    render(<CreateReport />);
    const file = new File(["abc"], "phone.jpg", { type: "image/jpeg" });
    pickFile(file);

    const button = await screen.findByRole("button", { name: SUGGEST });
    fireEvent.click(button);

    await waitFor(() => expect(suggestMock).toHaveBeenCalledTimes(1));
    expect(suggestMock.mock.calls[0]![0]).toBe(file);

  });

  it("clears the selected file and preview when the photo is removed", async () => {
    render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));

    await screen.findByRole("button", { name: SUGGEST });

    fireEvent.click(screen.getByRole("button", { name: /remove photo/i }));

    expect(screen.queryByRole("button", { name: SUGGEST })).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("uses the newly selected File after replacing the photo", async () => {
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

  it("does not upload when a photo is selected", async () => {
    render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("publishes with the selected photo on submit", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    const file = new File(["abc"], "p.jpg", { type: "image/jpeg" });
    pickFile(file);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publishReportMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Lost phone" }), file));
  });

  it("keeps the selected photo when publish fails", async () => {
    publishReportMock.mockRejectedValue(new Error("Could not publish"));
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await screen.findByText(/could not publish/i);
    expect(screen.getByRole("img", { name: /attachment preview/i })).toBeTruthy();
  });

  it("shows a clear message when the bundled model is unavailable", async () => {
    suggestMock.mockRejectedValue(
      new Error("On-device category model is unavailable in this build."),
    );
    render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));

    fireEvent.click(await screen.findByRole("button", { name: SUGGEST }));

    await screen.findByText(/model is unavailable/i);
  });
});
