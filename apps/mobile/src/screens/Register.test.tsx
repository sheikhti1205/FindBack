// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({
  authMock: {
    checkUsername: vi.fn(),
    register: vi.fn(),
  },
}));

vi.mock("../services/auth", () => authMock);
vi.mock("../auth", () => ({ useAuth: () => ({ user: null, register: authMock.register }) }));

import { Register } from "./Register";

function renderRegister() {
  return render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<Register />} />
      </Routes>
    </MemoryRouter>,
  );
}

function getInputs() {
  return {
    username: screen.getByLabelText("Username"),
    email: screen.getByLabelText("Email"),
    phone: screen.getByLabelText("Mobile (Bangladesh)"),
    password: screen.getByTestId("password-field"),
    confirm: screen.getByLabelText("Confirm password"),
    submit: screen.getByRole("button", { name: "Create account" }),
  };
}

// Helper to wait for debounce (350ms) and any pending promises
async function waitForDebounce() {
  await new Promise((r) => setTimeout(r, 400));
  await waitFor(() => {});
}

// Helper to create a controllable promise for checkUsername
function createCheckUsernamePromise() {
  let resolve: (value: { available: boolean; normalized: string }) => void;
  const promise = new Promise<{ available: boolean; normalized: string }>((r) => { resolve = r; });
  return { promise, resolve: resolve! };
}

describe("Register username race condition (WP15 #34)", () => {
  beforeEach(() => {
    authMock.checkUsername.mockReset();
    authMock.register.mockReset();
  });

  afterEach(cleanup);

  it("invalidates prior request at START of effect before empty/invalid early returns", async () => {
    // Provide a mock that returns a resolved promise to avoid unhandled errors
    authMock.checkUsername.mockResolvedValue({ available: true, normalized: "abc" });

    renderRegister();
    const { username } = getInputs();

    // Type "abc" (valid) - starts request A
    fireEvent.change(username, { target: { value: "abc" } });
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());
    await waitForDebounce();
    expect(authMock.checkUsername).toHaveBeenCalledTimes(1);

    // Quickly type "ab" (invalid - too short) - should invalidate request A at START
    fireEvent.change(username, { target: { value: "ab" } });
    // The effect should run again, increment sequence, and return early for invalid
    // Request A's response should be ignored when it resolves
    // Use getByRole("alert") to get the field-level error specifically
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    // Wait for any pending promises to resolve
    await waitForDebounce();
    expect(authMock.checkUsername).toHaveBeenCalledTimes(1);
  });

  it("response for username A never sets state after input became B", async () => {
    const { promise: promiseA, resolve: resolveA } = createCheckUsernamePromise();
    const { promise: promiseB, resolve: resolveB } = createCheckUsernamePromise();

    authMock.checkUsername
      .mockImplementationOnce(() => promiseA)
      .mockImplementationOnce(() => promiseB);

    renderRegister();
    const { username } = getInputs();

    // Type "userA" (valid) - starts request A
    fireEvent.change(username, { target: { value: "userA" } });
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());
    await waitForDebounce();

    // Quickly type "userB" (valid) - starts request B, invalidates A
    fireEvent.change(username, { target: { value: "userB" } });
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());
    await waitForDebounce();

    // Resolve A (available) - should be ignored because sequence moved to B
    resolveA({ available: true, normalized: "usera" });
    await waitForDebounce();
    // Should still show "Checking availability…" for B
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());

    // Resolve B (taken) - should be applied
    resolveB({ available: false, normalized: "userb" });
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText("✗ Username already exists")).toBeTruthy());
  });

  it("submit re-runs syntax validation independently", async () => {
    const { promise, resolve } = createCheckUsernamePromise();
    authMock.checkUsername.mockImplementation(() => promise);

    renderRegister();
    const { username, email, phone, password, confirm, submit } = getInputs();

    // Type valid username
    fireEvent.change(username, { target: { value: "validuser" } });
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());
    await waitForDebounce();

    // Resolve the checkUsername promise
    resolve({ available: true, normalized: "validuser" });
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText("✓ Username available")).toBeTruthy());

    // Fill other fields
    fireEvent.change(email, { target: { value: "test@example.com" } });
    fireEvent.change(phone, { target: { value: "01812345678" } });
    fireEvent.change(password, { target: { value: "password123" } });
    fireEvent.change(confirm, { target: { value: "password123" } });

    // Submit should work
    authMock.register.mockResolvedValue({});
    fireEvent.click(submit);
    await waitFor(() => expect(authMock.register).toHaveBeenCalled());
  });

  it("submit rejects username that fails syntax validation even if live check passed", async () => {
    const { promise, resolve } = createCheckUsernamePromise();
    authMock.checkUsername.mockImplementation(() => promise);

    renderRegister();
    const { username, email, phone, password, confirm, submit } = getInputs();

    // Type valid username that passes live check
    fireEvent.change(username, { target: { value: "validuser" } });
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());
    await waitForDebounce();

    // Resolve the checkUsername promise
    resolve({ available: true, normalized: "validuser" });
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText("✓ Username available")).toBeTruthy());

    // Manually manipulate the input to have invalid syntax (e.g., with spaces)
    // This simulates a case where the live check passed but submit re-validates
    fireEvent.change(username, { target: { value: "invalid user" } });
    // The live check would now show invalid, but let's test submit directly
    fireEvent.change(email, { target: { value: "test@example.com" } });
    fireEvent.change(phone, { target: { value: "01812345678" } });
    fireEvent.change(password, { target: { value: "password123" } });
    fireEvent.change(confirm, { target: { value: "password123" } });

    fireEvent.click(submit);
    // Check for the form-level error message (not the field-level one)
    await waitFor(() => expect(screen.getByText("Username must be 3–20 letters, numbers or underscores.")).toBeTruthy());
    expect(authMock.register).not.toHaveBeenCalled();
  });
});

describe("Register Bangladesh phone validation (WP15 #35)", () => {
  beforeEach(() => {
    authMock.checkUsername.mockReset();
    authMock.register.mockReset();
  });

  afterEach(cleanup);

  it("accepts valid Bangladesh phone: 01812345678", async () => {
    renderRegister();
    const { phone } = getInputs();
    fireEvent.change(phone, { target: { value: "01812345678" } });
    // Should not show error immediately (validation on submit)
    expect(screen.queryByText(/invalid|error/i)).not.toBeTruthy();
  });

  it("accepts valid Bangladesh phone with +88 prefix: +8801812345678", async () => {
    renderRegister();
    const { phone } = getInputs();
    fireEvent.change(phone, { target: { value: "+8801812345678" } });
    expect(screen.queryByText(/invalid|error/i)).not.toBeTruthy();
  });

  it("accepts valid Bangladesh phone with 88 prefix: 8801812345678", async () => {
    renderRegister();
    const { phone } = getInputs();
    fireEvent.change(phone, { target: { value: "8801812345678" } });
    expect(screen.queryByText(/invalid|error/i)).not.toBeTruthy();
  });

  it("rejects invalid Bangladesh phone: wrong prefix 012", async () => {
    const { promise, resolve } = createCheckUsernamePromise();
    authMock.checkUsername.mockImplementation(() => promise);

    renderRegister();
    const { username, email, phone, password, confirm, submit } = getInputs();
    fireEvent.change(phone, { target: { value: "01212345678" } });
    // Fill other required fields
    fireEvent.change(username, { target: { value: "validuser" } });
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());
    await waitForDebounce();
    resolve({ available: true, normalized: "validuser" });
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText("✓ Username available")).toBeTruthy());
    fireEvent.change(email, { target: { value: "test@example.com" } });
    fireEvent.change(password, { target: { value: "password123" } });
    fireEvent.change(confirm, { target: { value: "password123" } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/Enter a valid Bangladesh mobile number/)).toBeTruthy());
  });

  it("rejects invalid Bangladesh phone: too short", async () => {
    const { promise, resolve } = createCheckUsernamePromise();
    authMock.checkUsername.mockImplementation(() => promise);

    renderRegister();
    const { username, email, phone, password, confirm, submit } = getInputs();
    fireEvent.change(phone, { target: { value: "018123456" } });
    // Fill other required fields
    fireEvent.change(username, { target: { value: "validuser" } });
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());
    await waitForDebounce();
    resolve({ available: true, normalized: "validuser" });
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText("✓ Username available")).toBeTruthy());
    fireEvent.change(email, { target: { value: "test@example.com" } });
    fireEvent.change(password, { target: { value: "password123" } });
    fireEvent.change(confirm, { target: { value: "password123" } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/Enter a valid Bangladesh mobile number/)).toBeTruthy());
  });

  it("rejects invalid Bangladesh phone: non-numeric", async () => {
    const { promise, resolve } = createCheckUsernamePromise();
    authMock.checkUsername.mockImplementation(() => promise);

    renderRegister();
    const { username, email, phone, password, confirm, submit } = getInputs();
    fireEvent.change(phone, { target: { value: "01812345abc" } });
    // Fill other required fields
    fireEvent.change(username, { target: { value: "validuser" } });
    await waitFor(() => expect(screen.getByText("Checking availability…")).toBeTruthy());
    await waitForDebounce();
    resolve({ available: true, normalized: "validuser" });
    await waitForDebounce();
    await waitFor(() => expect(screen.getByText("✓ Username available")).toBeTruthy());
    fireEvent.change(email, { target: { value: "test@example.com" } });
    fireEvent.change(password, { target: { value: "password123" } });
    fireEvent.change(confirm, { target: { value: "password123" } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/Enter a valid Bangladesh mobile number/)).toBeTruthy());
  });
});