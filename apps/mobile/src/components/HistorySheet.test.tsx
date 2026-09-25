// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HistorySheet } from "./HistorySheet";
import { resetBackInterceptors } from "./backNavigation";

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
});

const CHATS = [
  { id: "c1", title: "Lost keys", updatedAt: "2026-09-26T10:00:00.000Z", preview: "Where did I..." },
  { id: "c2", title: "Found wallet", updatedAt: "2026-09-26T11:00:00.000Z" },
];

function baseProps(overrides = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    chats: CHATS,
    activeChatId: "c1",
    searchQuery: "",
    onSearchQueryChange: vi.fn(),
    onNew: vi.fn(),
    onContinue: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
    historyEnabled: true,
    onToggleHistory: vi.fn(),
    ...overrides,
  };
}

describe("HistorySheet popup", () => {
  it("lists chats as a popup with search, not a sidebar", () => {
    render(<HistorySheet {...baseProps()} />);
    expect(screen.getByTestId("history-sheet")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Chat history" })).toBeTruthy();
    expect(screen.getByText("Lost keys")).toBeTruthy();
    expect(screen.getByText("Found wallet")).toBeTruthy();
    expect(screen.getByLabelText("Search chats")).toBeTruthy();
  });

  it("starts a new chat and continues an existing one", () => {
    const props = baseProps();
    render(<HistorySheet {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(props.onNew).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Continue Found wallet/ }));
    expect(props.onContinue).toHaveBeenCalledWith("c2");
  });

  it("renames a chat inline", () => {
    const props = baseProps();
    render(<HistorySheet {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Lost keys" }));
    fireEvent.change(screen.getByLabelText("Chat title"), { target: { value: "Lost house keys" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    expect(props.onRename).toHaveBeenCalledWith("c1", "Lost house keys");
  });

  it("deletes with a two-tap confirm and clears all with a two-tap confirm", () => {
    const props = baseProps();
    render(<HistorySheet {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Lost keys" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(props.onDelete).toHaveBeenCalledWith("c1");
    fireEvent.click(screen.getByRole("button", { name: "Clear all chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear all" }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("toggles history with an explicit switch", () => {
    const props = baseProps({ historyEnabled: false });
    render(<HistorySheet {...props} />);
    const toggle = screen.getByRole("switch", { name: /chat history/i });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(props.onToggleHistory).toHaveBeenCalledWith(true);
  });

  it("shows an empty state when no chats match", () => {
    render(<HistorySheet {...baseProps({ chats: [], searchQuery: "zzz" })} />);
    expect(screen.getByTestId("history-empty").textContent).toMatch(/no chats/i);
  });
});
