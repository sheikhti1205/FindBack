// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => new Proxy({}, { get: () => async () => ({}) }),
}));
vi.mock("@capacitor/geolocation", () => ({
  Geolocation: {
    checkPermissions: async () => ({ coarseLocation: "prompt", location: "prompt" }),
    requestPermissions: async () => ({}),
    getCurrentPosition: async () => ({ coords: { latitude: 0, longitude: 0, accuracy: 10 }, timestamp: 0 }),
  },
}));
vi.mock("../components/MapPickerSheet", () => ({ MapPickerSheet: () => null }));

const { fetchPostMock, updatePostMock } = vi.hoisted(() => ({
  fetchPostMock: vi.fn(),
  updatePostMock: vi.fn(),
}));
vi.mock("../services/posts", () => ({
  fetchPost: fetchPostMock,
  updatePost: updatePostMock,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "alice" } }) }));

// The rich text editor's own behaviour is covered by RichTextEditor.test.tsx.
// Here it is a plain text field, so the test is about the EDIT flow.
vi.mock("../components/RichTextEditor", () => ({
  RichTextEditor: (props: { label: string; value: string; onChange: (value: string) => void }) => (
    <label>
      {props.label}
      <textarea
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  ),
}));

import { EditReport } from "./EditReport";
import { ApiError } from "../services/session";

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "LOST",
    status: "OPEN",
    title: "Scientific calculator",
    description: "A black scientific calculator lost near the science faculty.",
    category: "Electronics",
    eventDate: "2026-09-29",
    latitude: 23.81,
    longitude: 90.41,
    locationLabel: "Dhaka",
    youtubeUrl: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    likeCount: 0,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    attachments: [],
    ...overrides,
  };
}

function renderEditor(props: { postId?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={["/my/p1/edit"]}>
      <Routes>
        <Route path="/my" element={<div>My Reports</div>} />
        <Route path="/my/:id/edit" element={<EditReport {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchPostMock.mockReset();
  updatePostMock.mockReset();
  fetchPostMock.mockResolvedValue(post());
  updatePostMock.mockResolvedValue(post({ title: "New title" }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EditReport", () => {
  it("hydrates the stored report into the editor", async () => {
    renderEditor({ postId: "p1" });
    await waitFor(() =>
      expect((screen.getByLabelText("What did you lose?") as HTMLInputElement).value).toBe(
        "Scientific calculator",
      ),
    );
    expect(screen.getByTestId("category-trigger").textContent).toContain("Electronics");
    expect(screen.getByRole("button", { name: /no changes to save/i })).toBeTruthy();
  });

  it("reads the report id from the route when no id is passed", async () => {
    renderEditor();
    await waitFor(() => expect(fetchPostMock).toHaveBeenCalledWith("p1"));
  });

  it("refuses to edit a report that belongs to somebody else", async () => {
    fetchPostMock.mockResolvedValue(post({ userId: "someone-else" }));
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByText(/isn't yours to edit/i)).toBeTruthy());
    expect(screen.queryByLabelText("What did you lose?")).toBeNull();
  });

  it("refuses to edit a resolved report and says what unlocks it", async () => {
    fetchPostMock.mockResolvedValue(post({ status: "CLOSED" }));
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByText(/Set it back to Open/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
  });

  it("asks before leaving with unsaved changes and stays when the owner declines", async () => {
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "Another title" } });
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: /back to my reports/i }));
    expect(window.confirm).toHaveBeenCalled();
    expect(screen.queryByText("My Reports")).toBeNull();
  });

  it("saves the changes through the update path and returns to My Reports", async () => {
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "Another title" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    const [id, input] = updatePostMock.mock.calls[0]!;
    expect(id).toBe("p1");
    expect(input).toMatchObject({ title: "Another title", clearFields: [] });
    await waitFor(() => expect(screen.getByText("My Reports")).toBeTruthy());
  });

  it("asks the server to CLEAR the location when the owner empties it", async () => {
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Place, decimal coords, or a Google Maps link"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    const [, input] = updatePostMock.mock.calls[0]!;
    expect(input.locationLabel).toBeNull();
    expect(input.latitude).toBeNull();
    expect(input.longitude).toBeNull();
    expect(input.clearFields).toEqual(["location_label", "latitude", "longitude"]);
  });

  it("shows the server's refusal and keeps what the owner typed", async () => {
    updatePostMock.mockRejectedValue(new ApiError("Post not found or you do not own it", 403));
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "Another title" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/permission/i));
    expect((screen.getByLabelText("What did you lose?") as HTMLInputElement).value).toBe("Another title");
  });
});
