// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ChatIdentity } from "./Messaging";

afterEach(cleanup);

it("opens the full participant name and restores focus across repeated dismissal", async () => {
  const name = "a-very-long-participant-name-that-needs-to-remain-readable";
  render(<ChatIdentity name={name} status="Connected" />);
  const button = screen.getByRole("button", { name: `@${name}` });
  button.focus();
  fireEvent.click(button);
  let dialog = screen.getByRole("dialog", { name: "Conversation participant" });
  expect(within(dialog).getByText(`@${name}`)).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Conversation participant" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));

  fireEvent.click(button);
  dialog = screen.getByRole("dialog", { name: "Conversation participant" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(document.activeElement).toBe(button));
});

it("does not offer participant details before a name is available", () => {
  render(<ChatIdentity status="Connected" />);
  expect(screen.getByText("Conversation")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull();
});
