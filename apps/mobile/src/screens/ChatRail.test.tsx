// @vitest-environment jsdom
import { MemoryRouter } from "react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRail } from "./Messaging";

const ROWS = [
  { conversationId: "c-1", peerId: "p-1", unreadCount: 3 },
  { conversationId: "c-2", peerId: "p-2", unreadCount: 0 },
];
const LABELS = new Map([["p-1", "river"], ["p-2", "meadow"]]);

beforeEach(() => {});
afterEach(cleanup);

function renderRail(overrides: Partial<Parameters<typeof ChatRail>[0]> = {}) {
  const onExpand = vi.fn();
  render(<MemoryRouter><ChatRail rows={ROWS} labels={LABELS} selectedId="c-1"
    onExpand={onExpand} {...overrides} /></MemoryRouter>);
  return { onExpand };
}

describe("the collapsed conversation rail", () => {
  it("keeps every person reachable as a labelled destination", () => {
    renderRail();
    expect(screen.getByRole("link", { name: "@river, 3 unread" }).getAttribute("href")).toBe("/chats/c-1");
    expect(screen.getByRole("link", { name: "@meadow" }).getAttribute("href")).toBe("/chats/c-2");
    expect(screen.getByRole("link", { name: "@river, 3 unread" }).getAttribute("aria-current")).toBe("page");
  });

  it("does not put names, previews or counts where the rail has no room", () => {
    renderRail();
    expect(screen.queryByText("@river")).toBeNull();
    expect(screen.queryByText("3")).toBeNull();
  });

  it("offers one control back to the full list", () => {
    const { onExpand } = renderRail();
    const expand = screen.getByRole("button", { name: "Expand conversation list" });
    expect(expand.querySelector("svg")).toBeTruthy();
    fireEvent.click(expand);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("names an unnamed person plainly instead of inventing one", () => {
    renderRail({ labels: new Map() });
    expect(screen.getByRole("link", { name: "Conversation" })).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
});
