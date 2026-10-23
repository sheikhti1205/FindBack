// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester", email: "tester@example.com" }, finishAccountDeletion: vi.fn(), retryDeletionCleanup: vi.fn(), refreshUser: vi.fn() }) }));
vi.mock("../services/supabaseClient", async (original) => ({ ...await original<typeof import("../services/supabaseClient")>(), getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "jwt" } }, error: null }) }, functions: { invoke } }) }));
vi.mock("../services/profile", () => ({ fetchPhoneChangeEligibility: async () => ({ eligible: true }), formatPhoneChangeEligibleAt: () => "" }));
import { AccountSettings } from "./AccountSettings";
afterEach(cleanup);
for (const known of [true, false]) {
  it(`actual deletion service through AccountSettings sanitizes refusal known=${known}`, async () => {
    const sentence = "This is the only admin account. Promote another admin before deleting this one.";
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(Response.json({
      code: known ? "LAST_ADMIN_DELETION_BLOCKED" : "UNKNOWN", error: known ? sentence : "PostgREST relation secret_catalog JWT rpc failed",
      uid: "u1", storageRemoved: 0, profileDeleted: false, authDeleted: false,
    }, { status: 409 })) });
    render(<MemoryRouter><AccountSettings /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    fireEvent.change(screen.getByLabelText(/type your email address/i), { target: { value: "tester@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(known ? sentence : "That conflicts with something already saved. Refresh and try again.");
    expect(alert.textContent).not.toMatch(/PostgREST|JWT|rpc|secret_catalog/);
    if (known) expect(alert.textContent).not.toMatch(/try again|refresh/i);
  });
}
it("actual pending response explains immediate privilege removal and resumable cleanup", async () => {
  invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(Response.json({
    code: "ACCOUNT_DELETION_PENDING", error: "internal storage failure", uid: "u1", storageRemoved: 1, profileDeleted: false, authDeleted: false,
  }, { status: 502 })) });
  render(<MemoryRouter><AccountSettings /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
  fireEvent.change(screen.getByLabelText(/type your email address/i), { target: { value: "tester@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }));
  expect((await screen.findByRole("alert")).textContent).toBe("Your account deletion is pending. Account privileges and uploads remain disabled. Try deleting your account again to finish.");
});
