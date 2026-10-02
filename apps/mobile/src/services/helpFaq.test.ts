import { describe, expect, it } from "vitest";
import { builtInHelp } from "./helpFaq";

describe("builtInHelp", () => {
  it("keeps answering the shipped FindBack FAQ topics", () => {
    expect(builtInHelp("how do I report a lost item?")).toContain("Report tab");
    expect(builtInHelp("how do I search?")).toContain("filter by category");
    expect(builtInHelp("how do I change status?")).toContain("Recovered");
    expect(builtInHelp("how do I upload a photo?")).toContain("photo");
    expect(builtInHelp("how do I leave a comment?")).toContain("comment");
    expect(builtInHelp("how do I choose a location?")).toContain("map");
    expect(builtInHelp("")).toContain("I can help with FindBack");
  });

  it("still answers an explicit one-time-code question (AI-03 pair)", () => {
    const reply = builtInHelp("Where is my verification code?");
    expect(reply.toLowerCase()).toContain("one-time code");
    expect(reply).toContain("Phone verification is not available");
    expect(reply.toLowerCase()).toContain("signup");
  });

  it("never answers a general coding request with the OTP FAQ (AI-03)", () => {
    const reply = builtInHelp("Write code for a 9x9 tic-tac-toe app");
    expect(reply.toLowerCase()).not.toContain("one-time code");
    expect(reply.toLowerCase()).not.toContain("verification");
    expect(reply.toLowerCase()).not.toContain("signup");
    expect(reply).toMatch(/only answer questions about the findback app/i);
  });

  it("routes other general-code phrasings away from the OTP branch as well (AI-03)", () => {
    const questions = [
      "python code to sort a list",
      "write a javascript function that sums numbers",
      "sql query to count rows",
      "how do I compile a kotlin module?",
    ];
    for (const question of questions) {
      const reply = builtInHelp(question);
      expect(reply.toLowerCase(), question).not.toContain("one-time code");
      expect(reply.toLowerCase(), question).not.toContain("verification");
    }
  });

  it("never claims to look up accounts, email addresses or phone numbers (AI-01)", () => {
    const byEmail = builtInHelp("search for the email address of user amir");
    expect(byEmail.toLowerCase()).not.toContain("filter by category");
    expect(byEmail).toMatch(/cannot look up|can't look up/i);
    expect(byEmail.toLowerCase()).toContain("email");

    const byPhone = builtInHelp("How do I look up a phone number?");
    expect(byPhone).toMatch(/cannot look up|can't look up/i);
    expect(byPhone.toLowerCase()).not.toContain("one-time code");
  });

  it("answers model-identity questions honestly without naming a model", () => {
    const reply = builtInHelp("Which AI model are you?");
    expect(reply).toMatch(/don't state|do not state|don't claim|do not claim/i);
    expect(reply).not.toMatch(/gpt|claude|llama|qwen|mistral|deepseek|openai|anthropic/i);
    expect(builtInHelp("are you ChatGPT?")).not.toMatch(/gpt|claude|llama|qwen/i);
  });

  it("answers notification questions with the shipped inbox behavior", () => {
    const push = builtInHelp("How do I turn on push notifications?");
    expect(push.toLowerCase()).toContain("notification");
    expect(push).toMatch(/bell|inbox/i);
    expect(push).not.toMatch(/does not have|not available|not in this build/i);
  });

  it("gives a negative claim for a feature this build does not have", () => {
    const deletion = builtInHelp("How do I delete my FindBack account?");
    expect(deletion.toLowerCase()).toContain("account");
    expect(deletion).toMatch(/does not have|not available|not in this build/i);

    const messaging = builtInHelp("Can I message another user privately?");
    expect(messaging.toLowerCase()).toMatch(/private messag|direct messag/);
    expect(messaging).toMatch(/does not have|not available|not in this build/i);
  });

  it("refuses to invent a feature that is not in the knowledge", () => {
    const reply = builtInHelp("Does FindBack have a Pets category?");
    expect(reply).toMatch(/won't guess|don't guess|do not know|not in this build/i);
    expect(reply.toLowerCase()).not.toContain("pets category");
    expect(reply.toLowerCase().split("yes").length).toBe(1);
  });

  it("keeps the generic app-scope default for an unrelated question", () => {
    expect(builtInHelp("what is the capital of France?")).toContain("I can help with FindBack");
    expect(builtInHelp("how do I change my password?")).toContain("I can help with FindBack");
  });
});
