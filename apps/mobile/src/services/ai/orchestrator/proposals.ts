/**
 * WS1 typed-proposal contract: the only actions a model may propose.
 *
 * A `Proposal` is data, never an effect: the orchestrator routes raw model
 * output through `actionGate.evaluateProposal` before anything acts on it.
 * The allowlist below is the full set of proposable ops. Destructive
 * operations (publish, edit, status changes, direct-db writes, tool calls,
 * navigation) are NEVER proposable — the gate denies them closed.
 */
import type { ReportSlotFields } from "../types";

/**
 * Allowlisted proposal ops. Anything outside this list is denied by the
 * gate (`UNKNOWN_OP`, or `DESTRUCTIVE_OP` for known-destructive stems).
 */
export const PROPOSAL_OPS = [
  "open_my_reports",
  "fill_report_fields",
  "propose_comment",
  "analyze_photo",
  "answer_help",
] as const;
export type ProposalOp = (typeof PROPOSAL_OPS)[number];

export function isProposalOp(value: unknown): value is ProposalOp {
  return typeof value === "string" && (PROPOSAL_OPS as readonly string[]).includes(value);
}

/** Args for `open_my_reports`: no payload, just the navigation intent. */
export type OpenMyReportsArgs = Record<string, never>;

/** Args for `fill_report_fields`: draft slots only, never coordinates. */
export type FillReportFieldsArgs = ReportSlotFields;

/** Args for `propose_comment`: a draft comment on one report. */
export interface ProposeCommentArgs {
  readonly reportId: string;
  readonly body: string;
}

/** Args for `analyze_photo`: an id reference, never image bytes. */
export interface AnalyzePhotoArgs {
  readonly imageId: string;
  readonly userContext?: string;
}

/** Args for `answer_help`: the help question to answer. */
export interface AnswerHelpArgs {
  readonly question: string;
}

export type ProposalArgs =
  | OpenMyReportsArgs
  | FillReportFieldsArgs
  | ProposeCommentArgs
  | AnalyzePhotoArgs
  | AnswerHelpArgs;

/**
 * A validated model proposal. `modelId` records which model produced it;
 * `traceId` correlates the proposal with its gate decision end to end.
 */
export interface Proposal {
  readonly op: ProposalOp;
  readonly args: ProposalArgs;
  readonly modelId: string;
  readonly traceId: string;
}
