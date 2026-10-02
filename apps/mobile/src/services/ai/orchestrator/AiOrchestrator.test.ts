import { describe, expect, it } from "vitest";
import { AiOrchestrator } from "./AiOrchestrator";

const SIGNED_IN = { accountId: "user-123", canProposeComments: true } as const;

describe("AiOrchestrator", () => {
  it("allows an allowlisted proposal and passes the traceId through", () => {
    const orchestrator = new AiOrchestrator();
    const decision = orchestrator.propose({
      modelOutput: { op: "answer_help", args: { question: "How do I report a lost item?" } },
      modelId: "qwen3-0.6b-dynamic-int4",
      traceId: "trace-orch-allow-001",
      permissions: { ...SIGNED_IN },
    });
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") {
      expect(decision.proposal.op).toBe("answer_help");
      expect(decision.proposal.modelId).toBe("qwen3-0.6b-dynamic-int4");
      expect(decision.proposal.traceId).toBe("trace-orch-allow-001");
    }
  });

  it("denies a destructive proposal (publish) via the gate", () => {
    const orchestrator = new AiOrchestrator();
    const decision = orchestrator.propose({
      modelOutput: { op: "publish_report", args: { reportId: "r-1" } },
      modelId: "qwen3-0.6b-dynamic-int4",
      traceId: "trace-orch-destructive-001",
      permissions: { ...SIGNED_IN },
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.code).toBe("DESTRUCTIVE_OP");
      expect(decision.traceId).toBe("trace-orch-destructive-001");
    }
  });

  it("denies an unknown op via the gate", () => {
    const orchestrator = new AiOrchestrator();
    const decision = orchestrator.propose({
      modelOutput: { op: "teleport", args: {} },
      modelId: "qwen3-0.6b-dynamic-int4",
      traceId: "trace-orch-unknown-001",
      permissions: { ...SIGNED_IN },
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.code).toBe("UNKNOWN_OP");
  });

  it("passes the traceId through on both allow and deny", () => {
    const orchestrator = new AiOrchestrator();
    const allowed = orchestrator.propose({
      modelOutput: { op: "open_my_reports", args: {} },
      modelId: "model-a",
      traceId: "trace-orch-pass-allow",
      permissions: { ...SIGNED_IN },
    });
    const denied = orchestrator.propose({
      modelOutput: { op: "call_tool", args: { tool: "shell" } },
      modelId: "model-a",
      traceId: "trace-orch-pass-deny",
      permissions: { ...SIGNED_IN },
    });
    if (allowed.decision === "allow") expect(allowed.proposal.traceId).toBe("trace-orch-pass-allow");
    else expect.unreachable("expected allow");
    if (denied.decision === "deny") expect(denied.traceId).toBe("trace-orch-pass-deny");
    else expect.unreachable("expected deny");
  });
});
