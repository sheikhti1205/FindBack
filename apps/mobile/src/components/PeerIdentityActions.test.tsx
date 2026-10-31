// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationProjection } from "../services/messaging/conversationIndex";

const state = vi.hoisted(() => ({
  account: "viewer", status: "ready", projections: {} as Record<string, ConversationProjection> | null,
  create: vi.fn(), send: vi.fn(),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: state.account } }) }));
vi.mock("../services/messaging/useMessaging", () => ({ useMessaging: () => ({
  accountId: state.account, status: state.status, currentProjections: state.projections,
}) }));
vi.mock("../services/messaging/runtime", () => ({
  requestMessagingConversation: (...args: unknown[]) => state.create(...args),
  sendMessagingText: (...args: unknown[]) => state.send(...args),
}));
import { PeerIdentityActions } from "./PeerIdentityActions";
import { UserIdentityProvider, UserIdentityTrigger } from "./UserIdentityTrigger";

const person = { id: "peer", username: "river", displayName: "River Lee", avatarUrl: null };
const connected: ConversationProjection = { conversationId: "chat", peerId: "peer", mode: "CONNECTED", request: "NONE",
  requestEpoch: null, ownBlocked: false, ownHidden: false, ownDeclined: false, revision: 1 };
function mount() {
  return render(<MemoryRouter><Routes>
    <Route path="/" element={<PeerIdentityActions person={person} />} />
    <Route path="/chats/:id" element={<h1>Chat opened</h1>} />
  </Routes></MemoryRouter>);
}
beforeEach(() => {
  state.account = "viewer"; state.status = "ready"; state.projections = {};
  state.create.mockReset().mockResolvedValue("chat"); state.send.mockReset().mockResolvedValue("message");
});
afterEach(cleanup);

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
  expect(state.send).toHaveBeenCalledExactlyOnceWith("viewer", "chat", "peer", "I found your wallet.");
});

it.each([
  ["connected", { ...connected }, "Message", "Connected"],
  ["outgoing", { ...connected, mode: "REQUEST", request: "OUTGOING" }, "View request", "Request sent"],
  ["incoming", { ...connected, mode: "REQUEST", request: "INCOMING" }, "View request", "Message request"],
] as const)("opens the existing %s conversation without creating another request", async (_name, projection, label, summary) => {
  state.projections = { chat: projection };
  mount(); expect(screen.getByText(summary)).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: label }));
  await screen.findByRole("heading", { name: "Chat opened" });
  expect(state.create).not.toHaveBeenCalled(); expect(state.send).not.toHaveBeenCalled();
});

it("does not turn cached or missing authority into a relationship assertion", () => {
  state.status = "offline"; state.projections = null;
  mount(); expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
  expect(screen.queryByText("Connected")).toBeNull();
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
