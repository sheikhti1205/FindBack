// @vitest-environment jsdom
/**
 * The administrator setup row.
 *
 * The row is the ONLY place in the app that offers the one-time claim, so the
 * property under test is a visibility one: it must be invisible to every
 * account the server does not name. "Invisible" means nothing is rendered at
 * all — not a disabled row, not a note — so that no ordinary account ever
 * reads the word "administrator" on its Settings page.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetchBootstrapClaimStatus, authState } = vi.hoisted(() => ({
  mockFetchBootstrapClaimStatus: vi.fn(),
  authState: { user: { id: "owner" } },
}));

vi.mock("../auth", () => ({ useAuth: () => authState }));

vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return {
    ...actual,
    fetchBootstrapClaimStatus: (...args: unknown[]) => mockFetchBootstrapClaimStatus(...args),
  };
});

import { AdminBootstrapRow } from "./AdminBootstrapRow";

afterEach(cleanup);

const CAN_CLAIM = {
  canClaim: true,
  reason: null,
  alreadyAdmin: false,
  hasAdmin: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: "owner" };
  mockFetchBootstrapClaimStatus.mockResolvedValue({
    canClaim: false,
    reason: "This account is not in the admin bootstrap list",
    alreadyAdmin: false,
    hasAdmin: false,
  });
});

function renderRow() {
  return render(
    <MemoryRouter>
      <AdminBootstrapRow />
    </MemoryRouter>,
  );
}

describe("the administrator setup row", () => {
  it("forgets eligibility immediately when the signed-in account changes", async () => {
    mockFetchBootstrapClaimStatus.mockResolvedValueOnce(CAN_CLAIM);
    const view = renderRow();
    await screen.findByText("Become the administrator");
    authState.user = { id: "ordinary" };
    view.rerender(<MemoryRouter><AdminBootstrapRow /></MemoryRouter>);
    expect(screen.queryByText("Become the administrator")).toBeNull();
    await waitFor(() => expect(mockFetchBootstrapClaimStatus).toHaveBeenCalledTimes(2));
  });
  it("is hidden when the server says this account may not claim", async () => {
    renderRow();

    await waitFor(() => expect(mockFetchBootstrapClaimStatus).toHaveBeenCalled());
    expect(screen.queryByText("Become the administrator")).toBeNull();
    // Not a single word about administration leaks to an ordinary account.
    expect(document.body.textContent ?? "").not.toMatch(/administrator|admin/i);
  });

  it("renders nothing at all while the server has not answered", () => {
    let resolve: (value: unknown) => void = () => {};
    mockFetchBootstrapClaimStatus.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const { container } = renderRow();

    expect(container.textContent).toBe("");
    resolve(CAN_CLAIM);
  });

  it("is hidden when the answer cannot be read at all", async () => {
    mockFetchBootstrapClaimStatus.mockRejectedValue(new Error("network down"));

    renderRow();

    await waitFor(() => expect(mockFetchBootstrapClaimStatus).toHaveBeenCalled());
    expect(screen.queryByText("Become the administrator")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/administrator|admin/i);
  });

  it("appears when the server says this account may claim", async () => {
    mockFetchBootstrapClaimStatus.mockResolvedValue(CAN_CLAIM);

    renderRow();

    expect(await screen.findByText("Become the administrator")).toBeTruthy();
    expect(screen.getByText("Set up this account as the admin of FindBack.")).toBeTruthy();
  });

  it("asks the SERVER, once, and never guesses", async () => {
    mockFetchBootstrapClaimStatus.mockResolvedValue(CAN_CLAIM);

    renderRow();

    await screen.findByText("Become the administrator");
    expect(mockFetchBootstrapClaimStatus).toHaveBeenCalledTimes(1);
  });
});
