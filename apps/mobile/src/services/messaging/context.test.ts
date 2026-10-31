// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { openWebMessagingHistory } from "./indexedDbHistory";
import type { HumanMessage, MailboxEnvelope, MessagingHistory } from "./history";
import { createMessagingSession, type MessagingRpc } from "./session";
import { copyContextMessage, copyLocationMessage, copyMessage, copyReceivedMessage } from "./validation";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const DEVICE = "00000000-0000-4000-8000-000000000003";
const ID = "00000000-0000-4000-8000-000000000004";
const CONV = "00000000-0000-4000-8000-000000000005";
const MAIL = "00000000-0000-4000-8000-000000000006";
const REPORT = "00000000-0000-4000-8000-000000000007";
const scope = { accountId: A, deviceId: DEVICE };
const handles: MessagingHistory[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); });

function location(lat = 23.8103, lng = 90.4125, accuracy = 25) {
  return { lat, lng, accuracy };
}

describe("report context and static location admission", () => {
  it("keeps a report reference on a text message only", () => {
    const message = copyContextMessage({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "Is this yours?", contextReportId: REPORT,
    });
    expect(message.messageType).toBe("TEXT");
    expect(message.contextReportId).toBe(REPORT);
    expect(() => copyContextMessage({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "caption", contextReportId: REPORT,
      messageType: "MEDIA",
    })).toThrow();
    // Plain text admission never smuggles a context through.
    expect(() => copyMessage({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "hello", contextReportId: REPORT,
    })).toThrow();
  });

  it("requires one bounded coordinate set on a location message", () => {
    const message = copyLocationMessage({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "", messageType: "LOCATION",
      location: location(),
    });
    expect(message.messageType).toBe("LOCATION");
    expect(message.location).toEqual(location());
    expect(() => copyLocationMessage({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "", messageType: "LOCATION",
      location: location(91, 0, 10),
    })).toThrow();
    expect(() => copyLocationMessage({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "", messageType: "LOCATION",
      location: location(10, 0, 0),
    })).toThrow();
    expect(() => copyLocationMessage({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "", messageType: "LOCATION",
    })).toThrow();
    // A location cannot ride on a plain text send, and text cannot ride on one.
    expect(() => copyMessage({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "hi", location: location(),
    })).toThrow();
  });

  it("reads an authorized envelope without inventing a classification", () => {
    const received = copyReceivedMessage({
      id: ID, conversationId: CONV, authorId: B, recipientId: A, body: "", messageType: "LOCATION",
      location: location(),
    });
    expect(received.location).toEqual(location());
    const legacy = copyReceivedMessage({ id: ID, conversationId: CONV, authorId: B, recipientId: A, body: "old" });
    expect(legacy.messageType).toBeUndefined();
    expect(legacy.location).toBeUndefined();
    expect(legacy.contextReportId).toBeUndefined();
  });
});

function serverFor(history: MessagingHistory) {
  const sends: Array<Record<string, unknown>> = [];
  let envelope: MailboxEnvelope | null = null;
  const rpc: MessagingRpc = async (input) => {
    if (input.action === "SEND") {
      sends.push(input.args as Record<string, unknown>);
      const args = input.args as Record<string, unknown>;
      envelope = {
        ...scope, mailboxId: MAIL,
        event: {
          kind: "TEXT", eventId: args.messageId as string, sequence: 1,
          message: {
            id: args.messageId as string, conversationId: CONV, authorId: A, recipientId: B,
            body: args.body as string, messageType: (args.messageType as HumanMessage["messageType"]) ?? "TEXT",
            ...(args.contextReportId ? { contextReportId: args.contextReportId as string } : {}),
            ...(args.location ? { location: args.location as HumanMessage["location"] } : {}),
          },
        },
      };
      return args.messageId as string;
    }
    if (input.action === "SYNC") return envelope ? [envelope] : [];
    if (input.action === "STATE_SYNC") return [];
    if (input.action === "ACK") {
      // A fake server may discard only after the real local store is readable.
      expect((await history.getMessage(ID))?.server?.eventId).toBe(ID);
      envelope = null;
      return null;
    }
    if (input.action === "CREATE") return CONV;
    return null;
  };
  return { rpc, sends };
}

async function setup() {
  const factory = new IDBFactory();
  const history = await openWebMessagingHistory(scope, { indexedDB: factory });
  handles.push(history);
  const server = serverFor(history);
  return { history, sends: server.sends, session: createMessagingSession(scope, history, server.rpc) };
}

describe("human messaging session keeps the captured payload", () => {
  it("sends the report reference and persists it from the authoritative echo", async () => {
    const f = await setup();
    await f.session.start("web");
    expect(await f.session.request(B)).toBe(CONV);
    await f.session.send({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "Is this yours?",
      contextReportId: REPORT,
    });
    await f.session.flush();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]!.contextReportId).toBe(REPORT);
    // TEXT stays the default classification on the wire.
    expect(f.sends[0]!.messageType).toBeUndefined();
    const stored = await f.history.getMessage(ID);
    expect(stored?.contextReportId).toBe(REPORT);
    expect(stored?.messageType).toBe("TEXT");
  });

  it("sends a location as its own type with no caption and no report", async () => {
    const f = await setup();
    await f.session.start("web");
    expect(await f.session.request(B)).toBe(CONV);
    await f.session.send({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "",
      messageType: "LOCATION", location: location(),
    });
    await f.session.flush();
    expect(f.sends[0]!.messageType).toBe("LOCATION");
    expect(f.sends[0]!.location).toEqual(location());
    expect(f.sends[0]!.contextReportId).toBeUndefined();
    const stored = await f.history.getMessage(ID);
    expect(stored?.messageType).toBe("LOCATION");
    expect(stored?.location).toEqual(location());
  });

  it("refuses to enqueue a plain text send that carries another capability", async () => {
    const f = await setup();
    await f.session.start("web");
    expect(await f.session.request(B)).toBe(CONV);
    await expect(f.session.send({
      id: ID, conversationId: CONV, authorId: A, recipientId: B, body: "", messageType: "LOCATION",
    })).rejects.toThrow();
    expect(await f.history.listOutbox()).toHaveLength(0);
  });
});
