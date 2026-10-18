// @vitest-environment jsdom
/**
 * CF-020 MINOR-2: the report form's "Fill missing details" failure copy tells a
 * person on a device without the on-device model to "open Manage AI models" —
 * so this screen must offer that control. The frozen retry-7 suite cannot be
 * edited (byte-frozen), hence a separate focused file for the new affordance.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, suggestFieldsMock, suggestCategoryMock, nlHelperStateMock, navigateMock, photo, nativeMedia } =
  vi.hoisted(() => ({
    publishReportMock: vi.fn(),
    suggestFieldsMock: vi.fn(),
    suggestCategoryMock: vi.fn(),
    nlHelperStateMock: vi.fn(),
    navigateMock: vi.fn(),
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
vi.mock("react-router", () => ({ useNavigate: () => navigateMock }));
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
vi.mock("../services/liveNarrowTasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/liveNarrowTasks")>();
  // The device probe is the whole point of these tests: inject the state
  // instead of asking a runtime that does not exist under jsdom.
  return { ...actual, nlHelperState: () => nlHelperStateMock() };
});
vi.mock("../services/categorySuggestion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/categorySuggestion")>();
  return { ...actual, suggestCategoryForText: (...args: unknown[]) => suggestCategoryMock(...args) };
});

import { CreateReport } from "./CreateReport";
import { clearDraft, loadDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";
import { todayInputValue } from "../utils/dates";
import { chooseCategory } from "../test-utils/reportCategory";

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

/** A draft that already holds a description, so publish has something to send. */
function seedDescription(description: string): void {
  saveDraft(
    {
      type: "LOST",
      title: "",
      description,
      category: "",
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    },
    "u1",
  );
}

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  publishReportMock.mockReset();
  suggestFieldsMock.mockReset();
  suggestCategoryMock.mockReset();
  nlHelperStateMock.mockReset();
  navigateMock.mockReset();
  // Default: the helper is installed and works. The device states are their own
  // test below — a failure must say what the device is, not what the text is not.
  nlHelperStateMock.mockResolvedValue("ready");
  suggestFieldsMock.mockImplementation(cancellable(FIELDS_OK));
  suggestCategoryMock.mockImplementation(cancellable(CATEGORY_OK));
  clearDraft();
  clearPhotoStore();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  clearDraft();
  clearPhotoStore();
  vi.restoreAllMocks();
});

describe("CreateReport suggestion failure — Manage AI models affordance (MINOR-2)", () => {
  const ENGINE_FAILURE = {
    ok: false as const,
    error: { errorClass: "RUNTIME_ERROR", diagnostic: "FIELDS_GENERATION_FAILED" },
  };

  async function failSuggestion(itemText = "Black umbrella lost yesterday.") {
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText(/describe the item/i), {
      target: { value: itemText },
    });
    fireEvent.click(screen.getByRole("button", { name: /^fill missing details$/i }));
  }

  it("offers the single action its copy names, and opens the models screen", async () => {
    suggestFieldsMock.mockImplementation(cancellable(ENGINE_FAILURE));
    suggestCategoryMock.mockImplementation(cancellable(ENGINE_FAILURE));
    nlHelperStateMock.mockResolvedValue("not-set-up");
    await failSuggestion();

    await screen.findByText(/open Manage AI models to install it/i);
    // A destination, not an action: link semantics, a hash-correct href (the app
    // mounts HashRouter, so a hash-less literal matches no route), in-app
    // navigation on a plain click, and the browser's own handling on a modifier
    // click.
    const manage = screen.getByRole("link", { name: "Manage AI models" });
    expect(manage.getAttribute("href")).toBe("#/settings/ai/models");
    fireEvent.click(manage);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/settings/ai/models");

    navigateMock.mockClear();
    // Cmd/Ctrl-click must not be intercepted: the browser opens a new tab.
    expect(fireEvent.click(manage, { ctrlKey: true })).toBe(true);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("keeps the install action inside the message it belongs to", async () => {
    suggestFieldsMock.mockImplementation(cancellable(ENGINE_FAILURE));
    suggestCategoryMock.mockImplementation(cancellable(ENGINE_FAILURE));
    nlHelperStateMock.mockResolvedValue("not-set-up");
    await failSuggestion();

    // The action is part of the failure message a screen reader announces, not a
    // separate control parked next to it.
    const note = await screen.findByTestId("report-suggestion-note-row");
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toMatch(/open Manage AI models to install it/i);
    expect(note.contains(screen.getByTestId("report-suggestion-manage-models"))).toBe(true);
  });

  it.each(["ready", "unsupported-device", "unsupported-platform", "unknown"])(
    "shows no install affordance when the device state is %s",
    async (state) => {
      suggestFieldsMock.mockImplementation(cancellable(ENGINE_FAILURE));
      suggestCategoryMock.mockImplementation(cancellable(ENGINE_FAILURE));
      nlHelperStateMock.mockResolvedValue(state);
      await failSuggestion();

      await screen.findByTestId("report-suggestion-note-row");
      expect(screen.queryByTestId("report-suggestion-manage-models")).toBeNull();
      expect(navigateMock).not.toHaveBeenCalled();
    },
  );

  it("does not carry a stale affordance into an unrelated validation error", async () => {
    suggestFieldsMock.mockImplementation(cancellable(ENGINE_FAILURE));
    suggestCategoryMock.mockImplementation(cancellable(ENGINE_FAILURE));
    nlHelperStateMock.mockResolvedValue("not-set-up");
    await failSuggestion();
    await screen.findByTestId("report-suggestion-manage-models");

    // Second press with the box cleared: this failure is about the missing text,
    // not the device, so the install control must not linger.
    fireEvent.change(screen.getByLabelText(/describe the item/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^fill missing details$/i }));
    await screen.findByText(/Describe the item first/i);
    expect(screen.queryByTestId("report-suggestion-manage-models")).toBeNull();
  });

  it("clears the install action when the suggestion is stopped mid-flight", async () => {
    // Fields settle as a device-state failure; the category op is still running,
    // so the person presses Stop. The abort makes the failure note render first
    // (it re-arms the install action) and then the stop message replaces it.
    // The action belongs to the device note, not to the stop message that
    // overwrote it in the same attempt.
    suggestFieldsMock.mockImplementation(cancellable(ENGINE_FAILURE));
    suggestCategoryMock.mockImplementation(cancellable(undefined));
    nlHelperStateMock.mockResolvedValue("not-set-up");
    await failSuggestion();

    fireEvent.click(await screen.findByRole("button", { name: /^stop$/i }));
    await screen.findByText(/Suggestion stopped\./i);
    expect(screen.queryByTestId("report-suggestion-manage-models")).toBeNull();
  });

  it("keeps the typed helper sentence across the install round-trip", async () => {
    // The copy this affordance serves says to open Manage AI models and come
    // back. The sentence typed into the helper must survive that trip, exactly
    // like the title and description do.
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    const input = screen.getByLabelText(/describe the item/i);
    fireEvent.change(input, { target: { value: "Black umbrella lost yesterday" } });

    await waitFor(() => {
      expect(loadDraft("u1")?.aiSuggestInput).toBe("Black umbrella lost yesterday");
    });

    cleanup();
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    expect((screen.getByLabelText(/describe the item/i) as HTMLTextAreaElement).value).toBe(
      "Black umbrella lost yesterday",
    );
  });

  it("treats the helper sentence as draft content, so discard clears it", async () => {
    // The sentence is persisted with the draft, therefore it is draft content:
    // a draft holding nothing else must still be discardable, and the discard
    // must not leave the sentence behind for the next report.
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText(/describe the item/i), {
      target: { value: "Black umbrella lost yesterday" },
    });
    await waitFor(() => {
      expect(loadDraft("u1")?.aiSuggestInput).toBe("Black umbrella lost yesterday");
    });

    fireEvent.click(screen.getByRole("button", { name: /discard draft/i }));

    expect(vi.mocked(window.confirm)).toHaveBeenCalled();
    expect((screen.getByLabelText(/describe the item/i) as HTMLTextAreaElement).value).toBe("");
    await waitFor(() => {
      expect(loadDraft("u1")?.aiSuggestInput ?? "").toBe("");
    });
  });

  it("does not leave the helper sentence behind after the report is published", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedDescription("a black umbrella lost near the market");
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost umbrella" } });
    await chooseCategory("Electronics");
    fireEvent.change(screen.getByLabelText(/describe the item/i), {
      target: { value: "Black umbrella lost yesterday" },
    });
    await waitFor(() => {
      expect(loadDraft("u1")?.aiSuggestInput).toBe("Black umbrella lost yesterday");
    });

    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publishReportMock).toHaveBeenCalled());

    expect((screen.getByLabelText(/describe the item/i) as HTMLTextAreaElement).value).toBe("");
    await waitFor(() => {
      expect(loadDraft("u1")?.aiSuggestInput ?? "").toBe("");
    });
  });
});

describe("CreateReport suggestion lifecycle — round-3 review closures (revision 4)", () => {
  const ENGINE_FAILURE = {
    ok: false as const,
    error: { errorClass: "RUNTIME_ERROR", diagnostic: "FIELDS_GENERATION_FAILED" },
  };

  /** A device probe that stays pending until the test releases it. */
  function deferredProbe() {
    let release: ((state: string) => void) | null = null;
    let started = 0;
    nlHelperStateMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          started += 1;
          release = resolve;
        }),
    );
    return {
      get started() {
        return started;
      },
      release(state: string) {
        if (!release) throw new Error("the device probe was never started");
        release(state);
      },
    };
  }

  it("cannot be re-decorated by a suggestion still in flight when the draft is discarded", async () => {
    // The failure path awaits the device probe before it can write its note.
    // A discard inside that window must invalidate the attempt, or the note —
    // and with it, on `not-set-up`, the install link — is written back onto the
    // emptied form (round-3 review MINOR-1).
    suggestFieldsMock.mockImplementation(cancellable(ENGINE_FAILURE));
    suggestCategoryMock.mockImplementation(cancellable(ENGINE_FAILURE));
    const probe = deferredProbe();
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText(/describe the item/i), {
      target: { value: "Black umbrella lost yesterday." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^fill missing details$/i }));
    await waitFor(() => expect(probe.started).toBe(1));

    // The sentence alone makes this a draft worth discarding.
    await waitFor(() => {
      expect(loadDraft("u1")?.aiSuggestInput).toBe("Black umbrella lost yesterday.");
    });
    fireEvent.click(screen.getByRole("button", { name: /discard draft/i }));
    expect((screen.getByLabelText(/describe the item/i) as HTMLTextAreaElement).value).toBe("");

    probe.release("not-set-up");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("report-suggestion-note-row")).toBeNull();
    expect(screen.queryByTestId("report-suggestion-manage-models")).toBeNull();
    // The stale attempt's `finally` cannot clear the flag either, so the discard
    // itself must: the control is a request again, not a stuck one.
    expect(screen.getByRole("button", { name: /^fill missing details$/i })).toBeTruthy();
  });

  it("does not let an older attempt's device probe overwrite a later validation error", async () => {
    // A second press while the first attempt is still awaiting the probe: the
    // box is empty, so this attempt fails synchronously and never asks the
    // device — which is exactly why it must invalidate the older attempt by
    // generation (round-3 review NIT-1).
    suggestFieldsMock.mockImplementation(cancellable(ENGINE_FAILURE));
    suggestCategoryMock.mockImplementation(cancellable(ENGINE_FAILURE));
    const probe = deferredProbe();
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    const box = screen.getByLabelText(/describe the item/i);
    fireEvent.change(box, { target: { value: "Black umbrella lost yesterday." } });
    fireEvent.click(screen.getByRole("button", { name: /^fill missing details$/i }));
    await waitFor(() => expect(probe.started).toBe(1));

    fireEvent.change(box, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^filling/i }));
    await screen.findByText(/Describe the item first/i);

    probe.release("not-set-up");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText(/Describe the item first/i)).toBeTruthy();
    expect(screen.queryByTestId("report-suggestion-manage-models")).toBeNull();
  });

  it("clears the failure note when the draft is discarded", async () => {
    suggestFieldsMock.mockImplementation(cancellable(ENGINE_FAILURE));
    suggestCategoryMock.mockImplementation(cancellable(ENGINE_FAILURE));
    nlHelperStateMock.mockResolvedValue("not-set-up");
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText(/describe the item/i), {
      target: { value: "Black umbrella lost yesterday." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^fill missing details$/i }));
    await screen.findByTestId("report-suggestion-note-row");

    fireEvent.click(screen.getByRole("button", { name: /discard draft/i }));
    expect(screen.queryByTestId("report-suggestion-note-row")).toBeNull();
    expect(screen.queryByTestId("report-suggestion-manage-models")).toBeNull();
  });

  it("does not persist an empty helper sentence as a draft field", async () => {
    // Round-3 review NIT-2: the loader fix alone left `aiSuggestInput: undefined`
    // as an own key on the in-memory draft — the round-2 BLOCKER's shape, from
    // the save path this time. The key exists only when it holds something.
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost umbrella" } });
    await waitFor(() => {
      expect(loadDraft("u1")?.title).toBe("Lost umbrella");
    });

    const draft = loadDraft("u1");
    expect(draft).not.toBeNull();
    expect(draft && "aiSuggestInput" in draft).toBe(false);
  });
});
