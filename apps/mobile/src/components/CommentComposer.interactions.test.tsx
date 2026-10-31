// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommentComposer } from "./CommentComposer";

beforeEach(() => {
  vi.stubEnv("VITE_KLIPY_API_KEY", "");
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function setup() {
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<CommentComposer postId="p1" participants={[{ username: "sam" }]} currentUser={{ id: "reader", username: "reader" }} onSubmit={submit} onError={vi.fn()} />);
  return { submit, input: screen.getByRole("combobox", { name: "Comment" }) };
}

it("desktop Enter submits through the existing send owner, clears the field and ignores held-key repeats", async () => {
  const { submit, input } = setup();
  fireEvent.change(input, { target: { value: "Found it" } });
  fireEvent.keyDown(input, { key: "Enter", repeat: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith("Found it"));
  await waitFor(() => expect(input).toHaveProperty("value", ""));
});

it("Shift+Enter, touch Enter and IME confirmation never submit", async () => {
  const { submit, input } = setup();
  fireEvent.change(input, { target: { value: "Found it" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  vi.mocked(matchMedia).mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith("Found it"));
});

it("mention Enter inserts without sending, while the next desktop Enter sends the selected mention", async () => {
  const { submit, input } = setup();
  fireEvent.change(input, { target: { value: "@s", selectionStart: 2 } });
  await screen.findByRole("listbox", { name: "Mention suggestions" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submit).not.toHaveBeenCalled();
  expect(input).toHaveProperty("value", "@sam ");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith("@sam"));
});

it("uses one anchored plus menu for attachment choices, with disabled providers absent", async () => {
  setup();
  expect(screen.queryByRole("menuitem", { name: "Photo" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  expect(await screen.findByRole("menuitem", { name: "Photo" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "GIF" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Sticker" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("does not replace a mention token during IME confirmation or Shift+Enter", async () => {
  const { submit, input } = setup();
  fireEvent.change(input, { target: { value: "@s", selectionStart: 2 } });
  await screen.findByRole("listbox", { name: "Mention suggestions" });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(input).toHaveProperty("value", "@s");
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(input).toHaveProperty("value", "@s");
  expect(submit).not.toHaveBeenCalled();
});

it("opens suggestions when text is pasted into an already focused empty field", async () => {
  const { input } = setup();
  act(() => input.focus());
  fireEvent.input(input, { target: { value: "@s" } });
  expect(await screen.findByRole("listbox", { name: "Mention suggestions" })).toBeTruthy();
});
