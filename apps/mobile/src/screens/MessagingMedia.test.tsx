// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { MessagingThread } from "./Messaging";
import { Capacitor } from "@capacitor/core";
import { PhotoUnavailableError } from "../services/messaging/mediaTransport";

const m = vi.hoisted(() => {
  const view = { mode: "CONNECTED", request: "OUTGOING", ownBlocked: false };
  return { view, chat: { accountId: "account", status: "ready", revision: 1,
    conversations: [{ conversationId: "chat", peerId: "peer", cachedProjection: view }], currentProjections: { chat: view } },
    messages: [] as unknown[], media: [] as unknown[], outbox: [] as unknown[],
    prepare: vi.fn(), send: vi.fn(), read: vi.fn(), download: vi.fn(), remove: vi.fn(), recover: vi.fn(), retry: vi.fn(), receipt: vi.fn(), observe: vi.fn(), refresh: vi.fn(), choose: vi.fn(), import: vi.fn(), file: vi.fn() };
});
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "account" } }) }));
vi.mock("../services/accountLabels", () => ({ fetchAccountLabels: async () => new Map() }));
vi.mock("../services/messaging/useMessaging", () => ({ useMessaging: () => m.chat }));
vi.mock("../services/messaging/runtime", () => ({ readMessagingThreadState: async () => ({ messages: m.messages, outbox: m.outbox, media: m.media }), fetchMessagingReceiptView: m.receipt, observeMessagingReceipt: m.observe, markMessagingConversationRead: async () => {}, refreshMessaging: m.refresh, sendMessagingText: async () => {}, sendMessagingMedia: m.send, readMessagingMedia: m.read, downloadMessagingMedia: m.download, changeMessagingRelationship: async () => {}, clearMessagingConversation: async () => {}, removeMessagingMessage: m.remove, recoverMessagingText: m.recover, retryMessagingMessage: m.retry }));
vi.mock("../services/messaging/preparePhoto", () => ({ prepareMessagingPhoto: m.prepare }));
vi.mock("../services/media/nativeMedia", () => ({ chooseNativeImages: m.choose, importNativeImageUri: m.import, importedImageToFile: m.file }));
beforeEach(() => { vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() }); m.view.mode = "CONNECTED"; m.view.ownBlocked = false; m.chat.revision = 1; m.messages = []; m.media = []; m.outbox = []; m.prepare.mockReset(); m.send.mockReset(); m.read.mockReset().mockResolvedValue(null); m.download.mockReset().mockResolvedValue(undefined); m.remove.mockReset().mockResolvedValue(undefined); m.recover.mockReset().mockResolvedValue(undefined); m.receipt.mockReset().mockResolvedValue({ context: "authority", readIds: [] }); m.observe.mockReset().mockResolvedValue(true); m.refresh.mockReset().mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 200, right: 200, width: 200, height: 200, toJSON: () => ({}) });
  m.choose.mockReset(); m.import.mockReset(); m.file.mockReset();
  m.retry.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open() {
  const rendered = render(thread());
  await waitFor(() => expect(screen.queryByText("Opening messages…")).toBeNull());
  return rendered;
}
function thread() { return <MemoryRouter initialEntries={["/connections/chat"]}><Routes><Route path="/connections/:conversationId" element={<MessagingThread />} /></Routes></MemoryRouter>; }
it("offers an accessible photo picker in a connected conversation", async () => {
  await open();
  expect(screen.getByRole("button", { name: /attach photo/i })).toBeTruthy();
});
it("does not offer a photo picker in a request", async () => {
  m.view.mode = "REQUEST"; await open();
  expect(screen.queryByRole("button", { name: /attach photo/i })).toBeNull();
});
it("prepares a selected web photo and allows removing the draft", async () => {
  m.prepare.mockResolvedValue({ bytes: new Uint8Array([1]).buffer, sha256: "a".repeat(64), mime: "image/jpeg", byteSize: 1, width: 1, height: 1 });
  await open();
  fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] } });
  await waitFor(() => expect(screen.getByRole("button", { name: /remove photo/i })).toBeTruthy());
  expect(m.prepare).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /remove photo/i }));
  expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
});
it("keeps the same photo and caption on retry after uncertain admission", async () => {
  m.prepare.mockResolvedValue({ bytes: new Uint8Array([1]).buffer, sha256: "a".repeat(64), mime: "image/jpeg", byteSize: 1, width: 1, height: 1 });
  m.send.mockRejectedValueOnce(new Error("uncertain")).mockResolvedValueOnce("saved");
  await open();
  fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] } });
  await waitFor(() => expect(screen.getByText("Photo ready")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "caption" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(m.send).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(m.send).toHaveBeenCalledTimes(2));
  expect(m.send.mock.calls[1]).toEqual(m.send.mock.calls[0]);
});
it("shows an image-only message as a loading photo until metadata arrives", async () => {
  m.messages = [{ id: "message", conversationId: "chat", authorId: "peer", recipientId: "account", body: "", messageType: "MEDIA", server: { eventId: "event", sequence: 1 } }];
  await open();
  expect(screen.getByText("Photo loading…")).toBeTruthy();
});
it("does not claim a photo was sent while its attachment is uploading", async () => {
  m.messages = [{ id: "message", conversationId: "chat", authorId: "account", recipientId: "peer", body: "caption", messageType: "MEDIA", server: { eventId: "event", sequence: 1 } }];
  m.media = [{ id: "photo", messageId: "message", direction: "OUT", state: "UPLOADING", width: 2, height: 1, mime: "image/jpeg" }];
  await open();
  expect(screen.queryByText("Sent")).toBeNull();
  expect(screen.getByText(/sending/i)).toBeTruthy();
});

it("shows and opens the correlated local photo with an accessible label", async () => {
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:photo"), revokeObjectURL: vi.fn() });
  m.read.mockResolvedValue(new Uint8Array([1]).buffer);
  m.messages = [{ id: "message", conversationId: "chat", authorId: "peer", recipientId: "account", body: "caption", messageType: "MEDIA", server: { eventId: "event", sequence: 1 } }];
  m.media = [{ id: "photo", messageId: "message", direction: "IN", state: "READY", width: 2, height: 1, mime: "image/jpeg", expiresAt: Date.now() + 100000 }];
  await open();
  await waitFor(() => expect(screen.getByRole("button", { name: /view photo/i })).toBeTruthy());
  expect(m.read).toHaveBeenCalledWith("account", "photo");
  fireEvent.click(screen.getByRole("button", { name: /view photo/i }));
  await waitFor(() => expect(screen.getByRole("dialog", { name: /full size photo/i })).toBeTruthy());
  expect(screen.getByText("caption")).toBeTruthy();
});
it("offers Download again when a photo is evicted", async () => {
  m.messages = [{ id: "message", conversationId: "chat", authorId: "peer", recipientId: "account", body: "", messageType: "MEDIA", server: { eventId: "event", sequence: 1 } }];
  m.media = [{ id: "photo", messageId: "message", direction: "IN", state: "EVICTED", width: 2, height: 1, mime: "image/jpeg", expiresAt: Date.now() + 100000 }];
  await open();
  fireEvent.click(screen.getByRole("button", { name: /download again/i }));
  await waitFor(() => expect(m.download).toHaveBeenCalledWith("account", "chat", "photo"));
});
it("allows removing a locally pending photo without unsending", async () => {
  m.messages = [{ id: "message", conversationId: "chat", authorId: "account", recipientId: "peer", body: "", messageType: "MEDIA" }];
  m.media = [{ id: "photo", messageId: "message", direction: "OUT", state: "QUEUED", width: 2, height: 1, mime: "image/jpeg" }];
  await open();
  fireEvent.click(screen.getByRole("button", { name: /remove pending photo/i }));
  await waitFor(() => expect(m.remove).toHaveBeenCalledWith("account", "chat", "message", false));
});
it("shows a prepared draft preview and revokes it when removed", async () => {
  const create = vi.fn(() => "blob:draft"), revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  m.prepare.mockResolvedValue({ bytes: new Uint8Array([1]).buffer, sha256: "a".repeat(64), mime: "image/jpeg", byteSize: 1, width: 2, height: 1 });
  await open();
  fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [new File(["x"], "p.jpg")] } });
  await waitFor(() => expect(screen.getByAltText("Selected photo")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /remove photo/i }));
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:draft"));
});
it("does not allow replacing or silently discarding an uncertain admission", async () => {
  m.prepare.mockResolvedValue({ bytes: new Uint8Array([1]).buffer, sha256: "a".repeat(64), mime: "image/jpeg", byteSize: 1, width: 2, height: 1 });
  m.send.mockRejectedValue(new Error("uncertain"));
  await open();
  fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [new File(["x"], "p.jpg")] } });
  await waitFor(() => expect(screen.getByText("Photo ready")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(m.send).toHaveBeenCalledTimes(1));
  expect((screen.getByRole("button", { name: /attach photo/i }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: /remove photo/i }) as HTMLButtonElement).disabled).toBe(true);
});
it("does not show a deleted photo caption, image or send status", async () => {
  m.messages = [{ id: "message", conversationId: "chat", authorId: "account", recipientId: "peer", body: "old caption", unsentAt: 123, server: { eventId: "event", sequence: 1 } }];
  m.media = [{ id: "photo", messageId: "message", direction: "OUT", state: "READY", width: 2, height: 1, mime: "image/jpeg" }];
  await open();
  expect(screen.getByText("Message unsent")).toBeTruthy();
  expect(screen.queryByText("old caption")).toBeNull();
  expect(screen.queryByText("Sent")).toBeNull();
  expect(m.read).not.toHaveBeenCalled();
});
it("shows unavailable without downloading after known expiry", async () => {
  m.messages = [{ id: "message", conversationId: "chat", authorId: "peer", recipientId: "account", body: "", messageType: "MEDIA", server: { eventId: "event", sequence: 1 } }];
  m.media = [{ id: "photo", messageId: "message", direction: "IN", state: "EVICTED", width: 2, height: 1, mime: "image/jpeg", expiresAt: 1 }];
  await open();
  expect(screen.getByText("Photo unavailable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /download again/i })).toBeNull();
});
it("does not display a photo draft after the connection becomes a request", async () => {
  m.prepare.mockResolvedValue({ bytes: new Uint8Array([1]).buffer, sha256: "a".repeat(64), mime: "image/jpeg", byteSize: 1, width: 2, height: 1 });
  const app = <MemoryRouter initialEntries={["/connections/chat"]}><Routes><Route path="/connections/:conversationId" element={<MessagingThread />} /></Routes></MemoryRouter>;
  const rendered = render(app);
  await waitFor(() => expect(screen.queryByText("Opening messages…")).toBeNull());
  fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [new File(["x"], "p.jpg")] } });
  await waitFor(() => expect(screen.getByAltText("Selected photo")).toBeTruthy());
  m.view.mode = "REQUEST"; rendered.rerender(<MemoryRouter initialEntries={["/connections/chat"]}><Routes><Route path="/connections/:conversationId" element={<MessagingThread />} /></Routes></MemoryRouter>);
  expect(screen.queryByAltText("Selected photo")).toBeNull();
});
it("lets a request-mode user remove a retained photo draft before sending text", async () => {
  m.prepare.mockResolvedValue({ bytes: new ArrayBuffer(1), sha256: "a".repeat(64), mime: "image/jpeg", byteSize: 1, width: 2, height: 1 });
  const rendered = await open();
  fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [new File(["x"], "p.jpg")] } });
  await screen.findByAltText("Selected photo");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello again" } });
  m.view.mode = "REQUEST"; rendered.rerender(thread());
  expect(screen.queryByAltText("Selected photo")).toBeNull();
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false);
  expect(m.send).not.toHaveBeenCalled();
});

const received = (messageType?: string) => ({ id: "message", conversationId: "chat", authorId: "peer", recipientId: "account", body: "Caption", messageType, server: { eventId: "event", sequence: 1 } });
async function settleGeometry() { await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); }
it.each([undefined, "MEDIA"])("never observes a caption as TEXT when classification is %s and metadata is absent", async (type) => {
  m.messages = [received(type)]; await open(); await settleGeometry();
  expect(m.receipt).toHaveBeenCalled(); // Authority lookup ran, geometry did not qualify the caption.
  expect(m.observe).not.toHaveBeenCalled();
  expect(document.querySelector("[data-receipt-message]")).toBeNull();
});
it("observes authoritative TEXT geometry", async () => {
  m.messages = [received("TEXT")]; await open();
  await waitFor(() => expect(m.observe).toHaveBeenCalledWith("account", "chat", "authority", "message", expect.any(AbortSignal)));
});
it("observes MEDIA only after READY bytes have actually loaded, without a scroll", async () => {
  m.messages = [received("MEDIA")]; m.read.mockResolvedValue(new Uint8Array([1]).buffer);
  m.media = [{ id: "photo", messageId: "message", direction: "IN", state: "READY", width: 2, height: 1, mime: "image/jpeg" }];
  await open(); const button = await screen.findByRole("button", { name: "View photo" });
  await settleGeometry(); expect(m.observe).not.toHaveBeenCalled();
  fireEvent.load(button.querySelector("img")!);
  await waitFor(() => expect(m.observe).toHaveBeenCalledWith("account", "chat", "authority", "message", expect.any(AbortSignal)));
});
it("offers honest review instead of Sending or automatic retry for an unknown queued message", async () => {
  m.messages = [{ ...received(), authorId: "account", recipientId: "peer", server: undefined }];
  m.outbox = [{ messageId: "message", status: "NEEDS_REVIEW", attempts: 0 }];
  await open();
  expect(screen.queryByText("Sending…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review message" }));
  expect(m.recover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send text only" }));
  await waitFor(() => expect(m.recover).toHaveBeenCalledWith("account", "chat", "message"));
});
it("lets the user remove an unknown queued message without sending it", async () => {
  m.messages = [{ ...received(), authorId: "account", recipientId: "peer", server: undefined }];
  m.outbox = [{ messageId: "message", status: "NEEDS_REVIEW", attempts: 0 }]; await open();
  fireEvent.click(screen.getByRole("button", { name: "Review message" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete for me" }));
  await waitFor(() => expect(m.remove).toHaveBeenCalledWith("account", "chat", "message", false));
  expect(m.recover).not.toHaveBeenCalled();
});
it("allows retrying a failed photo upload after the text echo already arrived", async () => {
  m.messages = [{ ...received("MEDIA"), authorId: "account", recipientId: "peer" }];
  m.media = [{ id: "photo", messageId: "message", direction: "OUT", state: "FAILED", width: 2, height: 1, mime: "image/jpeg" }];
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(m.refresh).toHaveBeenCalledWith("account"));
  expect(m.send).not.toHaveBeenCalled();
  expect(m.retry).not.toHaveBeenCalled();
});
it("retries the failed message's stable identity only after an explicit click, not a generic sync", async () => {
  m.messages = [{ ...received("TEXT"), authorId: "account", recipientId: "peer", server: undefined }];
  m.outbox = [{ messageId: "message", status: "FAILED", attempts: 2 }];
  await open();
  expect(m.retry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(m.retry).toHaveBeenCalledWith("account", "chat", "message"));
  expect(m.refresh).not.toHaveBeenCalled();
  expect(m.recover).not.toHaveBeenCalled();
  expect(screen.getByText("Caption")).toBeTruthy();
});
it("keeps a refused explicit retry failed and explains the failure without duplicating a send", async () => {
  m.messages = [{ ...received("TEXT"), authorId: "account", recipientId: "peer", server: undefined }];
  m.outbox = [{ messageId: "message", status: "FAILED", attempts: 2 }];
  m.retry.mockRejectedValue(new Error("synthetic boundary refusal"));
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Could not retry. Try syncing again.")).toBeTruthy();
  expect(screen.getByText("Failed —")).toBeTruthy();
  expect(screen.getByText("Caption")).toBeTruthy();
  expect(m.retry).toHaveBeenCalledTimes(1);
  expect(m.send).not.toHaveBeenCalled();
  expect(m.recover).not.toHaveBeenCalled();
});
it.each(["QUEUED", "FAILED"])("does not offer a remote download for an unuploaded %s photo with missing local bytes", async (state) => {
  m.messages = [{ ...received("MEDIA"), authorId: "account", recipientId: "peer", server: undefined }];
  m.media = [{ id: "photo", messageId: "message", direction: "OUT", state, width: 2, height: 1, mime: "image/jpeg" }];
  await open(); await settleGeometry(); expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
});
it("closes an open photo when an unsend arrives in the same thread", async () => {
  m.messages = [received("MEDIA")]; m.read.mockResolvedValue(new Uint8Array([1]).buffer);
  m.media = [{ id: "photo", messageId: "message", direction: "IN", state: "READY", width: 2, height: 1, mime: "image/jpeg" }];
  const rendered = await open(); fireEvent.click(await screen.findByRole("button", { name: "View photo" }));
  expect(screen.getByRole("dialog", { name: "Full size photo" })).toBeTruthy();
  m.messages = [{ ...received("MEDIA"), body: "", unsentAt: 1 }]; m.chat.revision++;
  rendered.rerender(thread());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Full size photo" })).toBeNull());
});
it("can retry preparation after relationship loss aborted a draft", async () => {
  let resolve!: (value: unknown) => void; m.prepare.mockReturnValue(new Promise((done) => { resolve = done; }));
  const rendered = await open();
  fireEvent.change(screen.getByLabelText("Choose photo"), { target: { files: [new File(["x"], "p.jpg")] } });
  expect(screen.getByText("Preparing photo…")).toBeTruthy();
  m.view.mode = "REQUEST"; rendered.rerender(thread());
  await act(async () => { resolve({ bytes: new ArrayBuffer(1), mime: "image/jpeg", width: 2, height: 1 }); });
  m.view.mode = "CONNECTED"; rendered.rerender(thread());
  expect(screen.queryByText("Preparing photo…")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
it("uses the canonical Android URI import before preparing a selected photo", async () => {
  vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  const imported = { uri: "synthetic-import" }, source = new File(["x"], "photo.jpg");
  m.choose.mockResolvedValue(["content://synthetic-photo"]); m.import.mockResolvedValue(imported); m.file.mockReturnValue(source);
  m.prepare.mockResolvedValue({ bytes: new ArrayBuffer(1), sha256: "a".repeat(64), mime: "image/jpeg", byteSize: 1, width: 2, height: 1 });
  await open(); fireEvent.click(screen.getByRole("button", { name: "Attach photo" }));
  await screen.findByAltText("Selected photo");
  expect(m.choose).toHaveBeenCalledWith({ source: "photos", limit: 1 });
  expect(m.import).toHaveBeenCalledWith("content://synthetic-photo", { signal: expect.any(AbortSignal) });
  expect(m.file).toHaveBeenCalledWith(imported);
  expect(m.prepare).toHaveBeenCalledWith(source, { signal: expect.any(AbortSignal) });
});
it("ignores a late local read after leaving the thread without allocating a URL", async () => {
  let resolve!: (bytes: ArrayBuffer) => void; m.read.mockReturnValue(new Promise((done) => { resolve = done; }));
  m.messages = [received("MEDIA")];
  m.media = [{ id: "photo", messageId: "message", direction: "IN", state: "READY", width: 2, height: 1, mime: "image/jpeg" }];
  const rendered = await open(); await waitFor(() => expect(m.read).toHaveBeenCalledTimes(1));
  rendered.unmount(); await act(async () => { resolve(new ArrayBuffer(1)); });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("retains an independent viewer copy when the local thumbnail is evicted and releases every URL on exit", async () => {
  let sequence = 0; vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:owned-${++sequence}`);
  m.messages = [received("MEDIA")]; m.read.mockResolvedValue(new ArrayBuffer(1));
  m.media = [{ id: "photo", messageId: "message", direction: "IN", state: "READY", width: 2, height: 1, mime: "image/jpeg", expiresAt: Date.now() + 100000 }];
  const rendered = await open(); fireEvent.click(await screen.findByRole("button", { name: "View photo" }));
  m.media = [{ ...(m.media[0] as object), state: "EVICTED" }]; m.chat.revision++; rendered.rerender(thread());
  await screen.findByRole("button", { name: "Download again" });
  expect(screen.getByRole("dialog", { name: "Full size photo" })).toBeTruthy();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owned-1");
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:owned-2");
  rendered.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owned-2");
});
it("makes permanent-unavailable downloads opaque while a transient failure stays retryable", async () => {
  m.messages = [received("MEDIA")];
  m.media = [{ id: "photo", messageId: "message", direction: "IN", state: "EVICTED", width: 2, height: 1, mime: "image/jpeg", expiresAt: Date.now() + 100000 }];
  m.download.mockRejectedValueOnce(new Error("synthetic network failure")).mockRejectedValueOnce(new PhotoUnavailableError());
  await open(); fireEvent.click(screen.getByRole("button", { name: "Download again" }));
  await screen.findByText("Could not load photo.");
  fireEvent.click(screen.getByRole("button", { name: "Download again" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Download again" })).toBeNull());
  expect(screen.getByText("Photo unavailable")).toBeTruthy();
  expect(screen.queryByText(/synthetic network/)).toBeNull();
});
