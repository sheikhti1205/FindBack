// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null, authSessionId: null as string | null },
}));

const runtime = vi.hoisted(() => ({
  setMessagingAccount: vi.fn(),
  clearMessagingRuntime: vi.fn(),
}));
const backup = vi.hoisted(() => ({
  startDriveBackup: vi.fn<() => () => void>(),
  clearDriveBackup: vi.fn(),
}));

vi.mock("../auth", () => ({ useAuth: () => ({ ...state.auth }) }));
vi.mock("../services/messaging/useMessaging", () => ({ useMessaging: () => ({ threadSync: null, restoration: null }) }));
vi.mock("../services/messaging/runtime", () => ({
  setMessagingAccount: runtime.setMessagingAccount,
  clearMessagingRuntime: runtime.clearMessagingRuntime,
}));
vi.mock("../services/messaging/backupRuntime", () => ({
  startDriveBackup: backup.startDriveBackup,
  clearDriveBackup: backup.clearDriveBackup,
}));

import { MessagingLifecycle } from "./MessagingLifecycle";

/** Every mutation is recorded in one order so a disposal can be proven to
 *  happen before the next owner is installed, not after it. */
const order: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  state.auth = { user: null, authSessionId: null };
  runtime.setMessagingAccount.mockImplementation((accountId: string | null, session: string | null) => {
    order.push(`set:${accountId ?? "null"}:${session ?? "null"}`);
  });
  runtime.clearMessagingRuntime.mockImplementation(() => { order.push("clear-runtime"); });
  backup.clearDriveBackup.mockImplementation(() => { order.push("clear-backup"); });
  backup.startDriveBackup.mockImplementation(() => {
    order.push("start");
    return () => { order.push("stop"); };
  });
});

afterEach(cleanup);

function signedIn(id: string, session = `session-${id}`) {
  state.auth = { user: { id }, authSessionId: session };
}

describe("messaging lifecycle ownership", () => {
  it("starts the owner when the restored session arrives without revoking it", () => {
    const view = render(<MessagingLifecycle />);
    expect(backup.startDriveBackup).not.toHaveBeenCalled();

    signedIn("A");
    view.rerender(<MessagingLifecycle />);

    // A boot transition is not a sign-out: the stored Drive grant must survive,
    // otherwise every reload would silently disable automatic backup.
    expect(backup.clearDriveBackup).not.toHaveBeenCalled();
    expect(runtime.clearMessagingRuntime).not.toHaveBeenCalled();
    expect(backup.startDriveBackup).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["set:null:null", "set:A:session-A", "start"]);
  });

  it("disposes the previous owner before installing a different account", () => {
    signedIn("A");
    const view = render(<MessagingLifecycle />);
    expect(backup.startDriveBackup).toHaveBeenCalledTimes(1);

    signedIn("B");
    view.rerender(<MessagingLifecycle />);

    expect(order).toEqual([
      "set:A:session-A", "start",
      "stop", "clear-backup", "clear-runtime", "set:B:session-B", "start",
    ]);
  });

  it("disposes the owner on sign-out and starts nothing", () => {
    signedIn("A");
    const view = render(<MessagingLifecycle />);

    state.auth = { user: null, authSessionId: null };
    view.rerender(<MessagingLifecycle />);

    expect(order).toEqual([
      "set:A:session-A", "start", "stop", "clear-backup", "clear-runtime", "set:null:null",
    ]);
    expect(backup.startDriveBackup).toHaveBeenCalledTimes(1);
  });

  it("keeps the same account's owner across a session refresh", () => {
    signedIn("A", "session-1");
    const view = render(<MessagingLifecycle />);

    signedIn("A", "session-2");
    view.rerender(<MessagingLifecycle />);

    expect(backup.clearDriveBackup).not.toHaveBeenCalled();
    expect(runtime.clearMessagingRuntime).not.toHaveBeenCalled();
    // The refreshed session still reaches the runtime and the ticker restarts.
    expect(order).toEqual([
      "set:A:session-1", "start", "stop", "set:A:session-2", "start",
    ]);
  });

  it("waits for the session token before starting a backup owner", () => {
    state.auth = { user: { id: "A" }, authSessionId: null };
    const view = render(<MessagingLifecycle />);
    expect(order).toEqual(["set:A:null"]);
    expect(backup.startDriveBackup).not.toHaveBeenCalled();

    signedIn("A");
    view.rerender(<MessagingLifecycle />);
    expect(order).toEqual(["set:A:null", "set:A:session-A", "start"]);
  });
});
