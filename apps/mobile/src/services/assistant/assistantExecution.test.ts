import { describe, expect, it } from "vitest";
import { stubGenerate, mustProfile } from "../ai/ops/testSupport";
import { RECOVERY_COPY } from "../ai/errors";
import { DEFAULT_CLARIFICATION_QUESTIONS } from "../ai/clarificationCopy";
import {
  choosePhoto,
  failWith,
  startFlow,
} from "./guidedAssistantController";
import {
  executeAssistantMessage,
  groundedHelpAnswer,
  guessIntentLocal,
  type AssistantExecutionRuntime,
} from "./assistantExecution";

const profile = mustProfile("smolvlm2-500m-text");

function modelRuntime(texts: string | readonly string[]): {
  runtime: AssistantExecutionRuntime;
  generate: ReturnType<typeof stubGenerate>;
} {
  const generate = stubGenerate(texts);
  return { runtime: { generate, profile }, generate };
}

function localRuntime(
  answerAppQuestion?: AssistantExecutionRuntime["answerAppQuestion"],
): AssistantExecutionRuntime {
  return answerAppQuestion === undefined ? {} : { answerAppQuestion };
}

describe("guessIntentLocal", () => {
  it("keeps app questions out of report flows", () => {
    expect(guessIntentLocal("How do I report a lost item?")).toBe("APP_QUESTION");
  });
  it("routes lost wording to REPORT_LOST", () => {
    expect(guessIntentLocal("I lost my keys")).toBe("REPORT_LOST");
  });
  it("routes found wording to REPORT_FOUND", () => {
    expect(guessIntentLocal("I found a wallet")).toBe("REPORT_FOUND");
  });
  it("routes search verbs to SEARCH", () => {
    expect(guessIntentLocal("looking for a black umbrella")).toBe("SEARCH");
  });
  it("defaults plain statements to SEARCH", () => {
    expect(guessIntentLocal("black umbrella")).toBe("SEARCH");
  });
  it("routes greetings to OPEN_QUESTION", () => {
    expect(guessIntentLocal("hello")).toBe("OPEN_QUESTION");
  });
  it("routes degenerate input to UNKNOWN", () => {
    expect(guessIntentLocal("??")).toBe("UNKNOWN");
  });
});

describe("executeAssistantMessage with a model", () => {
  it("routes REPORT_LOST through slot extraction into the controller", async () => {
    const { runtime } = modelRuntime([
      '{"intent":"REPORT_LOST"}',
      '{"title":"Keys","category":"Keys","dateText":"2026-09-01","locationNote":"Library"}',
    ]);
    const result = await executeAssistantMessage(null, "I lost my keys at the library", runtime);
    expect(result.snapshot.flow).toBe("lost");
    expect(result.snapshot.patch.title).toBe("Keys");
    expect(result.snapshot.patch.category).toBe("Keys");
    expect(result.snapshot.state).toBe("awaitingPhoto");
    expect(result.reply).toBe(DEFAULT_CLARIFICATION_QUESTIONS.photo);
    expect(result.replySource).toBe("model");
    expect(result.reviewHeld).toBe(false);
  });

  it("routes SEARCH to a held ready state", async () => {
    const { runtime } = modelRuntime(['{"intent":"SEARCH"}', '{"query":"umbrella"}']);
    const result = await executeAssistantMessage(null, "black umbrella", runtime);
    expect(result.snapshot.flow).toBe("search");
    expect(result.snapshot.state).toBe("ready");
    expect(result.snapshot.searchFilters?.query).toBe("umbrella");
    expect(result.reply).toContain("umbrella");
    expect(result.replySource).toBe("model");
  });

  it("answers APP_QUESTION with the help op", async () => {
    const { runtime } = modelRuntime([
      '{"intent":"APP_QUESTION"}',
      "Use the Report tab and choose Lost or Found.",
    ]);
    const result = await executeAssistantMessage(null, "How do I report a lost item?", runtime);
    expect(result.snapshot.flow).toBe("ask");
    expect(result.reply).toContain("Report tab");
    expect(result.replySource).toBe("model");
  });

  it("answers OPEN_QUESTION with the help op", async () => {
    const { runtime } = modelRuntime([
      '{"intent":"OPEN_QUESTION"}',
      "FindBack helps you reunite lost items with owners.",
    ]);
    const result = await executeAssistantMessage(null, "What is FindBack?", runtime);
    expect(result.reply).toContain("FindBack");
    expect(result.replySource).toBe("model");
  });

  it("clarifies UNKNOWN without calling another op", async () => {
    const { runtime, generate } = modelRuntime(['{"intent":"UNKNOWN"}']);
    const result = await executeAssistantMessage(null, "??", runtime);
    expect(result.reply).toContain("couldn't tell");
    expect(result.replySource).toBe("grounded");
    expect(generate.calls).toBe(1);
  });

  it("sends guard loops to recovery with frozen copy", async () => {
    const loop = "The item is here. The item is here. The item is here.";
    const { runtime, generate } = modelRuntime([loop]);
    const result = await executeAssistantMessage(null, "I lost my keys", runtime);
    expect(result.snapshot.state).toBe("recovering");
    expect(result.reply).toBe(RECOVERY_COPY.LOOP_DETECTED.message);
    expect(result.snapshot.recovery?.errorClass).toBe("LOOP_DETECTED");
    expect(generate.calls).toBe(2);
  });

  it("sends refusals to recovery as unsupported requests", async () => {
    const { runtime } = modelRuntime(["I can't help with that request."]);
    const result = await executeAssistantMessage(null, "I lost my keys", runtime);
    expect(result.snapshot.state).toBe("recovering");
    expect(result.snapshot.recovery?.errorClass).toBe("UNSUPPORTED_REQUEST");
    expect(result.reply).toBe(RECOVERY_COPY.UNSUPPORTED_REQUEST.message);
  });

  it("passes recovering snapshots through untouched", async () => {
    const { runtime, generate } = modelRuntime(['{"intent":"SEARCH"}']);
    const recovering = failWith(startFlow("lost"), {
      errorClass: "TIMEOUT",
      diagnostic: "GUARD_DEADLINE_EXCEEDED",
    });
    const result = await executeAssistantMessage(recovering, "anything", runtime);
    expect(result.snapshot).toBe(recovering);
    expect(generate.calls).toBe(0);
  });
});

describe("executeAssistantMessage without a model", () => {
  it("routes a fresh statement to search instead of stuffing ask state", async () => {
    const result = await executeAssistantMessage(null, "black umbrella", localRuntime());
    expect(result.snapshot.flow).toBe("search");
    expect(result.snapshot.state).toBe("ready");
    expect(result.snapshot.searchFilters?.query).toBe("black umbrella");
    expect(result.replySource).toBe("grounded");
  });

  it("answers follow-up ask input instead of ignoring it", async () => {
    const seen: string[] = [];
    const runtime = localRuntime(async (question) => {
      seen.push(question);
      return { text: "grounded search help", source: "fallback" };
    });
    const first = await executeAssistantMessage(null, "How do I search?", runtime);
    expect(first.snapshot.flow).toBe("ask");
    const second = await executeAssistantMessage(first.snapshot, "What about filters?", runtime);
    expect(seen).toEqual(["How do I search?", "What about filters?"]);
    expect(second.reply).toBe("grounded search help");
    expect(second.replySource).toBe("grounded");
  });

  it("collects a report to a review-held state only", async () => {
    const runtime = localRuntime();
    const first = await executeAssistantMessage(null, "I lost my keys", runtime);
    expect(first.snapshot.flow).toBe("lost");
    expect(first.snapshot.patch.category).toBe("Keys");
    expect(first.reply).toContain("When");
    expect(first.reviewHeld).toBe(false);
    const second = await executeAssistantMessage(first.snapshot, "2026-09-01", runtime);
    expect(second.snapshot.patch.eventDate).toBe("2026-09-01");
    const third = await executeAssistantMessage(second.snapshot, "Central library", runtime);
    expect(third.snapshot.state).toBe("awaitingPhoto");
    const withPhoto = choosePhoto(third.snapshot, "none");
    expect(withPhoto.state).toBe("awaitingLocation");
    const typed = await executeAssistantMessage(withPhoto, "North gate bench", runtime);
    expect(typed.snapshot.state).toBe("ready");
    expect(typed.snapshot.patch.locationNote).toBe("North gate bench");
    expect(typed.snapshot.allowedActions).toContain("APPLY_REPORT_DRAFT");
    expect(typed.reviewHeld).toBe(true);
    expect(typed.reply).toContain("held");
    expect(Object.values(typed).every((value) => typeof value !== "function")).toBe(true);
  });

  it("answers non-app questions with the grounded scope reply", async () => {
    const result = await executeAssistantMessage(null, "hello", localRuntime());
    expect(result.reply).toContain("only help with questions about using FindBack");
    expect(result.replySource).toBe("grounded");
  });

  it("clarifies degenerate input", async () => {
    const result = await executeAssistantMessage(null, "??", localRuntime());
    expect(result.reply).toContain("couldn't tell");
  });

  it("keeps typed location answers explicit on the location step", async () => {
    const runtime = localRuntime();
    const first = await executeAssistantMessage(null, "I found a watch", runtime);
    const dated = await executeAssistantMessage(first.snapshot, "2026-08-20", runtime);
    const located = await executeAssistantMessage(dated.snapshot, "North gate bench", runtime);
    const withPhoto = choosePhoto(located.snapshot, "none");
    expect(withPhoto.state).toBe("awaitingLocation");
    const typed = await executeAssistantMessage(withPhoto, "North gate bench", runtime);
    expect(typed.snapshot.patch.locationNote).toBe("North gate bench");
  });
});

describe("groundedHelpAnswer", () => {
  it("answers from versioned capabilities without inventing features", () => {
    const answer = groundedHelpAnswer("How do I search and filter?");
    expect(answer.length).toBeGreaterThan(0);
    expect(answer).not.toContain("private messaging");
  });
});

describe("assistant correctness regression matrix", () => {
  it("maps phone to Electronics", async () => {
    const result = await executeAssistantMessage(null, "I lost my phone", localRuntime());
    expect(result.snapshot.patch.category).toBe("Electronics");
  });
  it("maps keychain to Keys", async () => {
    const result = await executeAssistantMessage(null, "I lost my keychain", localRuntime());
    expect(result.snapshot.patch.category).toBe("Keys");
  });
  it("answers unknown bj with an explicit can't-match plus category choices", async () => {
    const runtime = localRuntime();
    const first = await executeAssistantMessage(null, "I lost something", runtime);
    expect(first.snapshot.missingFields).toContain("category");
    const second = await executeAssistantMessage(first.snapshot, "bj", runtime);
    expect(second.snapshot.patch.category).toBeUndefined();
    expect(second.snapshot.missingFields).toContain("category");
    expect(second.reply).toContain('couldn\'t match "bj"');
    expect(second.reply).toContain("Electronics");
    expect(second.reply).toContain("Keys");
  });
  it("keeps a greeting from consuming the pending report flow", async () => {
    const runtime = localRuntime();
    const first = await executeAssistantMessage(null, "I lost my keys", runtime);
    const second = await executeAssistantMessage(first.snapshot, "hello", runtime);
    expect(second.snapshot.patch).toEqual(first.snapshot.patch);
    expect(second.snapshot.missingFields).toEqual(first.snapshot.missingFields);
    expect(second.reply).toContain("Hello!");
    expect(second.reply).toContain("When was the item");
  });
  it("answers an app question while preserving the pending report flow", async () => {
    const runtime = localRuntime(async (question) => ({
      text: `Built-in: ${question}`,
      source: "fallback",
    }));
    const first = await executeAssistantMessage(null, "I lost my keys", runtime);
    const second = await executeAssistantMessage(first.snapshot, "how do I add a photo?", runtime);
    expect(second.snapshot.patch).toEqual(first.snapshot.patch);
    expect(second.snapshot.missingFields).toEqual(first.snapshot.missingFields);
    expect(second.reply).toContain("Built-in: how do I add a photo?");
    expect(second.reply).toContain("When was the item");
  });
  it("switches to search on an explicit pivot", async () => {
    const runtime = localRuntime();
    const first = await executeAssistantMessage(null, "I lost my keys", runtime);
    const second = await executeAssistantMessage(
      first.snapshot,
      "actually I want to search for black umbrella",
      runtime,
    );
    expect(second.snapshot.flow).toBe("search");
    expect(second.snapshot.searchFilters?.query).toContain("umbrella");
  });
  it("extracts multiple report fields from one sentence", async () => {
    const result = await executeAssistantMessage(
      null,
      "I lost my black phone Near Central library on 2026-09-01",
      localRuntime(),
    );
    expect(result.snapshot.patch.category).toBe("Electronics");
    expect(result.snapshot.patch.eventDate).toBe("2026-09-01");
    expect(result.snapshot.patch.locationNote).toBe("Central library");
  });
  it("clarifies degenerate input without consuming the pending flow", async () => {
    const runtime = localRuntime();
    const first = await executeAssistantMessage(null, "I lost my keys", runtime);
    const second = await executeAssistantMessage(first.snapshot, "??", runtime);
    expect(second.snapshot.patch).toEqual(first.snapshot.patch);
    expect(second.reply).toContain("didn't catch");
  });
  it("keeps ready actions inside the contract allowlist", async () => {
    const runtime = localRuntime();
    const first = await executeAssistantMessage(null, "I lost my keys", runtime);
    const second = await executeAssistantMessage(first.snapshot, "2026-09-01", runtime);
    const third = await executeAssistantMessage(second.snapshot, "Central library", runtime);
    expect(third.snapshot.allowedActions).toContain("PICK_PHOTO");
    const withPhoto = choosePhoto(third.snapshot, "none");
    const typed = await executeAssistantMessage(withPhoto, "North gate bench", runtime);
    expect(typed.snapshot.state).toBe("ready");
    expect(typed.snapshot.allowedActions).toContain("APPLY_REPORT_DRAFT");
  });
});
