/**
 * Production lane orchestration for the shared push dispatcher.
 *
 * `push-dispatch/index.ts` serves two independent lanes on one invocation: the
 * additive chat wake lane and the legacy report-notification lane. This module is
 * the single seam that runs them, so the isolation contract is executable rather
 * than a convention repeated at the call site:
 *
 * - chat runs first and its failure is contained, reported additively
 *   (`chatError` / `degraded: ["chat"]`) and never becomes the report status;
 * - the report lane always runs, owns the HTTP status, and its failure is never
 *   reported as a chat outcome;
 * - an unexpected throw outside a lane's own error handling still produces a
 *   bounded, redacted, honest 500 instead of an unhandled function error.
 */
import { degradedLanes, isolateLane, type LaneOutcome } from "./laneIsolation.ts";

export interface ChatLaneCounts {
  claimed: number;
  sent: number;
  failed: number;
}

/** A response body plus the HTTP status the owning lane decided. */
export interface LaneResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface DispatchLanesDeps {
  /** Chat wake lane. May throw or never settle; the boundary contains both. */
  dispatchChat: () => Promise<ChatLaneCounts>;
  /**
   * How long the chat lane may hold this invocation before the report lane
   * proceeds without it. A rejected chat lane is already contained, but a chat
   * dependency that never settles (a stalled RPC or FCM socket) would otherwise
   * block report delivery for the whole invocation. Defaults to
   * `CHAT_LANE_DEADLINE_MS`.
   */
  chatDeadlineMs?: number;
  /** Legacy report-notification lane. May throw; the boundary contains it. */
  dispatchReports: () => Promise<LaneResponse>;
  /** Bounded, redacted failure log. A throwing logger is contained too. */
  log?: (message: string) => void;
}

export interface DispatchLanesResult {
  /** HTTP status decided by the report lane (500 when it threw unexpectedly). */
  status: number;
  /** Report-lane body plus the chat lane's additive fields. */
  body: Record<string, unknown>;
  chat: ChatLaneCounts;
  report: LaneOutcome<LaneResponse>;
}

const EMPTY_CHAT: ChatLaneCounts = { claimed: 0, sent: 0, failed: 0 };

/**
 * Chat gets a bounded slice of the invocation, leaving the rest for the report
 * lane that owns the response. 20s is generous for a claim/send/finish cycle and
 * still inside the Edge wall clock.
 */
export const CHAT_LANE_DEADLINE_MS = 20_000;

/**
 * Settle with `run()` or reject once `ms` elapses, whichever happens first.
 *
 * The abandoned promise is not cancelled — the lane may still be mid-flight — so
 * its later rejection is swallowed here. Without that, a timeout would turn into
 * an unhandled rejection after the response had already been sent.
 */
function settleWithin<T>(run: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(label));
    }, ms);
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    let pending: Promise<T>;
    try {
      pending = run();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    // The lane we stopped waiting for may reject long after the response.
    void pending.catch(() => {});
  });
}

/**
 * Run both lanes, chat first, and never let one lane's failure change the
 * other's outcome.
 */
export async function runDispatchLanes(deps: DispatchLanesDeps): Promise<DispatchLanesResult> {
  const deadline = deps.chatDeadlineMs ?? CHAT_LANE_DEADLINE_MS;
  const chatLane = await isolateLane(
    "chat",
    () => settleWithin(deps.dispatchChat, deadline, "chat lane deadline exceeded"),
    deps.log,
  );
  const chat = chatLane.ok ? chatLane.value : { ...EMPTY_CHAT };
  // Chat fields are applied last, so a report body can never overwrite or fake
  // the chat lane's outcome.
  const chatFields = chatLane.ok
    ? { chat }
    : { chat, chatError: chatLane.error, degraded: degradedLanes(["chat", chatLane]) };

  const report = await isolateLane("reports", deps.dispatchReports, deps.log);
  if (!report.ok) {
    return {
      status: 500,
      body: { error: "report dispatch unavailable", scanned: 0, sent: 0, ...chatFields },
      chat,
      report,
    };
  }
  // The report lane must not be able to forge chat fields either; strip its
  // copies before applying the real chat outcome.
  const reportBody = { ...report.value.body };
  delete reportBody.chat;
  delete reportBody.chatError;
  delete reportBody.degraded;
  return {
    status: report.value.status,
    body: { ...reportBody, ...chatFields },
    chat,
    report,
  };
}
