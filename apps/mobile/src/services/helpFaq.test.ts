import { describe, expect, it } from "vitest";
import { builtInHelp, classifyHelpQuestion, isAppHelpQuestion } from "./helpFaq";

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

  it("describes inbox activity as reactions, not legacy likes/dislikes (W1-A FBX-035)", () => {
    const push = builtInHelp("How do I view my notifications?");
    expect(push).toMatch(/reactions, comments, mentions/i);
    expect(push).not.toMatch(/likes, dislikes/i);
    expect(push).not.toMatch(/like or dislike/i);

    // "What notifications will I get?" names no app object and asks for
    // nothing, so it is ambiguous ("How do I bake sourdough bread?" has the
    // same shape). The FAQ prefers the scope note over a guessed answer
    // (CF-070 R2 finding 1-retry).
    expect(builtInHelp("What notifications will I get?")).toContain("I can help with FindBack");
  });

  it("answers the shipped account-deletion flow and keeps negatives for the rest", () => {
    const deletion = builtInHelp("How do I delete my FindBack account?");
    expect(deletion).toMatch(/Settings.*Account.*Delete account/i);
    expect(deletion).toMatch(/type your email/i);
    expect(deletion).toMatch(/permanently removes/i);

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

/**
 * The app-help predicate decides whether a failed send may be replaced by the
 * built-in answer (Help clears the composer when it does), so a keyword
 * collision here costs the person their draft. It used to be derived by
 * comparing rendered answers, which made every broad FAQ keyword a false
 * positive (CF-070 R2 finding 1: "photo" inside photosynthesis, "map" inside
 * map projections, "like" inside "look like").
 */
describe("isAppHelpQuestion intent matrix (CF-070 R2 finding 1)", () => {
  const APP_HELP_POSITIVES = [
    "How do I search?",
    "How do I report a lost wallet?",
    "How do I add a photo to my report?",
    "How do I turn off notifications?",
    "How do I view my notifications?",
    "How do I comment on a post?",
    "Where is my verification code?",
    "How do I delete my account?",
    "Does FindBack have a Pets category?",
    "Can I message another user privately?",
    "Search for the email address of user amir",
    "Which AI model are you?",
    // The retry review's positive classes, verbatim.
    "How can I report my lost backpack?",
    "How do I search FindBack listings?",
    "Can I attach a photo to my report?",
    "How do I turn on notifications?",
    "How do I leave a comment?",
    "How do I delete my FindBack account?",
    "Does FindBack offer teleportation?",
    "Can I send a direct message to another user?",
  ];

  const NOT_APP_HELP = [
    "What is photosynthesis?",
    "How do map projections distort Greenland?",
    "What does a solar eclipse look like?",
    "What is the road map for this project?",
    "How does face recognition work?",
    "Why do onions make people cry?",
    "Explain the causes of the tides",
    // CF-070 R2 finding 1-retry: grammatical requests about the world.
    "How do I bake sourdough bread?",
    "Can I freeze leftover soup?",
    "How can I take better landscape photos?",
    "What is the function of a bicycle bell?",
    "How do I find the square root of 144?",
    // Ambiguous and request-shaped, but names nothing the app owns.
    "What notifications will I get?",
  ];

  it("recognises concise app-help prompts", () => {
    for (const question of APP_HELP_POSITIVES) {
      expect(isAppHelpQuestion(question), question).toBe(true);
      expect(classifyHelpQuestion(question).appHelp, question).toBe(true);
    }
  });

  it("refuses FAQ keyword collisions that are not about the app", () => {
    for (const question of NOT_APP_HELP) {
      expect(isAppHelpQuestion(question), question).toBe(false);
      expect(classifyHelpQuestion(question).appHelp, question).toBe(false);
    }
  });

  it("answers a colliding question with the scope note instead of the collided copy", () => {
    expect(builtInHelp("What is photosynthesis?")).toContain("I can help with FindBack");
    expect(builtInHelp("What is photosynthesis?")).not.toContain("attach a photo");
    expect(builtInHelp("How do map projections distort Greenland?")).toContain(
      "I can help with FindBack",
    );
    expect(builtInHelp("What does a solar eclipse look like?")).toContain("I can help with FindBack");
    expect(builtInHelp("How does face recognition work?")).toContain("I can help with FindBack");

    // CF-070 R2 finding 1-retry: a grammatical request about the world gets the
    // scope note, never FindBack FAQ copy.
    for (const question of [
      "How do I bake sourdough bread?",
      "Can I freeze leftover soup?",
      "How can I take better landscape photos?",
      "What is the function of a bicycle bell?",
      "How do I find the square root of 144?",
    ]) {
      const reply = builtInHelp(question);
      expect(reply, question).toContain("I can help with FindBack");
      expect(reply, question).not.toContain("attach a photo");
      expect(reply, question).not.toContain("bell");
      expect(reply, question).not.toContain("Search to search reports");
    }
  });

  it("reports the topic it answered with, so callers never re-derive intent", () => {
    expect(classifyHelpQuestion("How do I search?").topic).toBe("search");
    expect(classifyHelpQuestion("Which AI model are you?").topic).toBe("model-identity");
    expect(classifyHelpQuestion("What is photosynthesis?").topic).not.toBe("photo");
  });
});
