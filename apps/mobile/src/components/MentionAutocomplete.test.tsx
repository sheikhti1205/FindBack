// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { searchProfilesByPrefix } from "../services/profile";

vi.mock("../services/profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/profile")>();
  return { ...actual, searchProfilesByPrefix: vi.fn() };
});

const searchMock = vi.mocked(searchProfilesByPrefix);

function Harness({
  value,
  onInsert,
}: {
  value: string;
  onInsert: (next: string, caret: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input ref={inputRef} aria-label="Comment" value={value} readOnly />
      <MentionAutocomplete
        inputRef={inputRef}
        value={value}
        participants={[{ username: "alice", displayName: "Alice A", avatarUrl: null }]}
        owner={{ username: "carol", displayName: "Carol C", avatarUrl: null }}
        onInsert={onInsert}
      />
    </>
  );
}

function caretToEnd() {
  const input = screen.getByLabelText("Comment") as HTMLInputElement;
  input.setSelectionRange(input.value.length, input.value.length);
  fireEvent.keyUp(input);
  return input;
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
});

afterEach(cleanup);

describe("MentionAutocomplete", () => {
  it("opens on a bare @ and lists participants above the owner", () => {
    render(<Harness value="hi @" onInsert={() => {}} />);
    caretToEnd();

    expect(screen.getByRole("listbox")).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toMatch(/alice/);
    expect(options[1]?.textContent).toMatch(/carol/);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("ranks a matching participant above a server result", async () => {
    searchMock.mockResolvedValue([
      { id: "u7", username: "alex", displayName: "Alex", avatarUrl: null },
    ]);
    render(<Harness value="ping @al" onInsert={() => {}} />);
    caretToEnd();

    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("al"));
    const options = await screen.findAllByRole("option");
    expect(options[0]?.textContent).toMatch(/alice/);
    expect(options[1]?.textContent).toMatch(/alex/);
  });

  it("inserts the token with a trailing space and caret on keyboard select", () => {
    const onInsert = vi.fn();
    render(<Harness value="ping @al" onInsert={onInsert} />);
    const input = caretToEnd();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onInsert).toHaveBeenCalledWith("ping @alice ", "ping @alice ".length);
  });

  it("closes on Escape and keeps focus in the input", () => {
    render(<Harness value="hi @" onInsert={() => {}} />);
    const input = caretToEnd();
    expect(screen.queryByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("debounces server calls with latest-wins and discards stale responses", async () => {
    vi.useFakeTimers();
    try {
      type Row = { id: string; username: string; displayName: string | null; avatarUrl: string | null };
      let resolveAlbe!: (v: Row[]) => void;
      const albePending = new Promise<Row[]>((res) => {
        resolveAlbe = res;
      });
      searchMock.mockImplementation(async (prefix: string): Promise<Row[]> =>
        prefix === "albe"
          ? albePending
          : [{ id: "u8", username: "albert", displayName: "Albert", avatarUrl: null }],
      );

      // Rapid retype before the debounce fires: one trailing call only.
      const { rerender } = render(<Harness value="x @al" onInsert={() => {}} />);
      caretToEnd();
      rerender(<Harness value="x @alb" onInsert={() => {}} />);
      caretToEnd();
      rerender(<Harness value="x @albe" onInsert={() => {}} />);
      caretToEnd();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(searchMock).toHaveBeenCalledTimes(1);
      expect(searchMock).toHaveBeenCalledWith("albe");

      // A newer frag resolves while the older one is still pending; when the
      // stale response lands late it must not clobber the list.
      rerender(<Harness value="x @alber" onInsert={() => {}} />);
      caretToEnd();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(searchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("option", { name: /albert/ })).toBeTruthy();
      await act(async () => {
        resolveAlbe([{ id: "stale", username: "alberta", displayName: "Stale", avatarUrl: null }]);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByText(/alberta/)).toBeNull();
      expect(screen.getByRole("option", { name: /albert/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on blur after a short delay so a touch-select lands first", async () => {
    vi.useFakeTimers();
    try {
      render(<Harness value="hi @" onInsert={() => {}} />);
      const input = caretToEnd();
      expect(screen.queryByRole("listbox")).toBeTruthy();

      fireEvent.blur(input);
      // Still mounted immediately: the delayed close lets mousedown select.
      expect(screen.queryByRole("listbox")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(screen.queryByRole("listbox")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects on touch via mousedown without losing the caret", () => {
    const onInsert = vi.fn();
    render(<Harness value="hi @" onInsert={onInsert} />);
    caretToEnd();

    const option = screen.getByRole("option", { name: /alice/ });
    fireEvent.mouseDown(option);

    expect(onInsert).toHaveBeenCalledWith("hi @alice ", "hi @alice ".length);
  });
});
