// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerShell } from "./ComposerShell";

afterEach(cleanup);

function renderComposer(props = {}) {
  const send = vi.fn();
  render(<ComposerShell value="hello" onChange={vi.fn()} onSend={send} inputLabel="Message" enterSends {...props} />);
  return { send, input: screen.getByRole("textbox", { name: "Message" }) };
}

it("Enter sends, while Shift+Enter and modified Enter keep native editing", () => {
  const { send, input } = renderComposer();
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(input, { key: "Enter", altKey: true });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("composition and legacy IME keycode 229 never send", () => {
  const { send, input } = renderComposer();
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(send).not.toHaveBeenCalled();
});

it.each([{ busy: true }, { disabled: true }, { canSend: false }, { value: "  " }])("refuses button/form/Enter sends when unavailable %j", (props) => {
  const { send, input } = renderComposer(props);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.submit(input.closest("form")!);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).not.toHaveBeenCalled();
});

it("coarse input keeps Enter as newline while the Send button stays available", () => {
  const { send, input } = renderComposer({ enterSends: false });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledTimes(1);
});
