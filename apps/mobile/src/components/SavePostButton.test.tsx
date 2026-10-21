// @vitest-environment jsdom
/**
 * The Save control: one compact action, a filled bookmark and a changed
 * accessible name for the saved state (never colour alone), an announcement
 * that follows the OUTCOME (never a save that did not happen), and no crash
 * when it is rendered on its own.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, authState } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  authState: { userId: "u1" as string | null },
}));

vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ rpc: rpcMock }) }));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: authState.userId ? { id: authState.userId, username: "alice" } : null }),
}));

import { SavePostButton } from "./SavePostButton";
import { SavedReportsProvider } from "../hooks/useSavedReports";
import { readSavedReports } from "../services/savedReports";

function renderButton(withProvider = true) {
  return render(
    withProvider ? (
      <SavedReportsProvider>
        <SavePostButton postId="p1" />
      </SavedReportsProvider>
    ) : (
      <SavePostButton postId="p1" />
    ),
  );
}

/** The messages the control announces to the reader. */
function listenForAnnouncements(): { heard: string[]; stop: () => void } {
  const heard: string[] = [];
  const handler = (event: Event) => {
    heard.push((event as CustomEvent<string>).detail ?? "");
  };
  window.addEventListener("findback:announce", handler);
  return { heard, stop: () => window.removeEventListener("findback:announce", handler) };
}

beforeEach(() => {
  localStorage.clear();
  rpcMock.mockReset();
  authState.userId = "u1";
  rpcMock.mockResolvedValue({ data: { items: [], complete: true }, error: null });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SavePostButton", () => {
  it("reads as an unsaved action before it is tapped", () => {
    renderButton();
    const button = screen.getByTestId("save-report-button");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Save report");
    expect(button.textContent).toContain("Save");
  });

  it("keeps a 44px touch target and the house action class", () => {
    renderButton();
    const button = screen.getByTestId("save-report-button");
    expect(button.className).toMatch(/fb-report-action/);
    expect(button.className).toMatch(/min-h-\[44px\]/);
    expect(button.className).toMatch(/min-w-\[44px\]/);
  });

  it("fills the bookmark and changes the word when saved", async () => {
    renderButton();
    const button = screen.getByTestId("save-report-button");

    fireEvent.click(button);

    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    expect(button.getAttribute("aria-label")).toBe("Remove from saved reports");
    expect(button.textContent).toContain("Saved");
    // The shape changes as well as the colour: a filled bookmark and a
    // different word, so the state survives a monochrome screen.
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("fill")).toBe("currentColor");
  });

  it("saves on this device immediately, without waiting for the account", async () => {
    renderButton();
    fireEvent.click(screen.getByTestId("save-report-button"));
    await waitFor(() => expect(readSavedReports("u1")).toHaveLength(1));
    expect(readSavedReports("u1")[0]!.postId).toBe("p1");
  });

  it("unsaves on a second tap", async () => {
    renderButton();
    const button = screen.getByTestId("save-report-button");
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("false"));
    expect(readSavedReports("u1")).toHaveLength(0);
  });

  it("announces the save that actually happened", async () => {
    const { heard, stop } = listenForAnnouncements();
    try {
      renderButton();
      fireEvent.click(screen.getByTestId("save-report-button"));
      await waitFor(() => expect(heard.join(" ")).toMatch(/report saved/i));
    } finally {
      stop();
    }
  });

  it("renders and stays harmless outside a provider", async () => {
    renderButton(false);
    const button = screen.getByTestId("save-report-button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Save report");
    // Without an account there is nothing to save FOR: the control says so
    // instead of taking a tap that would do nothing.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(readSavedReports("u1")).toHaveLength(0);
  });

  it("is disabled and announces nothing when there is no account", async () => {
    authState.userId = null;
    const { heard, stop } = listenForAnnouncements();
    try {
      renderButton();
      const button = screen.getByTestId("save-report-button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(heard).toEqual([]);
      expect(readSavedReports("u1")).toHaveLength(0);
    } finally {
      stop();
    }
  });
});
