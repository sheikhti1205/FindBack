// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSetRoleCapabilities } = vi.hoisted(() => ({
  mockSetRoleCapabilities: vi.fn(),
}));

// The service is mocked, not the network: the real capability vocabulary and
// the real human labels stay in place, only the server call is replaced.
vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return {
    ...actual,
    setRoleCapabilities: (...args: unknown[]) => mockSetRoleCapabilities(...args),
  };
});

import { AdminCapabilityMatrix } from "./AdminCapabilityMatrix";
import { ApiError } from "../services/session";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockSetRoleCapabilities.mockResolvedValue(undefined);
});

function renderMatrix(overrides: Partial<ComponentProps<typeof AdminCapabilityMatrix>> = {}) {
  const onCancel = vi.fn();
  const onSaved = vi.fn();
  render(
    <AdminCapabilityMatrix
      email="sam@example.com"
      personLabel="sam@example.com"
      initialCapabilities={["reports_review", "content_hide"]}
      onCancel={onCancel}
      onSaved={onSaved}
      {...overrides}
    />,
  );
  return { onCancel, onSaved };
}

describe("the permission checklist", () => {
  it("offers one box per permission the server can grant a moderator", () => {
    renderMatrix();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(10);
    expect(screen.getByRole("checkbox", { name: "Review reports" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Hide and publish content" })).toBeTruthy();
  });

  it("never offers the permissions that stay with the admin", () => {
    renderMatrix();
    for (const name of [
      "Manage roles and moderators",
      "Manage app settings",
      "Export data",
      "Delete data",
    ]) {
      expect(screen.queryByRole("checkbox", { name })).toBeNull();
    }
    // It says so in words instead of hiding the fact.
    expect(screen.getByText(/stay with the admin/i)).toBeTruthy();
  });

  it("names every permission in words, never by its id", () => {
    renderMatrix();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("reports_review");
    expect(text).not.toContain("content_hide");
    expect(text).not.toContain("roles_manage");
  });

  it("is one labelled group", () => {
    renderMatrix();
    const group = screen.getByRole("group", { name: /what this person may do/i });
    expect(group).toBeTruthy();
  });
});

describe("the permission editor", () => {
  it("does not publish a saved callback after its account-scoped editor unmounts", async () => {
    let finish!: () => void;
    mockSetRoleCapabilities.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const onSaved = vi.fn();
    const view = render(<AdminCapabilityMatrix email="sam@example.com" personLabel="Sam" initialCapabilities={[]} onCancel={() => {}} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Warn members" }));
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    view.unmount();
    await act(async () => { finish(); });
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("keeps Save disabled until something actually changes", () => {
    renderMatrix();
    const save = screen.getByRole("button", { name: /save permissions/i });
    expect(save.getAttribute("disabled")).not.toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Warn members" }));
    expect(screen.getByRole("button", { name: /save permissions/i }).getAttribute("disabled")).toBeNull();
  });

  it("sends the changed set to the server and says it saved", async () => {
    const { onSaved } = renderMatrix();
    fireEvent.click(screen.getByRole("checkbox", { name: "Warn members" }));
    fireEvent.click(screen.getByRole("button", { name: /save permissions/i }));

    await waitFor(() =>
      expect(mockSetRoleCapabilities).toHaveBeenCalledWith("sam@example.com", [
        "reports_review",
        "content_hide",
        "members_warn",
      ]),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("unticking a permission removes it from the set it sends", async () => {
    renderMatrix();
    fireEvent.click(screen.getByRole("checkbox", { name: "Review reports" }));
    fireEvent.click(screen.getByRole("button", { name: /save permissions/i }));
    await waitFor(() =>
      expect(mockSetRoleCapabilities).toHaveBeenCalledWith("sam@example.com", ["content_hide"]),
    );
  });

  it("shows the server's refusal as a message instead of crashing", async () => {
    mockSetRoleCapabilities.mockRejectedValue(
      new ApiError("Only an admin may change capabilities", 403, "42501"),
    );
    renderMatrix();
    fireEvent.click(screen.getByRole("checkbox", { name: "Warn members" }));
    fireEvent.click(screen.getByRole("button", { name: /save permissions/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/only an admin may change what a person may do/i);
  });

  it("cancels without touching the permissions", () => {
    const { onCancel } = renderMatrix();
    fireEvent.click(screen.getByRole("checkbox", { name: "Warn members" }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(mockSetRoleCapabilities).not.toHaveBeenCalled();
  });
});
