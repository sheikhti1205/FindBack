// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
