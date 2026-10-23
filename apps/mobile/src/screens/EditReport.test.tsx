// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createContext, useContext, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
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

const { fetchPostMock, updatePostMock, authState, announceMock } = vi.hoisted(() => ({
  fetchPostMock: vi.fn(),
  updatePostMock: vi.fn(),
  authState: { user: { id: "u1", username: "alice" } },
  announceMock: vi.fn(),
}));
vi.mock("../services/posts", () => ({
  fetchPost: fetchPostMock,
  updatePost: updatePostMock,
}));
vi.mock("../auth", () => ({ useAuth: () => authState }));
vi.mock("../components/LiveRegion", () => ({ announce: announceMock }));

// The rich text editor's own behaviour is covered by RichTextEditor.test.tsx.
// Here it is a plain text field, so the test is about the EDIT flow.
vi.mock("../components/RichTextEditor", () => ({
  RichTextEditor: (props: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) => (
    <label>
      {props.label}
      <textarea
        aria-label={props.label}
        value={props.value}
        disabled={props.disabled}
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
  const router = makeRouter([
    { path: "/my", element: <div>My Reports</div> },
    { path: "/my/:id/edit", element: <EditReport {...props} /> },
  ], { initialEntries: ["/my/p1/edit"] });
  return render(<RouterProvider router={router} />);
}

const routers: ReturnType<typeof createMemoryRouter>[] = [];
function makeRouter(...args: Parameters<typeof createMemoryRouter>) {
  const router = createMemoryRouter(...args);
  routers.push(router);
  return router;
}
// Changing the fake auth source must notify the routed element just like the
// production AuthContext does; re-rendering RouterProvider alone is not a
// context notification. Keep the SAME router to exercise session isolation.
const InstanceId = createContext({ id: "p1", accountId: "u1" });
function CurrentEditor() { return <EditReport postId={useContext(InstanceId).id} />; }
function EditorInstance({ id }: { id: string }) {
  const [router] = useState(() => makeRouter([{ path: "*", element: <CurrentEditor /> }]));
  return <InstanceId.Provider value={{ id, accountId: authState.user.id }}><RouterProvider router={router} /></InstanceId.Provider>;
}

beforeEach(() => {
  authState.user = { id: "u1", username: "alice" };
  announceMock.mockReset();
  fetchPostMock.mockReset();
  updatePostMock.mockReset();
  fetchPostMock.mockResolvedValue(post());
  updatePostMock.mockResolvedValue(post({ title: "New title" }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
  vi.restoreAllMocks();
});

describe("EditReport", () => {
  it.each([
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://example.invalid/youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.example.invalid/watch?v=dQw4w9WgXcQ",
    "javascript:youtube.com/watch?v=dQw4w9WgXcQ",
    "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?foo=bar&v=dQw4w9WgXcQ",
  ])("rejects unsupported/spoof video URL before preview and RPC: %s", async (url) => {
    renderEditor();
    await screen.findByLabelText("What did you lose?");
    fireEvent.change(screen.getByLabelText("YouTube link (optional)"), { target: { value: url } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updatePostMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/YouTube link/i));
    expect(screen.queryByRole("button", { name: "Play video" })).toBeNull();
  });

  it.each(["push", "replace", "pop"] as const)("protects a dirty draft on router %s and keeps history usable after cancellation", async (action) => {
    const router = createMemoryRouter([
      { path: "/my/:id/edit", element: <EditReport /> },
      { path: "/my", element: <div>My Reports</div> },
    ], { initialEntries: ["/my", "/my/p1/edit"], initialIndex: 1 });
    render(<RouterProvider router={router} />);
    await screen.findByLabelText("What did you lose?");
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "private draft" } });
    vi.mocked(window.confirm).mockReturnValue(false);
    const go = () => action === "pop" ? router.navigate(-1) : router.navigate("/my", { replace: action === "replace" });
    await act(async () => { await go(); });
    expect(router.state.location.pathname).toBe("/my/p1/edit");
    expect((screen.getByLabelText("What did you lose?") as HTMLInputElement).value).toBe("private draft");
    expect(window.confirm).toHaveBeenCalledTimes(1);
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => { await go(); });
    expect(screen.getByText("My Reports")).toBeTruthy();
    expect(window.confirm).toHaveBeenCalledTimes(2);
    router.dispose();
  });

  it("returns after a successful save without asking to discard the saved draft", async () => {
    const router = createMemoryRouter([
      { path: "/my/:id/edit", element: <EditReport /> },
      { path: "/my", element: <div>My Reports</div> },
    ], { initialEntries: ["/my/p1/edit"] });
    render(<RouterProvider router={router} />);
    await screen.findByLabelText("What did you lose?");
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "Saved title" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText("My Reports")).toBeTruthy();
    expect(window.confirm).not.toHaveBeenCalled();
    router.dispose();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function instance(id = "p1") {
    return <EditorInstance id={id} />;
  }

  async function startSave() {
    const title = await screen.findByLabelText("What did you lose?");
    fireEvent.change(title, { target: { value: "Another title" } });
    const form = screen.getByRole("button", { name: /save changes/i }).closest("form")!;
    fireEvent.submit(form);
    return form;
  }

  it("serializes repeated form submissions until the save settles", async () => {
    const save = deferred<ReturnType<typeof post>>();
    updatePostMock.mockReturnValue(save.promise);
    renderEditor();
    const form = await startSave();
    fireEvent.submit(form);
    expect(updatePostMock).toHaveBeenCalledTimes(1);
    await act(async () => save.resolve(post()));
    expect(screen.getByText("My Reports")).toBeTruthy();
  });

  it("locks every canonical field while saving and retains the draft after failure", async () => {
    const save = deferred<ReturnType<typeof post>>();
    updatePostMock.mockReturnValue(save.promise);
    renderEditor();
    await startSave();
    for (const field of [
      screen.getByLabelText("What did you lose?"), screen.getByLabelText("Description"),
      screen.getByLabelText("YouTube link (optional)"), screen.getByTestId("category-trigger"),
      screen.getByPlaceholderText("Place, decimal coords, or a Google Maps link"),
      screen.getByRole("button", { name: /choose on map/i }),
      screen.getByRole("button", { name: /use exact pin/i }),
      screen.getByRole("button", { name: /use my location once/i }),
    ]) expect((field as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "late edit" } });
    await act(async () => save.reject(new ApiError("Post not found or you do not own it", 403)));
    expect((screen.getByLabelText("What did you lose?") as HTMLInputElement).value).toBe("Another title");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(post().description);
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("does not reuse the prior draft when the account changes for the same report", async () => {
    const view = render(instance());
    await screen.findByLabelText("What did you lose?");
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "private draft" } });
    authState.user = { id: "u2", username: "bob" };
    view.rerender(instance());
    expect(screen.queryByDisplayValue("private draft")).toBeNull();
    expect(await screen.findByText(/isn't yours to edit/i)).toBeTruthy();
    expect(fetchPostMock).toHaveBeenCalledTimes(2);
  });

  it.each(["account", "report"])("suppresses a late load after %s replacement", async (replacement) => {
    const load = deferred<ReturnType<typeof post>>();
    fetchPostMock.mockReturnValueOnce(load.promise);
    const view = render(instance());
    fetchPostMock.mockResolvedValue(post({ id: replacement === "report" ? "p2" : "p1", userId: replacement === "account" ? "u2" : "u1", title: "Current report" }));
    if (replacement === "account") authState.user = { id: "u2", username: "bob" };
    view.rerender(instance(replacement === "report" ? "p2" : "p1"));
    await screen.findByDisplayValue("Current report");
    await act(async () => load.resolve(post()));
    expect(screen.queryByDisplayValue("Scientific calculator")).toBeNull();
    expect(screen.getByDisplayValue("Current report")).toBeTruthy();
  });

  it.each(["account", "report", "unmount", "leave"])("suppresses a late save success after %s", async (replacement) => {
    const save = deferred<ReturnType<typeof post>>();
    updatePostMock.mockReturnValueOnce(save.promise);
    const view = replacement === "leave" ? renderEditor() : render(instance());
    await startSave();
    if (replacement === "unmount") view.unmount();
    else if (replacement === "leave") fireEvent.click(screen.getByRole("button", { name: /discard changes/i }));
    else {
      if (replacement === "account") authState.user = { id: "u2", username: "bob" };
      fetchPostMock.mockResolvedValue(post({ id: replacement === "report" ? "p2" : "p1", userId: authState.user.id, title: "Current report" }));
      view.rerender(instance(replacement === "report" ? "p2" : "p1"));
      await screen.findByDisplayValue("Current report");
    }
    await act(async () => save.resolve(post()));
    expect(announceMock).not.toHaveBeenCalledWith("Report updated.");
    if (replacement === "account" || replacement === "report") expect(screen.getByDisplayValue("Current report")).toBeTruthy();
  });

  it("does not show a prior account's late save error in the new editor", async () => {
    const save = deferred<ReturnType<typeof post>>();
    updatePostMock.mockReturnValueOnce(save.promise);
    const view = render(instance());
    await startSave();
    authState.user = { id: "u2", username: "bob" };
    fetchPostMock.mockResolvedValue(post({ userId: "u2", title: "Current report" }));
    view.rerender(instance());
    await screen.findByDisplayValue("Current report");
    await act(async () => save.reject(new ApiError("Invalid category", 400, "22023")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(announceMock).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Current report")).toBeTruthy();
  });

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

  it("shows the stored YouTube link as an editable field and saves the replacement", async () => {
    fetchPostMock.mockResolvedValue(post({ youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }));
    renderEditor({ postId: "p1" });
    const field = (await screen.findByLabelText("YouTube link (optional)")) as HTMLInputElement;
    expect(field.value).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    fireEvent.change(field, { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    expect(updatePostMock.mock.calls[0]![1]).toMatchObject({
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
      clearFields: [],
    });
  });

  it("shows the YouTube field error before submitting a non-YouTube link", async () => {
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("YouTube link (optional)"), {
      target: { value: "https://example.com/watch?v=dQw4w9WgXcQ" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText(/doesn't look like a YouTube link/i)).toBeTruthy();
    expect(updatePostMock).not.toHaveBeenCalled();
  });

  it("explicitly removes the stored link when the YouTube field is blanked", async () => {
    fetchPostMock.mockResolvedValue(post({ youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }));
    renderEditor({ postId: "p1" });
    const field = await screen.findByLabelText("YouTube link (optional)");
    fireEvent.change(field, { target: { value: "" } });
    expect(screen.getByText(/clear this field to remove/i)).toBeTruthy();
    expect(screen.queryByTestId("report-editor-youtube-kept")).toBeNull();
    expect(screen.queryByRole("button", { name: /play/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    const [, input] = updatePostMock.mock.calls[0]!;
    expect(input.youtubeUrl).toBeNull();
    expect(input.clearFields).toEqual(["youtube_url"]);
  });

  it("does not request a YouTube clear for an already-empty link", async () => {
    renderEditor();
    await screen.findByLabelText("What did you lose?");
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "Another title" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    expect(updatePostMock.mock.calls[0]![1].clearFields).toEqual([]);
  });

  it("asks before leaving the page itself when there are unsaved changes", async () => {
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "Another title" } });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
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

  it("KEEPS the published pin when the owner retypes the place name", async () => {
    // The picker cannot turn free text into coordinates, so a retype arrives
    // with none. The published pin must survive that: only clearing the
    // place removes it.
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Place, decimal coords, or a Google Maps link"), {
      target: { value: "Dhaka Cantonment" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    const [, input] = updatePostMock.mock.calls[0]!;
    expect(input.locationLabel).toBe("Dhaka Cantonment");
    expect(input.latitude).toBe(23.81);
    expect(input.longitude).toBe(90.41);
    expect(input.clearFields).toEqual([]);
  });

  it.each([90.41, null])("never clears an unchanged legacy pin with an empty label (longitude %s)", async (longitude) => {
    fetchPostMock.mockResolvedValue(post({ locationLabel: "", longitude }));
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "Another title" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    expect(updatePostMock.mock.calls[0]![1]).toMatchObject({
      clearFields: [], latitude: 23.81, longitude,
    });
  });

  it("shows and saves the published pin after clearing then retyping the place", async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    const place = screen.getByPlaceholderText("Place, decimal coords, or a Google Maps link");
    fireEvent.change(place, { target: { value: "" } });
    fireEvent.change(place, { target: { value: "Dhaka Cantonment" } });
    // The real picker must show the pin the request will preserve, not an
    // unpinned draft whose null arguments silently keep the server's pin.
    expect(screen.getAllByText(/23\.81/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    expect(updatePostMock.mock.calls[0]![1]).toMatchObject({
      clearFields: [], latitude: 23.81, longitude: 90.41, locationLabel: "Dhaka Cantonment",
    });
  });

  it("clears a HALF pin (a legacy row with only one coordinate) when the place is emptied", async () => {
    fetchPostMock.mockResolvedValue(post({ longitude: null }));
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Place, decimal coords, or a Google Maps link"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(updatePostMock).toHaveBeenCalled());
    const [, input] = updatePostMock.mock.calls[0]!;
    expect(input.clearFields).toEqual(["location_label", "latitude", "longitude"]);
  });

  it("says that editing the place name keeps the published pin", async () => {
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    expect(
      screen.getByText(/keeps the map pin that is already published/i).textContent,
    ).toMatch(/clearing the place removes the name and the pin/i);
  });

  it("explains that a refusal may be about the value already saved", async () => {
    updatePostMock.mockRejectedValue(new ApiError("Invalid category", 400, "22023"));
    renderEditor({ postId: "p1" });
    await waitFor(() => expect(screen.getByLabelText("What did you lose?")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("What did you lose?"), { target: { value: "Another title" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/invalid category/i));
    expect(screen.getByRole("alert").textContent).toMatch(/already saved on the report/i);
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
