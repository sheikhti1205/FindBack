// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { ChatIdentity } from "./Messaging";

afterEach(cleanup);

it("uses the canonical public identity card and restores focus across repeated dismissal", async () => {
  const name = "a-very-long-participant-name-that-needs-to-remain-readable";
  render(<MemoryRouter><ChatIdentity peerId="peer" name={name} status="Connected" /></MemoryRouter>);
  const button = screen.getByRole("button", { name: `About ${name}` });
  button.focus();
  fireEvent.click(button);
  let dialog = screen.getByRole("dialog", { name: `About ${name}` });
  expect(within(dialog).getByText(`@${name}`)).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "View profile" }).getAttribute("href")).toBe(`/u/${name}`);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: `About ${name}` })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));

  fireEvent.click(button);
  dialog = screen.getByRole("dialog", { name: `About ${name}` });
  expect(within(dialog).getByRole("link", { name: "View profile" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(button));
});

it("does not offer participant details before a name is available", () => {
  render(<ChatIdentity status="Connected" />);
  expect(screen.getByText("Conversation")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull();
});

it("treats the avatar and name as one identity trigger without a dropdown chevron", () => {
  render(<MemoryRouter><ChatIdentity peerId="peer" name="peer_name" status="Connected" /></MemoryRouter>);
  const button = screen.getByRole("button", { name: "About peer_name" });
  const avatar = button.querySelector('[data-testid="user-avatar"]') as HTMLElement | null;
  expect(avatar).toBeTruthy();
  expect(avatar!.style.width).toBe("44px");
  expect(avatar!.style.height).toBe("44px");
  expect(button.textContent).toContain("peer_name");
  expect(button.textContent).not.toContain("@");
  expect(document.querySelector(".lucide-chevron-down")).toBeNull();
});

it("shows the real name while retaining the username for profile navigation", () => {
  render(<MemoryRouter><ChatIdentity peerId="peer" name="Sam Rivera" username="sam_r" status="Connected" /></MemoryRouter>);
  const button = screen.getByRole("button", { name: "About Sam Rivera" });
  expect(button.textContent).toContain("Sam Rivera");
  expect(button.textContent).not.toContain("@sam_r");
  fireEvent.click(button);
  expect(screen.getByRole("link", { name: "View profile" }).getAttribute("href")).toBe("/u/sam_r");
});
