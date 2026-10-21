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

describe("HistorySheet FBX-020 regions", () => {
  it("exposes search, new-chat and clear regions by test id", () => {
    const props = baseProps();
    render(<HistorySheet {...props} />);
    expect(screen.getByTestId("history-search").getAttribute("aria-label")).toBe("Search chats");
    fireEvent.click(screen.getByTestId("history-new-chat"));
    expect(props.onNew).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("history-clear"));
    // The chat history lives in this session's memory only, so the copy says
    // exactly that: it is not a saved, permanent history.
    expect(screen.getByText(/delete every chat kept in this session/i)).toBeTruthy();
  });
});
