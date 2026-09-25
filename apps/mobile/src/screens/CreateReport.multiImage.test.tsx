// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, publishReportWithPhotosMock, photo } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  publishReportWithPhotosMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    photoToFile: vi.fn(),
    toNativeImageUri: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  Plugins: { ShortLinkResolver: { resolve: vi.fn() } },
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../services/posts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/posts")>();
  return {
    ...actual,
    publishReport: (...args: unknown[]) => publishReportMock(...args),
    publishReportWithPhotos: (...args: unknown[]) => publishReportWithPhotosMock(...args),
  };
});
vi.mock("../services/photo", () => photo);

import { CreateReport } from "./CreateReport";
import { clearDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";
import { todayInputValue } from "../utils/dates";

function seedBasics(): void {
  saveDraft({
    type: "LOST",
    title: "",
    description: "a black phone lost near the library entrance",
    category: "",
    eventDate: todayInputValue(),
    location: { label: "", latitude: null, longitude: null },
    youtubeUrl: "",
    photoId: null,
    photoNativeUri: null,
    photoWebPath: null,
    photoFormat: null,
  });
}

function pickFile(file: File): void {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  if (inputs.length === 0) throw new Error("file input not found");
  const input = inputs[inputs.length - 1] as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

function fillTitleCategory(title: string): void {
  fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: title } });
  fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
}

function submit(): void {
  fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
}

beforeEach(() => {
  publishReportMock.mockReset();
  publishReportWithPhotosMock.mockReset();
  publishReportWithPhotosMock.mockResolvedValue("p-multi");
  clearDraft();
  clearPhotoStore();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearDraft();
  clearPhotoStore();
});

describe("CreateReport multi-image", () => {
  it("a single photo still uses the legacy single-photo publish path", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedBasics();
    render(<CreateReport />);
    fillTitleCategory("Lost phone");
    const file = new File(["abc"], "p.jpg", { type: "image/jpeg" });
    pickFile(file);
    submit();

    await waitFor(() =>
      expect(publishReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        file,
        expect.any(String),
      ),
    );
    expect(publishReportWithPhotosMock).not.toHaveBeenCalled();
  });

  it("two photos publish in displayed order via the multi path", async () => {
    seedBasics();
    render(<CreateReport />);
    fillTitleCategory("Lost phone");
    const first = new File(["one"], "one.jpg", { type: "image/jpeg" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });
    pickFile(first);
    await screen.findByRole("img", { name: /attachment preview 1/i });
    pickFile(second);
    await screen.findByRole("img", { name: /attachment preview 2/i });
    submit();

    await waitFor(() =>
      expect(publishReportWithPhotosMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        [first, second],
        expect.objectContaining({ traceId: expect.any(String) }),
      ),
    );
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("moving a photo earlier changes the published order", async () => {
    seedBasics();
    render(<CreateReport />);
    fillTitleCategory("Lost phone");
    const first = new File(["one"], "one.jpg", { type: "image/jpeg" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });
    pickFile(first);
    await screen.findByRole("img", { name: /attachment preview 1/i });
    pickFile(second);
    await screen.findByRole("img", { name: /attachment preview 2/i });

    fireEvent.click(screen.getByRole("button", { name: /move photo 2 earlier/i }));
    submit();

    await waitFor(() =>
      expect(publishReportWithPhotosMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        [second, first],
        expect.objectContaining({ traceId: expect.any(String) }),
      ),
    );
  });

  it("removing the middle photo publishes the rest in order", async () => {
    seedBasics();
    render(<CreateReport />);
    fillTitleCategory("Lost phone");
    const first = new File(["one"], "one.jpg", { type: "image/jpeg" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });
    const third = new File(["three"], "three.jpg", { type: "image/jpeg" });
    pickFile(first);
    await screen.findByRole("img", { name: /attachment preview 1/i });
    pickFile(second);
    await screen.findByRole("img", { name: /attachment preview 2/i });
    pickFile(third);
    await screen.findByRole("img", { name: /attachment preview 3/i });

    fireEvent.click(screen.getByRole("button", { name: /remove photo 2/i }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: /attachment preview 3/i })).toBeNull(),
    );
    submit();

    await waitFor(() =>
      expect(publishReportWithPhotosMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        [first, third],
        expect.objectContaining({ traceId: expect.any(String) }),
      ),
    );
  });

  it("five photos show the cap message and no sixth can be added", async () => {
    seedBasics();
    render(<CreateReport />);
    for (let n = 1; n <= 5; n += 1) {
      pickFile(new File([`bytes-${n}`], `p${n}.jpg`, { type: "image/jpeg" }));
      await screen.findByRole("img", { name: new RegExp(`attachment preview ${n}`, "i") });
    }

    expect(await screen.findByText(/5 of 5 photos/i)).toBeTruthy();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it("a failed multi publish keeps every photo so the draft can be retried", async () => {
    publishReportWithPhotosMock.mockRejectedValue(new Error("Could not publish"));
    seedBasics();
    render(<CreateReport />);
    fillTitleCategory("Lost phone");
    pickFile(new File(["one"], "one.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /attachment preview 1/i });
    pickFile(new File(["two"], "two.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /attachment preview 2/i });
    submit();

    await screen.findByText(/could not publish/i);
    expect(screen.getByRole("img", { name: /attachment preview 1/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /attachment preview 2/i })).toBeTruthy();
  });

  it("markdown round-trip still publishes the editor content with photos", async () => {
    seedBasics();
    saveDraft({
      type: "LOST",
      title: "",
      description: "**bold** lost phone near the library",
      category: "",
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    });
    render(<CreateReport />);
    fillTitleCategory("Lost phone");
    pickFile(new File(["one"], "one.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /attachment preview 1/i });
    pickFile(new File(["two"], "two.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /attachment preview 2/i });
    submit();

    await waitFor(() =>
      expect(publishReportWithPhotosMock).toHaveBeenCalledWith(
        expect.objectContaining({ description: "**bold** lost phone near the library" }),
        expect.any(Array),
        expect.objectContaining({ traceId: expect.any(String) }),
      ),
    );
  });
});
