// @vitest-environment jsdom
/**
 * Lane C: extract-report-fields + classify-category wired into CreateReport
 * as user-confirmed suggestions. Suggestions only: every chip shows its
 * source with Apply/Keep, applying one field keeps the others reviewable,
 * Keep sends nothing, cancellation aborts cleanly with no fallback, stale
 * generations are dropped, unreleased categories downgrade with a notice,
 * and nothing ever publishes without the explicit form submit.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, suggestFieldsMock, suggestCategoryMock, photo, nativeMedia } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  suggestFieldsMock: vi.fn(),
  suggestCategoryMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    photoToFile: vi.fn(),
    normalizeForUpload: vi.fn(async (file: File) => file),
    toNativeImageUri: vi.fn(),
  },
  nativeMedia: {
    chooseNativeImage: vi.fn(),
    chooseNativeImages: vi.fn(),
    importNativeImageUri: vi.fn(),
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
  return { ...actual, publishReport: (...args: unknown[]) => publishReportMock(...args) };
});
vi.mock("../services/photo", () => photo);
vi.mock("../services/media/nativeMedia", () => ({
  chooseNativeImage: nativeMedia.chooseNativeImage,
  chooseNativeImages: nativeMedia.chooseNativeImages,
  importNativeImageUri: nativeMedia.importNativeImageUri,
  // Faithful copy of the production helper (pure): the real module registers
  // the Capacitor plugin at import time, which the web-platform mock lacks.
  importedImageToFile: (item: { fileName?: string; derivative: { bytes: Uint8Array; mimeType: string } }) =>
    new File([item.derivative.bytes.slice()], item.fileName || "photo.jpg", { type: item.derivative.mimeType }),
}));
vi.mock("../services/reportFieldSuggestions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/reportFieldSuggestions")>();
  return { ...actual, suggestReportFields: (...args: unknown[]) => suggestFieldsMock(...args) };
});
vi.mock("../services/categorySuggestion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/categorySuggestion")>();
  return { ...actual, suggestCategoryForText: (...args: unknown[]) => suggestCategoryMock(...args) };
});

import { CreateReport } from "./CreateReport";
import { clearDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";
import { clearStagedAssistantReportHandoff } from "../services/assistant/assistantReportNavigation";

const FIELDS_OK = {
  ok: true,
  value: {
    suggestions: [
      { field: "title", suggestedValue: "Black umbrella", source: "extract-report-fields" },
      { field: "description", suggestedValue: "Lost near the market", source: "extract-report-fields" },
      { field: "date", suggestedValue: "yesterday", source: "extract-report-fields" },
    ],
    droppedCategory: false,
    action: { action: "NONE" },
  },
} as const;

const CATEGORY_OK = {
  ok: true,
  value: {
    suggestion: { suggestedCategory: "Keys", source: "classify-category" },
    dropped: false,
  },
} as const;

const CANCELLED = { ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_MID_GENERATION" } } as const;

function cancellable<T>(value: T) {
  return (_g: unknown, _t: unknown, _p: unknown, opts?: { signal?: AbortSignal }) =>
    new Promise((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(CANCELLED);
        return;
      }
      opts?.signal?.addEventListener("abort", () => resolve(CANCELLED), { once: true });
      if (value !== undefined) {
        // Resolve on next tick unless aborted first (settle race mirrors the
        // real abort-clean wrappers: abort wins, late output is dropped).
        queueMicrotask(() => {
          if (!opts?.signal?.aborted) resolve(value);
        });
      }
    });
}

beforeEach(() => {
  publishReportMock.mockReset();
  suggestFieldsMock.mockReset();
  suggestCategoryMock.mockReset();
  suggestFieldsMock.mockImplementation(cancellable(FIELDS_OK));
  suggestCategoryMock.mockImplementation(cancellable(CATEGORY_OK));
  clearDraft();
  clearPhotoStore();
  clearStagedAssistantReportHandoff();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  clearDraft();
  clearPhotoStore();
  clearStagedAssistantReportHandoff();
  vi.restoreAllMocks();
});

async function requestSuggestions(itemText: string) {
  render(<CreateReport />);
  await screen.findByRole("toolbar", { name: /description formatting/i });
  fireEvent.change(screen.getByLabelText("Describe the item for AI suggestions"), {
    target: { value: itemText },
  });
  fireEvent.click(screen.getByRole("button", { name: /^suggest fields$/i }));
  await screen.findByText("Black umbrella");
}

describe("CreateReport AI field suggestions", () => {
  it("shows source-labelled chips and applies one field while keeping others reviewable", async () => {
    await requestSuggestions("Black umbrella lost yesterday near the central market.");
    expect(screen.getByText("Suggested title · via extract-report-fields")).toBeTruthy();
    expect(screen.getByText("Suggested category · via classify-category")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Black umbrella");
    // Applying one field keeps the others reviewable.
    expect(screen.getByText("Suggested description · via extract-report-fields")).toBeTruthy();
    expect(screen.getByText("Suggested category · via classify-category")).toBeTruthy();
    // Suggestions never publish: the explicit submit path is untouched.
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("Keep sends nothing: no setters, no network, no publish", async () => {
    await requestSuggestions("Black umbrella lost yesterday.");
    const callsBefore = suggestFieldsMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    // Keep the description (title chip already resolved away, so the first
    // remaining Keep belongs to the description): its chip resolves with no
    // side effects.
    const keepButtons = screen.getAllByRole("button", { name: "Keep mine" });
    fireEvent.click(keepButtons[0]!);
    expect(screen.queryByText("Suggested description · via extract-report-fields")).toBeNull();
    expect(screen.getByText("Suggested category · via classify-category")).toBeTruthy();
    expect(suggestFieldsMock.mock.calls.length).toBe(callsBefore);
    expect(suggestCategoryMock.mock.calls.length).toBe(1);
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("a declined replace keeps the suggestion visible instead of resolving it away", async () => {
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "My own title" } });
    fireEvent.change(screen.getByLabelText("Describe the item for AI suggestions"), {
      target: { value: "Black umbrella lost yesterday." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^suggest fields$/i }));
    await screen.findByText("Black umbrella");

    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("My own title");
    expect(screen.getByText("Suggested title · via extract-report-fields")).toBeTruthy();

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Black umbrella");
  });

  it("drops a stale generation when a newer request supersedes it", async () => {
    let releaseFirst!: (value: unknown) => void;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    suggestFieldsMock.mockImplementationOnce(() => firstGate);
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    const input = screen.getByLabelText("Describe the item for AI suggestions");
    fireEvent.change(input, { target: { value: "first text" } });
    fireEvent.click(screen.getByRole("button", { name: /^suggest(ing…| fields)$/i }));
    // A newer request supersedes the first before it resolves.
    fireEvent.change(input, { target: { value: "second text" } });
    fireEvent.click(screen.getByRole("button", { name: /^suggest(ing…| fields)$/i }));
    await screen.findByText("Black umbrella");
    // The stale first response resolves late with different content: dropped.
    releaseFirst({
      ok: true,
      value: {
        suggestions: [{ field: "title", suggestedValue: "Stale title", source: "extract-report-fields" }],
        droppedCategory: false,
        action: { action: "NONE" },
      },
    });
    await waitFor(() => expect(suggestFieldsMock.mock.calls.length).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale title")).toBeNull();
    expect(screen.getByText("Black umbrella")).toBeTruthy();
  });

  it("Stop aborts cleanly: cancelled note, no fallback side effects", async () => {
    // Mocks settle to CANCELLED on abort, mirroring the real abort-clean
    // wrappers: the panel renders the cancellation with no retry/fallback.
    suggestFieldsMock.mockImplementation(cancellable(undefined));
    suggestCategoryMock.mockImplementation(cancellable(undefined));
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText("Describe the item for AI suggestions"), {
      target: { value: "Black umbrella lost yesterday." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^suggest(ing…| fields)$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("AI request cancelled.");
    // No retry, no second op, no chips, no publish.
    expect(suggestFieldsMock.mock.calls.length).toBe(1);
    expect(suggestCategoryMock.mock.calls.length).toBe(1);
    expect(screen.queryByText("Suggested title · via extract-report-fields")).toBeNull();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("downgrades an unreleased category with a notice and no category Apply", async () => {
    suggestFieldsMock.mockImplementation(
      cancellable({
        ok: true,
        value: {
          suggestions: [
            { field: "title", suggestedValue: "Black umbrella", source: "extract-report-fields" },
          ],
          droppedCategory: true,
          action: { action: "NONE" },
        },
      }),
    );
    suggestCategoryMock.mockImplementation(
      cancellable({ ok: true, value: { suggestion: null, dropped: true } }),
    );
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText("Describe the item for AI suggestions"), {
      target: { value: "Black umbrella lost yesterday." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^suggest fields$/i }));
    await screen.findByText(/isn't available yet/);
    expect(screen.queryByRole("button", { name: "Apply category" })).toBeNull();
    expect(screen.getByRole("button", { name: "Apply title" })).toBeTruthy();
  });

  it("a free-text date is not applicable: Apply disabled, manual-pick hint, gates intact", async () => {
    await requestSuggestions("Black umbrella lost yesterday.");
    const applyDate = screen.getByRole("button", { name: "Apply date" }) as HTMLButtonElement;
    expect(applyDate.disabled).toBe(true);
    expect(screen.getByText(/pick it in the date field instead/)).toBeTruthy();
  });
});
