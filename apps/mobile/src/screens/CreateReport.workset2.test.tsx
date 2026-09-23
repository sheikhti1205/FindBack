// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, photo } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
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
vi.mock("../services/posts", () => ({ publishReport: (...args: unknown[]) => publishReportMock(...args) }));
vi.mock("../services/photo", () => photo);

let dispatchHandoffAfterNextLocationCommit = false;

vi.mock("../components/LocationPicker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/LocationPicker")>();
  return {
    ...actual,
    LocationPicker: (props: ComponentProps<typeof actual.LocationPicker>) => {
      // Commit-safe trigger: runs after the commit, before the parent
      // snapshot passive effect flushes (child passives run first).
      useEffect(() => {
        if (dispatchHandoffAfterNextLocationCommit) {
          dispatchHandoffAfterNextLocationCommit = false;
          stageAssistantReportHandoff(readyHandoff());
        }
      });
      return <actual.LocationPicker {...props} />;
    },
  };
});

// Settle image-analysis readiness in microtasks so no async form update can
// commit between arming the handoff trigger and the title change below.
vi.mock("../services/models/imageAnalysisReadiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/models/imageAnalysisReadiness")>();
  return {
    ...actual,
    readImageAnalysisReadiness: async () => ({ available: false, reason: "NO_MODEL" as const }),
  };
});

import { CreateReport } from "./CreateReport";
import { clearDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";
import {
  clearStagedAssistantReportHandoff,
  stageAssistantReportHandoff,
} from "../services/assistant/assistantReportNavigation";
import { applyReportFields, chooseLocation, choosePhoto, startFlow } from "../services/assistant/guidedAssistantController";
import { buildAssistantReportHandoff } from "../services/assistant/assistantHandoff";

function readyHandoff() {
  let snapshot = startFlow("lost");
  snapshot = applyReportFields(snapshot, {
    title: "Assistant keys",
    description: "Brass keys with blue lanyard near central library",
    category: "Keys",
    dateText: "2026-09-01",
    locationNote: "Central library",
  });
  snapshot = choosePhoto(snapshot, "none");
  snapshot = chooseLocation(snapshot, "skip");
  return buildAssistantReportHandoff(snapshot)!;
}

beforeEach(() => {
  publishReportMock.mockReset();
  clearDraft();
  clearPhotoStore();
  clearStagedAssistantReportHandoff();
  dispatchHandoffAfterNextLocationCommit = false;
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearDraft();
  clearPhotoStore();
  clearStagedAssistantReportHandoff();
});

describe("CreateReport workset2 editor", () => {
  it("uses the visual editor without MarkdownComposer tabs or literal syntax", async () => {
    render(<CreateReport />);
    expect(screen.queryByRole("tab", { name: /write/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /preview/i })).toBeNull();
    expect(screen.queryByText(/markdown supported/i)).toBeNull();
    expect(screen.getByRole("toolbar", { name: /description formatting/i })).toBeTruthy();
    expect(screen.getByLabelText("Character count")).toBeTruthy();
  });
});

describe("CreateReport workset2 handoff intake", () => {
  it("prefills empty fields from the versioned handoff without auto-publishing", async () => {
    stageAssistantReportHandoff(readyHandoff());
    render(<CreateReport />);
    await waitFor(() => expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Assistant keys"));
    expect((screen.getByLabelText(/category/i) as HTMLSelectElement).value).toBe("Keys");
    expect(screen.getByText(/assistant suggestions/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("never silently overwrites a non-empty user draft", async () => {
    saveDraft({
      type: "LOST",
      title: "My kept title",
      description: "My kept description that is long enough",
      category: "Electronics",
      eventDate: "2026-09-02",
      location: { label: "My kept place", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    });
    stageAssistantReportHandoff(readyHandoff());
    render(<CreateReport />);
    await waitFor(() => expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("My kept title"));
    expect((screen.getByLabelText(/category/i) as HTMLSelectElement).value).toBe("Electronics");
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("keeps photo and location review in user hands", async () => {
    stageAssistantReportHandoff(readyHandoff());
    render(<CreateReport />);
    await screen.findByText(/assistant suggestions/i);
    expect(screen.getByText(/photo \(optional\)/i)).toBeTruthy();
    expect(screen.getByLabelText(/approximate location/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("asks for explicit confirmation before replacing conflicting details", async () => {
    saveDraft({
      type: "LOST",
      title: "My kept title",
      description: "My kept description that is long enough",
      category: "Electronics",
      eventDate: "2026-09-02",
      location: { label: "My kept place", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    });
    stageAssistantReportHandoff(readyHandoff());
    render(<CreateReport />);
    await screen.findByText(/kept your details/i);
    expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("My kept title");
    fireEvent.click(screen.getByRole("button", { name: /use assistant suggestions/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Assistant keys"),
    );
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("keeps user details when the conflict is dismissed", async () => {
    saveDraft({
      type: "LOST",
      title: "My kept title",
      description: "My kept description that is long enough",
      category: "Electronics",
      eventDate: "2026-09-02",
      location: { label: "My kept place", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    });
    stageAssistantReportHandoff(readyHandoff());
    render(<CreateReport />);
    await screen.findByText(/kept your details/i);
    fireEvent.click(screen.getByRole("button", { name: /keep my details/i }));
    await waitFor(() => expect(screen.queryByText(/kept your details/i)).toBeNull());
    expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("My kept title");
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("fills only empty fields while keeping non-empty ones", async () => {
    saveDraft({
      type: "LOST",
      title: "",
      description: "",
      category: "Electronics",
      eventDate: "2026-09-02",
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    });
    stageAssistantReportHandoff(readyHandoff());
    render(<CreateReport />);
    await waitFor(() => expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Assistant keys"));
    expect((screen.getByLabelText(/category/i) as HTMLSelectElement).value).toBe("Electronics");
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("uses the latest committed form state when a handoff arrives before passive effects flush", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      saveDraft({
        type: "LOST",
        title: "My kept title",
        description: "My kept description that is long enough",
        category: "Electronics",
        eventDate: "2026-09-02",
        location: { label: "My kept place", latitude: null, longitude: null },
        youtubeUrl: "",
        photoId: null,
        photoNativeUri: null,
        photoWebPath: null,
        photoFormat: null,
      });
      render(<CreateReport />);
      const titleInput = (await screen.findByLabelText(/what did you lose/i)) as HTMLInputElement;
      expect(titleInput.value).toBe("My kept title");

      // Settle the mocked image-analysis readiness update so the cleared
      // title commit is the next commit after arming the trigger.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Commit a cleared title; the child passive effect delivers a live
      // handoff before the parent snapshot passive effect flushes. The
      // latest committed title is empty, so the assistant title must fill
      // the field instead of being kept aside as a conflict.
      dispatchHandoffAfterNextLocationCommit = true;
      fireEvent.change(titleInput, { target: { value: "" } });

      await screen.findByText(/added to empty fields: title/i);
      expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Assistant keys");
      expect(publishReportMock).not.toHaveBeenCalled();
      const reactUpdateWarnings = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
        .flat()
        .filter((arg) => typeof arg === "string" && /cannot update|while rendering/i.test(arg));
      expect(reactUpdateWarnings).toEqual([]);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });
});
