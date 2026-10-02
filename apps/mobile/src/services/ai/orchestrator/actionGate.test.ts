import { describe, expect, it } from "vitest";
import { evaluateProposal, type GateContext } from "./actionGate";

const SIGNED_IN: GateContext = {
  modelId: "qwen3-0.6b-dynamic-int4",
  traceId: "trace-allow-001",
  permissions: { accountId: "user-123", canProposeComments: true },
};

const SIGNED_OUT: GateContext = {
  modelId: "qwen3-0.6b-dynamic-int4",
  traceId: "trace-signed-out-001",
  permissions: { accountId: null, canProposeComments: false },
};

describe("actionGate", () => {
  it("allows an allowlisted op with valid args", () => {
    const decision = evaluateProposal({ op: "open_my_reports", args: {} }, SIGNED_IN);
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") {
      expect(decision.proposal.op).toBe("open_my_reports");
      expect(decision.proposal.modelId).toBe("qwen3-0.6b-dynamic-int4");
      expect(decision.proposal.traceId).toBe("trace-allow-001");
    }
  });

  it("allows fill_report_fields with valid slots", () => {
    const decision = evaluateProposal(
      { op: "fill_report_fields", args: { title: "Black umbrella", locationNote: "central market" } },
      SIGNED_IN,
    );
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") {
      expect(decision.proposal.op).toBe("fill_report_fields");
      expect(decision.proposal.traceId).toBe("trace-allow-001");
    }
  });

  it("denies a destructive op (publish) and never allows it through", () => {
    const decision = evaluateProposal(
      { op: "publish_report", args: { reportId: "r-1" } },
      { ...SIGNED_IN, traceId: "trace-deny-destructive-001" },
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.code).toBe("DESTRUCTIVE_OP");
      expect(decision.traceId).toBe("trace-deny-destructive-001");
    }
  });

  it("denies an unknown op", () => {
    const decision = evaluateProposal(
      { op: "frobnicate", args: {} },
      { ...SIGNED_IN, traceId: "trace-deny-unknown-001" },
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.code).toBe("UNKNOWN_OP");
      expect(decision.traceId).toBe("trace-deny-unknown-001");
    }
  });

  it("denies allowlisted ops with invalid args (coordinates are never accepted)", () => {
    const decision = evaluateProposal(
      { op: "fill_report_fields", args: { title: "Keys", locationNote: "12.3456, 65.4321" } },
      SIGNED_IN,
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.code).toBe("INVALID_ARGS");
  });

  it("denies propose_comment without comment permission", () => {
    const decision = evaluateProposal(
      { op: "propose_comment", args: { reportId: "r-1", body: "Is this yours?" } },
      SIGNED_OUT,
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.code).toBe("PERMISSION_DENIED");
      expect(decision.traceId).toBe("trace-signed-out-001");
    }
  });

  it("passes traceId through on deny decisions", () => {
    const decision = evaluateProposal(
      { op: "navigate", args: { route: "/feed" } },
      { ...SIGNED_IN, traceId: "trace-passthrough-999" },
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.traceId).toBe("trace-passthrough-999");
  });
});
