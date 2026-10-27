// @vitest-environment node
/**
 * R3 chat relationship/safety policy (04_CHAT_SYNC_BACKUP_DESIGN_R3.md §2,3,11).
 * This module is pure policy: no storage, transport, UI or server call.
 */
import { describe, expect, it } from "vitest";
import {
  applyApproach,
  applyEnd,
  applyRecipientAction,
  applySend,
  containsLink,
  initiatorProjection,
  outgoingStatus,
  receiptEligible,
  recipientProjection,
  senderVisibleSend,
  senderVisibleState,
  type PairState,
} from "./policy";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const STRANGER = "00000000-0000-4000-8000-000000000003";

function state(patch: Partial<PairState> = {}): PairState {
  return {
    participants: [A, B],
    mode: "REQUEST",
    initiatorId: A,
    blockedBy: [],
    hiddenBy: [],
    declinedBy: [],
    requestMessageCount: 1,
    nudged: true,
    ...patch,
  };
}

const connected = state({ mode: "CONNECTED", initiatorId: null });
const request = state();
const fresh = state({ initiatorId: null, requestMessageCount: 0, nudged: false });

const text = { body: "Hello, I think we matched on the blue bicycle." };

/**
 * The module's own sender-visible projection. Using it here (rather than a local
 * field-picking helper) is the point: if the trusted fields ever leak into the
 * projection, these comparisons see it.
 */
const visible = senderVisibleSend;

describe("request stage allows multiple text-only messages", () => {
  it("lets the initiator send more than one request-stage message", () => {
    const first = applySend(fresh, A, text);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applySend(first.state, A, { body: "I can collect it on Saturday." });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.requestMessageCount).toBe(2);
    expect(second.state.mode).toBe("REQUEST");
  });

  it("does not let the recipient send before accepting", () => {
    expect(applySend(request, B, text)).toEqual({ ok: false, reason: "REJECTED" });
  });

  it("rejects media, location and links before acceptance", () => {
    for (const draft of [
      { body: "photo", mediaCount: 1 },
      { body: "here", locationShared: true },
      { body: "see https://example.com/find" },
      { body: "see hxxp://example.com/find" },
      { body: "see www.example.com" },
      { body: "see example.com/find" },
      { body: "mail me at user@example.com" },
      { body: "例子.com" },
      { body: "xn--bcher-kva.de" },
    ]) {
      expect(applySend(request, A, draft)).toEqual({ ok: false, reason: "REJECTED" });
    }
  });

  it("keeps non-clickable textual references as text and never linkifies them", () => {
    for (const body of ["example[.]com", "www . example . com", "example.xn--fiqs8s"]) {
      const result = applySend(request, A, { body });
      expect(result.ok && result.linkify).toBe(false);
    }
  });

  it("rejects an empty or whitespace-only body", () => {
    for (const body of ["", "   ", "\n\t "]) {
      expect(applySend(request, A, { body })).toEqual({ ok: false, reason: "REJECTED" });
    }
  });

  it("trims surrounding whitespace and keeps inner text intact", () => {
    const result = applySend(request, A, { body: "  hi  there  " });
    expect(result.ok && result.body).toBe("hi  there");
  });

  it("rejects a non-participant without disclosing why", () => {
    expect(applySend(request, STRANGER, text)).toEqual({ ok: false, reason: "REJECTED" });
    expect(applyApproach(request, STRANGER)).toEqual({ ok: false, reason: "REJECTED" });
  });

  it("does not mutate or alias the input state", () => {
    applySend(request, A, text);
    expect(request.requestMessageCount).toBe(1);
    expect(request.nudged).toBe(true);
  });

  it("returns a snapshot that survives mutation of the caller's arrays", () => {
    const participants: [string, string] = [A, B];
    const hiddenBy = [B];
    const mutable = state({ participants, hiddenBy });
    const result = applySend(mutable, A, { body: "hello" });
    if (!result.ok) throw new Error("send failed");

    participants[0] = STRANGER;
    hiddenBy.push(STRANGER);

    expect(result.state.participants).toEqual([A, B]);
    expect(result.state.hiddenBy).toEqual([B]);
    expect(result.state.participants.includes(STRANGER)).toBe(false);
  });
});

describe("quiet first-approach nudge", () => {
  it("nudges only on the first approach message", () => {
    const first = applySend(fresh, A, text);
    expect(first.ok && first.nudge).toBe(true);
    if (!first.ok) return;
    const second = applySend(first.state, A, { body: "Also, it has a red basket." });
    expect(second.ok && second.nudge).toBe(false);
    if (!second.ok) return;
    const third = applySend(second.state, A, { body: "Third message." });
    expect(third.ok && third.nudge).toBe(false);
  });

  it("never nudges inside an accepted chat", () => {
    const result = applySend(connected, A, text);
    expect(result.ok && result.nudge).toBe(false);
  });

  it("treats the first message after End as a new approach and nudges once", () => {
    const ended = applyEnd(connected, B);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    const approach = applySend(ended.state, B, text);
    expect(approach.ok && approach.nudge).toBe(true);
  });
});

describe("accept / decline / hide / report / block are distinct", () => {
  it("accepts only from the recipient of an active request", () => {
    const accepted = applyRecipientAction(request, B, "ACCEPT");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.applied).toBe(true);
    expect(accepted.state.mode).toBe("CONNECTED");
    expect(accepted.state.initiatorId).toBeNull();
    expect(applyRecipientAction(request, A, "ACCEPT")).toEqual({ ok: false, reason: "REJECTED" });
    expect(applyRecipientAction(connected, B, "ACCEPT")).toEqual({ ok: false, reason: "REJECTED" });
  });

  it("cannot self-accept or accept after End, but a recipient can reconsider decline", () => {
    const ended = applyEnd(connected, B);
    if (!ended.ok) throw new Error("end failed");
    expect(applyRecipientAction(ended.state, A, "ACCEPT")).toEqual({ ok: false, reason: "REJECTED" });
    expect(applyRecipientAction(ended.state, B, "ACCEPT")).toEqual({ ok: false, reason: "REJECTED" });

    const declined = applyRecipientAction(request, B, "DECLINE");
    if (!declined.ok) throw new Error("decline failed");
    expect(applyRecipientAction(declined.state, A, "ACCEPT")).toEqual({ ok: false, reason: "REJECTED" });
    const reconsidered = applyRecipientAction(declined.state, B, "ACCEPT");
    expect(reconsidered.ok && reconsidered.state.mode).toBe("CONNECTED");

    expect(applyRecipientAction(fresh, B, "ACCEPT")).toEqual({ ok: false, reason: "REJECTED" });
  });

  it("keeps block a separate hard boundary and preserves every participant's own choice", () => {
    const first = applyRecipientAction(connected, B, "BLOCK");
    if (!first.ok) throw new Error("block failed");
    expect(first.state.mode).toBe("CONNECTED");
    expect(first.state.blockedBy).toEqual([B]);

    const second = applyRecipientAction(first.state, A, "BLOCK");
    if (!second.ok) throw new Error("second block failed");
    expect(second.state.blockedBy).toEqual([B, A]);
    expect(recipientProjection(second.state, B).blocked).toBe(true);
    expect(recipientProjection(second.state, A).blocked).toBe(true);

    const send = applySend(second.state, A, text);
    expect(send.ok && send.delivery).toBe("WITHHOLD");
  });

  it("withholds delivery from a blocked pair without changing the sender-visible result", () => {
    const blocked = applyRecipientAction(request, B, "BLOCK");
    if (!blocked.ok) throw new Error("block failed");
    const allowed = applySend(request, A, { body: "follow up" });
    const withheld = applySend(blocked.state, A, { body: "follow up" });
    expect(withheld.ok && withheld.delivery).toBe("WITHHOLD");
    expect(allowed.ok && allowed.delivery).toBe("DELIVER");
    expect(visible(withheld)).toEqual(visible(allowed));
  });

  it("gives the initiator no oracle across decline, hide, report and block", () => {
    const transcripts = (["DECLINE", "HIDE", "REPORT", "BLOCK"] as const).map((action) => {
      const result = applyRecipientAction(request, B, action);
      if (!result.ok) throw new Error(`${action} failed`);
      const approach = applyApproach(result.state, A);
      const first = approach.ok ? applySend(approach.state, A, { body: "Any update?" }) : approach;
      const second = first.ok ? applySend(first.state, A, { body: "Still there?" }) : first;
      const third = second.ok ? applySend(second.state, A, { body: "Third note." }) : second;
      return JSON.stringify({
        // Every sender-observable surface, including the ones r1's test skipped:
        // the transition projection, the whole send projection (not just `.ok`),
        // a same-actor ACCEPT attempt, an End attempt, and the receipt view.
        projection: initiatorProjection(result.state, A),
        approach: senderVisibleState(approach),
        acceptByInitiator: senderVisibleState(applyRecipientAction(result.state, A, "ACCEPT")),
        endByInitiator: senderVisibleState(applyEnd(result.state, A)),
        first: visible(first),
        second: visible(second),
        third: visible(third),
        receipts: outgoingStatus(result.state, { delivery: "SENT", readByRecipient: true }, {
          senderEnabled: true,
          recipientEnabled: true,
        }),
      });
    });
    expect(new Set(transcripts).size).toBe(1);
  });

  it("keeps the trusted fields out of the sender-visible projection", () => {
    const blocked = applyRecipientAction(request, B, "BLOCK");
    if (!blocked.ok) throw new Error("block failed");
    const result = applySend(blocked.state, A, text);
    if (!result.ok) throw new Error("send failed");

    const projected = senderVisibleSend(result);
    expect(Object.keys(projected).sort()).toEqual(["body", "linkify", "mediaAllowed", "nudge", "ok"]);
    expect(projected).not.toHaveProperty("state");
    expect(projected).not.toHaveProperty("delivery");
    expect(JSON.stringify(projected)).not.toContain(B);
    expect(JSON.stringify(projected)).not.toContain("WITHHOLD");
    // The raw result still carries the trusted data the transport needs.
    expect(result.delivery).toBe("WITHHOLD");
    expect(result.state.blockedBy).toEqual([B]);
    // A rejected transition projects to the same opaque failure.
    expect(senderVisibleState(applyEnd(request, A))).toEqual({ ok: false, reason: "REJECTED" });
  });

  it("withholds acceptance when either participant has blocked", () => {
    const blocked = applyRecipientAction(request, A, "BLOCK");
    if (!blocked.ok) throw new Error("block failed");
    const accepted = applyRecipientAction(blocked.state, B, "ACCEPT");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.applied).toBe(false);
    expect(accepted.state.mode).toBe("REQUEST");
  });

  it("does not let one participant's block change the other's own controls", () => {
    const blockedByInitiator = applyRecipientAction(request, A, "BLOCK");
    if (!blockedByInitiator.ok) throw new Error("block failed");
    const view = recipientProjection(blockedByInitiator.state, B);
    expect(view.blocked).toBe(false);
    expect(view.canRespond).toBe(true);
  });

  it("shows the recipient their own action without leaking it to the initiator", () => {
    const hidden = applyRecipientAction(request, B, "HIDE");
    if (!hidden.ok) throw new Error("hide failed");
    expect(recipientProjection(hidden.state, B).hidden).toBe(true);
    expect(recipientProjection(hidden.state, A).hidden).toBe(false);
    expect(initiatorProjection(hidden.state, A).composerAvailable).toBe(true);
  });

  it("keeps history and the pair usable after decline", () => {
    const declined = applyRecipientAction(request, B, "DECLINE");
    if (!declined.ok) throw new Error("decline failed");
    expect(declined.state.mode).toBe("REQUEST");
    expect(declined.state.initiatorId).toBe(A);
    expect(declined.state.declinedBy).toEqual([B]);
    expect(applyApproach(declined.state, A).ok).toBe(true);
  });

  it.each([true, false])("keeps hide and decline independent (hide first: %s)", (hideFirst) => {
    const first = applyRecipientAction(request, B, hideFirst ? "HIDE" : "DECLINE");
    if (!first.ok) throw new Error("first private action failed");
    const second = applyRecipientAction(first.state, B, hideFirst ? "DECLINE" : "HIDE");
    if (!second.ok) throw new Error("second private action failed");
    expect(second.state.hiddenBy).toEqual([B]);
    expect(second.state.declinedBy).toEqual([B]);
    const unhidden = applyRecipientAction(second.state, B, "UNHIDE");
    if (!unhidden.ok) throw new Error("unhide failed");
    expect(unhidden.state.hiddenBy).toEqual([]);
    expect(unhidden.state.declinedBy).toEqual([B]);
    expect(unhidden.state.initiatorId).toBe(A);
  });

  it("does not accept a reported request as if it were untouched", () => {
    const reported = applyRecipientAction(request, B, "REPORT");
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.state.mode).toBe("REQUEST");
  });
});

describe("end connection", () => {
  it("returns to REQUEST, keeps history and lets either participant approach", () => {
    const ended = applyEnd(connected, A);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    expect(ended.state.mode).toBe("REQUEST");
    expect(ended.state.initiatorId).toBeNull();
    expect(ended.historyRetained).toBe(true);
    expect(applyApproach(ended.state, A).ok).toBe(true);
    expect(applyApproach(ended.state, B).ok).toBe(true);
  });

  it("rejects ending a request that was never accepted", () => {
    expect(applyEnd(request, A)).toEqual({ ok: false, reason: "REJECTED" });
  });

  it("rejects end and accept from a non-participant", () => {
    expect(applyEnd(connected, STRANGER)).toEqual({ ok: false, reason: "REJECTED" });
    expect(applyRecipientAction(request, STRANGER, "DECLINE")).toEqual({ ok: false, reason: "REJECTED" });
  });
});

describe("composer and read receipts", () => {
  const both = { senderEnabled: true, recipientEnabled: true };

  it("reports an attribute-blind composer that matches actual send permission", () => {
    const accepted = applyRecipientAction(request, B, "ACCEPT");
    if (!accepted.ok) throw new Error("accept failed");
    expect(initiatorProjection(accepted.state, A).composerAvailable).toBe(true);
    expect(applySend(accepted.state, A, text).ok).toBe(true);
    expect(initiatorProjection(request, A).composerAvailable).toBe(true);
  });

  it("never exposes Read in REQUEST even if the recipient read it", () => {
    expect(outgoingStatus(request, { delivery: "SENT", readByRecipient: true }, both)).toBe("SENT");
    expect(receiptEligible(request, both)).toBe(false);
  });

  it("exposes Read only when both enabled and the recipient read it", () => {
    expect(receiptEligible(connected, both)).toBe(true);
    expect(outgoingStatus(connected, { delivery: "SENT", readByRecipient: true }, both)).toBe("READ");
    expect(outgoingStatus(connected, { delivery: "SENT", readByRecipient: false }, both)).toBe("SENT");
  });

  it("degrades to Sent when either participant disabled receipts", () => {
    for (const receipts of [
      { senderEnabled: false, recipientEnabled: true },
      { senderEnabled: true, recipientEnabled: false },
    ]) {
      expect(receiptEligible(connected, receipts)).toBe(false);
      expect(outgoingStatus(connected, { delivery: "SENT", readByRecipient: true }, receipts)).toBe("SENT");
    }
  });

  it("keeps local failure and in-flight state authoritative over read state", () => {
    expect(outgoingStatus(connected, { delivery: "FAILED", readByRecipient: true }, both)).toBe("FAILED");
    expect(outgoingStatus(connected, { delivery: "SENDING", readByRecipient: true }, both)).toBe("SENDING");
  });
});

describe("link gate cost stays bounded", () => {
  /**
   * Shapes that make a backtracking strip quadratic. The r1/r2 scanner handled
   * dotted labels and plain letters, but a long trailing-punctuation run followed
   * by an ordinary character cost ~6.8 s at the bound. Every shape here is a
   * single token, so the whole body goes through the token scanner.
   */
  const shapes: Array<[string, string]> = [
    ["dotted labels", `${"a.".repeat(45_000)}invalidtld`],
    ["plain letters", "a".repeat(90_000)],
    ["closing parens then a letter", `${")".repeat(99_999)}a`],
    ["mixed punctuation then a letter", `${"),.;:!?'\"".repeat(9_000)}x`],
    ["dots then a letter", `${".".repeat(99_999)}a`],
    ["closing brackets then a letter", `${"]}".repeat(49_999)}x`],
  ];

  it("accepts every pathological non-link shape within the bound", () => {
    for (const [label, body] of shapes) {
      const started = performance.now();
      const result = applySend(request, A, { body });
      const elapsed = performance.now() - started;
      expect(result.ok, label).toBe(true);
      expect(elapsed, label).toBeLessThan(250);
    }
  });

  it("scales linearly: 4x the input stays far below quadratic growth", () => {
    const sample = (units: number) => {
      const body = `${")".repeat(units)}a`;
      const started = performance.now();
      containsLink(body);
      return performance.now() - started;
    };
    sample(5_000);
    const small = Math.max(sample(25_000), 0.5);
    const large = sample(100_000);
    // Linear is ~4x for 4x input; the quadratic strip measured ~16x.
    expect(large).toBeLessThan(small * 8 + 10);
  });
});
