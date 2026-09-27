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
    normalizeForUpload: vi.fn(async (file: File) => file),
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
  return { ...actual, publishReport: (...args: unknown[]) => publishReportMock(...args) };
});
vi.mock("../services/photo", () => photo);

let capturedOnChange: ((markdown: string) => void) | null = null;
let capturedEditorRef: { current: { getJSON: () => unknown } | null } | null = null;

vi.mock("../components/RichTextEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/RichTextEditor")>();
  return {
    ...actual,
    RichTextEditor: (props: {
      label: string;
      value: string;
      onChange: (markdown: string) => void;
      placeholder?: string;
      error?: string;
      required?: boolean;
      maxLength?: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editorRef?: any;
    }) => {
      capturedOnChange = props.onChange;
      capturedEditorRef = (props.editorRef as { current: { getJSON: () => unknown } | null }) ?? null;
      return <actual.RichTextEditor {...props} />;
    },
  };
});

import { CreateReport } from "./CreateReport";
import { clearDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";
import { clearStagedAssistantReportHandoff } from "../services/assistant/assistantReportNavigation";
import { todayInputValue } from "../utils/dates";
import { markdownToTiptap } from "../components/RichTextEditor";

beforeEach(() => {
  publishReportMock.mockReset();
  clearDraft();
  clearPhotoStore();
  clearStagedAssistantReportHandoff();
  capturedOnChange = null;
  capturedEditorRef = null;
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearDraft();
  clearPhotoStore();
  clearStagedAssistantReportHandoff();
});

describe("CreateReport immediate submit", () => {
  it("retains final keystrokes when submit follows the last edit without a pause", async () => {
    publishReportMock.mockResolvedValue("p1");
    saveDraft({
      type: "LOST",
      title: "Lost phone",
      description: "initial description that is long enough",
      category: "Electronics",
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    }, "u1");
    render(<CreateReport />);
    await screen.findByRole("toolbar", { name: /description formatting/i });
    expect(capturedOnChange).not.toBeNull();

    const finalMarkdown = "final keystrokes that stay valid and long enough";
    // Point the live editor at the final content, then report the edit and
    // submit in the same tick — React state has no chance to flush first.
    if (capturedEditorRef) {
      capturedEditorRef.current = {
        getJSON: () => markdownToTiptap(finalMarkdown).content ? { content: markdownToTiptap(finalMarkdown).content } : { content: [] },
      } as never;
      // Ensure the mock shape matches tiptapToMarkdown input ({content:[...]}).
      capturedEditorRef.current = {
        getJSON: () => markdownToTiptap(finalMarkdown),
      } as never;
    }
    capturedOnChange?.(finalMarkdown);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);

    await waitFor(() =>
      expect(publishReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ description: finalMarkdown }),
        null,
        expect.any(String),
      ),
    );
  });
});
