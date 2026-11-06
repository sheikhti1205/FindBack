// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationProjection } from "../services/messaging/conversationIndex";

const state = vi.hoisted(() => ({
  account: "viewer", status: "ready", projections: {} as Record<string, ConversationProjection> | null,
  create: vi.fn(), send: vi.fn(), refresh: vi.fn(),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: state.account } }) }));
vi.mock("../services/messaging/useMessaging", () => ({ useMessaging: () => ({
  accountId: state.account, status: state.status, currentProjections: state.projections,
}) }));
vi.mock("../services/messaging/runtime", () => ({
  requestMessagingConversation: (...args: unknown[]) => state.create(...args),
  refreshMessaging: (...args: unknown[]) => state.refresh(...args),
  sendMessagingText: (...args: unknown[]) => state.send(...args),
}));
import { PeerIdentityActions } from "./PeerIdentityActions";
import { UserIdentityProvider, UserIdentityTrigger } from "./UserIdentityTrigger";
import type { PublicIdentity } from "./UserIdentityTrigger";

const person = { id: "peer", username: "river", displayName: "River Lee", avatarUrl: null };
const connected: ConversationProjection = { conversationId: "chat", peerId: "peer", mode: "CONNECTED", request: "NONE",
  requestEpoch: null, ownBlocked: false, ownHidden: false, ownDeclined: false, revision: 1 };
function mount(identity: PublicIdentity = person) {
  return render(identityTree(identity));
}
function identityTree(identity: PublicIdentity) {
  return <MemoryRouter><Routes>
    <Route path="/" element={<PeerIdentityActions person={identity} />} />
    <Route path="/chats/:id" element={<h1>Chat opened</h1>} />
  </Routes></MemoryRouter>;
}
beforeEach(() => {
  state.account = "viewer"; state.status = "ready"; state.projections = {};
  state.create.mockReset().mockResolvedValue("chat"); state.send.mockReset().mockResolvedValue("message");
});
afterEach(cleanup);

it("supplies the §9 safety rows in a stranger quick card", async () => {
  mount();
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "More profile actions" }));
  expect(await screen.findByRole("menuitem", { name: "Report user" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Block account" })).toBeTruthy();
});

it("names an outgoing request's conversation action and keeps safety available", () => {
  state.projections = { chat: { ...connected, mode: "REQUEST", request: "OUTGOING" } };
  mount();
  expect(screen.getByText("Request sent")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open request conversation" }).getAttribute("href")).toBe("/chats/chat");
  expect(screen.getByRole("button", { name: "More profile actions" })).toBeTruthy();
});

it("keeps an incoming request as View request with safety available", () => {
  state.projections = { chat: { ...connected, mode: "REQUEST", request: "INCOMING" } };
  mount();
  expect(screen.getByRole("link", { name: "View request" }).getAttribute("href")).toBe("/chats/chat");
  expect(screen.getByRole("button", { name: "More profile actions" })).toBeTruthy();
});

it("offers connection options alongside message on a connected card", () => {
  state.projections = { chat: connected };
  mount();
  expect(screen.getByRole("link", { name: "Message" }).getAttribute("href")).toBe("/chats/chat");
  expect(screen.getByRole("link", { name: "Connection options" }).getAttribute("href")).toBe("/chats/chat");
  expect(screen.getByRole("button", { name: "More profile actions" })).toBeTruthy();
});

it("supplies the same contact owner to a public quick card without leaking private identity", async () => {
  render(<MemoryRouter><UserIdentityProvider actions={PeerIdentityActions}>
    <UserIdentityTrigger person={{ ...person, email: "private@example.test" } as typeof person} />
  </UserIdentityProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "About River Lee" }));
  const card = await screen.findByRole("dialog", { name: "About River Lee" });
  expect(card.textContent).not.toContain("private@example.test");
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("dialog", { name: "Connect with River Lee" })).toBeTruthy();
  expect(state.create).not.toHaveBeenCalled();
});

it("opens first contact without creating or sending until explicit Send request", async () => {
  mount(); fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("dialog", { name: "Connect with River Lee" });
  expect(state.create).not.toHaveBeenCalled(); expect(state.send).not.toHaveBeenCalled();
  const send = screen.getByRole("button", { name: "Send request" }); expect(send).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value: "I found your wallet." } });
  fireEvent.click(send);
  await screen.findByRole("heading", { name: "Chat opened" });
  expect(state.create).toHaveBeenCalledExactlyOnceWith("viewer", "peer");
  expect(state.send).toHaveBeenCalledExactlyOnceWith("viewer", "chat", "peer", "I found your wallet.", undefined);
});

it("carries the report subject into an existing conversation without sending", () => {
  state.projections = { chat: connected };
  mount({ ...person, contextReportId: "report-id" });
  expect(screen.getByRole("link", { name: "Message about this report" }).getAttribute("href")).toBe("/chats/chat?report=report-id");
  expect(state.create).not.toHaveBeenCalled(); expect(state.send).not.toHaveBeenCalled();
});

it("sends explicit report-origin first contact with that report, not a copied report", async () => {
  mount({ ...person, contextReportId: "report-id" });
  fireEvent.click(screen.getByRole("button", { name: "Connect about this report" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "First message" }), { target: { value: "Is this yours?" } });
  expect(state.send).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  await screen.findByRole("heading", { name: "Chat opened" });
  expect(state.send).toHaveBeenCalledExactlyOnceWith("viewer", "chat", "peer", "Is this yours?", "report-id");
});

it("drops pending first contact when the report subject changes", async () => {
  let resolve!: (id: string) => void;
  state.create.mockReturnValue(new Promise<string>(done => { resolve = done; }));
  const view = mount({ ...person, contextReportId: "first-report" });
  fireEvent.click(screen.getByRole("button", { name: "Connect about this report" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "First message" }), { target: { value: "About the first report" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  view.rerender(identityTree({ ...person, contextReportId: "second-report" }));
  await act(async () => { resolve("chat"); }); expect(state.send).not.toHaveBeenCalled();
});

it.each([
  ["connected", { ...connected }, "Message", "Connected"],
  ["outgoing", { ...connected, mode: "REQUEST", request: "OUTGOING" }, "Open request conversation", "Request sent"],
  ["incoming", { ...connected, mode: "REQUEST", request: "INCOMING" }, "View request", "Message request"],
] as const)("opens the existing %s conversation without creating another request", async (_name, projection, label, summary) => {
  state.projections = { chat: projection };
  mount(); expect(screen.getByText(summary)).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: label }));
  await screen.findByRole("heading", { name: "Chat opened" });
  expect(state.create).not.toHaveBeenCalled(); expect(state.send).not.toHaveBeenCalled();
});

it("does not turn cached or missing authority into a relationship assertion", async () => {
  state.status = "offline"; state.projections = null;
  mount();
  // No relationship is asserted from cached or missing authority.
  expect(screen.queryByText("Connected")).toBeNull();
  // The action stays usable: opening it says why, instead of a disabled control
  // with no explanation (owner feedback 2026-11-06).
  const connect = screen.getByRole("button", { name: "Connect" });
  expect(connect).toHaveProperty("disabled", false);
  fireEvent.click(connect);
  const dialog = await screen.findByRole("dialog", { name: "Connect with River Lee" });
  expect(dialog.textContent).toContain("offline");
  expect(within(dialog).getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(state.create).not.toHaveBeenCalled();
});

it("shows no contact action for self or a locally blocked peer", () => {
  state.account = "peer"; const view = mount();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  state.account = "viewer"; state.projections = { chat: { ...connected, ownBlocked: true } };
  view.rerender(<MemoryRouter><PeerIdentityActions person={person} /></MemoryRouter>);
  expect(screen.queryByRole("link", { name: "Message" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
});

it("drops a pending first-contact continuation across an account replacement", async () => {
  let resolve!: (id: string) => void;
  state.create.mockReturnValue(new Promise<string>(done => { resolve = done; }));
  const view = mount(); fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "First message" }), { target: { value: "Hello River" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  state.account = "replacement";
  view.rerender(<MemoryRouter><PeerIdentityActions person={person} /></MemoryRouter>);
  await act(async () => { resolve("old-chat"); });
  expect(state.send).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not offer a blind duplicate send after an ambiguous persistence failure", async () => {
  state.send.mockRejectedValue(new Error("reload failed after possible persistence"));
  mount(); fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "First message" }), { target: { value: "Hello River" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
  expect(screen.getByRole("link", { name: "Open chat to check" }).getAttribute("href")).toBe("/chats/chat");
  expect(state.send).toHaveBeenCalledTimes(1);
});
