import { describe, expect, it } from "vitest";
import {
  HELP_TOPICS,
  builtInHelp,
  classifyHelpQuestion,
  hasForeignSubject,
  isAppHelpQuestion,
} from "./helpFaq";

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

  it("answers one's own verification-code questions from the OTP FAQ, never the lookup refusal", () => {
    // CF-070 R2 retry-3 finding 2: lookup used to run first, so a question with
    // a lookup verb ("where is my") and the word "email" was answered with the
    // contact-details refusal instead of the signup instructions.
    for (const question of [
      "Where is my email verification code?",
      "Where is my FindBack email verification code?",
      "How do I get my email verification code?",
      "Where is my Gmail verification email for this app?",
    ]) {
      const classification = classifyHelpQuestion(question);
      expect(classification.topic, question).toBe("verification");
      expect(classification.appHelp, question).toBe(true);
      expect(classification.answer.toLowerCase(), question).toContain("one-time code");
      expect(classification.answer, question).not.toMatch(/can't look up|cannot look up/i);
    }

    // The refusal still belongs to a real contact lookup.
    expect(classifyHelpQuestion("Find the email address of user Alice").topic).toBe("lookup");
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
  });

  it("answers account recovery as app help (CF-070 R2 retry-6 R1)", () => {
    // The retry-5 ruling kept this row refused on the premise that the app has
    // Google sign-in and no password. That premise is false, so the refusal was
    // a false denial of a shipped feature: apps/mobile/src/services/auth.ts:186
    // (`signInWithPassword`), apps/mobile/src/services/auth.ts:304
    // (`requestPasswordReset`, the `resetPasswordForEmail` call is `:307`),
    // apps/mobile/src/App.tsx:131
    // (`/forgot` -> ForgotPassword). This replaces the retry-1 assertion at the
    // old `:129`, which expected the scope note here.
    const reset = builtInHelp("How do I reset my password?");
    expect(reset).toMatch(/Forgot password/i);
    expect(reset.toLowerCase()).toContain("reset link");
    expect(reset).not.toContain("I can help with FindBack");
    expect(reset).not.toMatch(/don't know|does not have|not in this build/i);

    const change = builtInHelp("how do I change my password?");
    expect(change).toBe(reset);
    for (const question of [
      "How do I reset my password?",
      "how do I change my password?",
      "I forgot my password",
      "How do I recover my password?",
    ]) {
      const classification = classifyHelpQuestion(question);
      expect(classification.topic, question).toBe("password");
      expect(classification.appHelp, question).toBe(true);
      expect(isAppHelpQuestion(question), question).toBe(true);
    }
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
    // The bare FAQ questions the app still owns by shape alone, so tightening
    // the topic phrases does not cost the person the answer they asked for.
    "How do I change status?",
    "How do I choose a location?",
    "How do I upload a photo?",
    "How do I rate a post?",
    "How do I react to a comment?",
    "How do I mark an item recovered?",
    "Are you ChatGPT?",
    // CF-070 R2 retry-3: the natural FAQ forms the subject binding must not
    // cost, including the verification row that had regressed.
    "Where is my email verification code?",
    "How do I upload my photo?",
    "How do I upload photos here?",
    "Where can I see notifications?",
    "How do I comment on another user's report?",
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
    // CF-070 R2 retry-2: app-shaped words, world-shaped subject.
    "How do I search for peer-reviewed papers?",
    "How do I use a map to navigate a forest?",
    "How do I rate a restaurant?",
    "How do I delete my Gmail account?",
    "How does face recognition identify another person?",
    "How do I turn off Gmail notifications?",
    "How do I check my order status?",
    "How do I filter water at home?",
    "How do I add a card to my Apple Wallet?",
    // CF-070 R2 retry-3 finding 1: a phrase match is not subject binding. Each
    // of these matches a topic phrase word for word and is still about the
    // world, so the subject is what decides.
    "How do I search stock market reports?",
    "How do I write a report for school?",
    "How do I upload a photo to my passport application?",
    "How do I change the location of a meeting?",
    "How do I rate items on an employee performance review?",
    "How do I set my shop status to closed?",
    "How do I leave a comment in a PDF?",
    "How do I edit my draft for a school essay?",
    "How do I delete my account with my bank?",
    "How do I upload a photo to Instagram, not FindBack?",
    // Same classes, nouns the review never used.
    "How do I search for a job report?",
    "How do I write a book report?",
    "How do I add a photo to my CV?",
    "How do I comment on a news article?",
    "How do I find my package status?",
    "How do I react to a bad review at work?",
    "How do I set my status on Slack?",
    "How do I use FindBack to search Google for medical reports?",
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

    // CF-070 R2 finding 1-retry, retry-2 and retry-3: a grammatical request
    // about the world gets the scope note, never FindBack FAQ copy.
    for (const question of [
      "How do I bake sourdough bread?",
      "Can I freeze leftover soup?",
      "How can I take better landscape photos?",
      "What is the function of a bicycle bell?",
      "How do I find the square root of 144?",
      "How do I search for peer-reviewed papers?",
      "How do I use a map to navigate a forest?",
      "How do I rate a restaurant?",
      "How do I delete my Gmail account?",
      "How does face recognition identify another person?",
      "How do I search stock market reports?",
      "How do I write a report for school?",
      "How do I upload a photo to my passport application?",
      "How do I change the location of a meeting?",
      "How do I rate items on an employee performance review?",
      "How do I set my shop status to closed?",
      "How do I leave a comment in a PDF?",
      "How do I edit my draft for a school essay?",
      "How do I delete my account with my bank?",
      "How do I upload a photo to Instagram, not FindBack?",
    ]) {
      const reply = builtInHelp(question);
      expect(reply, question).toContain("I can help with FindBack");
      expect(reply, question).not.toContain("attach a photo");
      expect(reply, question).not.toContain("bell");
      expect(reply, question).not.toContain("Search to search reports");
      expect(reply, question).not.toContain("approximate location");
      expect(reply, question).not.toContain("delete your account");
    }
  });

  it("reports the topic it answered with, so callers never re-derive intent", () => {
    expect(classifyHelpQuestion("How do I search?").topic).toBe("search");
    expect(classifyHelpQuestion("Which AI model are you?").topic).toBe("model-identity");
    expect(classifyHelpQuestion("What is photosynthesis?").topic).not.toBe("photo");
  });
});

/**
 * The two structural guards for CF-070 R2 retry-4 MAJOR-2. Four `pattern`
 * branches shipped dead (`mark all read`, `filter by category`,
 * `mark my report as recovered`, `upload a photo from my gallery`) because
 * nothing ever asserted that a topic's declared wording is answered or that
 * the vocabulary agrees with its own pattern. These two tests are the fix for
 * the class of defect, not for the four rows.
 */
describe("FAQ topic coverage (CF-070 R2 retry-4 MAJOR-2)", () => {
  const topics = HELP_TOPICS.map((topic) => [topic.id, topic] as const);

  it("declares at least one literal example per topic", () => {
    for (const [id, topic] of topics) expect(topic.examples.length, id).toBeGreaterThan(0);
    expect(new Set(topics.map(([id]) => id)).size).toBe(topics.length);
  });

  it.each(topics)("answers the literal wording of the %s topic", (_id, topic) => {
    for (const question of topic.examples) {
      const classification = classifyHelpQuestion(question);
      expect(classification.topic, question).toBe(topic.id);
      expect(classification.appHelp, question).toBe(true);
    }
  });

  it.each(topics)("keeps the %s pattern reachable through the subject veto", (_id, topic) => {
    // `examples[0]` is the topic's own pattern phrase: if the pattern matches it
    // but the vocabulary veto refuses it, the branch is unreachable.
    const phrase = topic.examples[0] ?? "";
    expect(topic.pattern.test(phrase), phrase).toBe(true);
    expect(hasForeignSubject(phrase, topic), phrase).toBe(false);
  });
});

/**
 * CF-070 R2 retry-4 fixtures, carried over verbatim from
 * `REVIEW-CF070-R2-RETRY-4.md` §3 so the repair cannot regress quietly.
 */
describe("CF-070 R2 retry-4 — measured world rows stay refused", () => {
  it.each([
    // MAJOR-1: a self-bound report question whose destination or authority is
    // not FindBack. Only the word "lost" separates these from the retry-2
    // positive, so the exemption must not carry them.
    "How do I report a lost wallet to the police?",
    "How do I report a wallet to the police?",
    "How do I report a lost wallet to the bank?",
    "How do I write a report about a lost battle for history class?",
    "How do I report a lost dog to the council?",
    "How do I report found property to the tax office?",
    "How do I submit a report for my lost dog to animal control?",
    "My lost report, how do I write it for school?",
    "How do I report my boss\u2019s lost keys to HR?",
    "How do I report a lost passport to the embassy?",
    "How do I report a lost item to the airline lost and found?",
    "How do I write a book report on a lost boy?",
    "HOW DO I REPORT A LOST WALLET TO THE POLICE?",
    // MAJOR-1: the non-`report` member of the same family.
    "How do I turn off notifications from another app?",
    // MINOR-2: another person's one-time code is not the asker's signup help.
    "How do I get another user\u2019s email verification code?",
    "Where is the email verification code of user Alice?",
    "Find the verification code for user Alice",
    // MINOR-3: the veto must not delete a script it cannot read.
    "How do I upload my \u0444\u043e\u0442\u043e\u0433\u0440\u0430\u0444\u0438\u044f?",
    "How do I report my \u4e22\u5931 backpack?",
    // CF-070 R2 retry-4 group C/G worlds that share their words with an app topic.
    "How do I upload a photo to Instagram instead of FindBack?",
    "How do I verify my phone?",
  ])("keeps the draft for %s", (question) => {
    expect(isAppHelpQuestion(question), question).toBe(false);
    expect(classifyHelpQuestion(question).appHelp, question).toBe(false);
    // Fail closed: the scope note, never a topic answer substituted for it.
    expect(builtInHelp(question), question).toContain("I can help with FindBack");
  });
});

describe("CF-070 R2 retry-4 — measured app rows are answered", () => {
  it.each([
    // MAJOR-2 dead branches: the classifier's own declared phrases.
    "How do I mark all read?",
    "How do I mark all as read?",
    "How do I mark read?",
    "How do I filter by category?",
    "How do I filter category?",
    "How do I mark my report as recovered?",
    "How do I mark my report recovered?",
    "How do I upload a photo from my gallery?",
    "How do I attach a photo from my camera?",
    // MAJOR-2 the refused feature answers.
    "How do I check for possible matches?",
    "How do I see my possible matches?",
    "How do I upload a photo of my cat?",
    "How do I search for lost phones?",
    "How do I search for a lost cat?",
    "How do I search listings for a wallet?",
    "How do I find lost items near me?",
    "How do I add more photos?",
    "How do I edit my report after publishing?",
    "How do I write a good description for my report?",
    "How do I add a clear title?",
    "How do I set the correct date?",
    "How do I choose the right category?",
    "Where can I see my saved drafts?",
    "How do I delete a comment I made?",
    "How do I use search?",
    "How do I view my notifications as a list?",
    "How do I rate a post out of five?",
    "How do I upload a photo when reporting?",
    // CF-070 R2 retry-4 group H/G recall rows.
    "How do I search for items near me?",
    "How do I search the app for lost items?",
    "How do I read my notifications?",
    // The retry-2 positive the MAJOR-1 repair must not cost.
    "How can I report my lost backpack?",
    "How do I report a lost wallet?",
  ])("answers %s", (question) => {
    expect(isAppHelpQuestion(question), question).toBe(true);
    expect(classifyHelpQuestion(question).appHelp, question).toBe(true);
    expect(builtInHelp(question), question).not.toContain("I can help with FindBack");
  });

  it("records the NIT-3 residual and its retry-6 change", () => {
    // The unavailable-feature pattern requires "message another user"; the
    // request form puts a preposition between them, so the claim is not made.
    // Until retry-6 it fell through to `unknown-feature`, which asserted a
    // feature-level fact from a question the vocabulary check could not read
    // (CF-070 R2 retry-4 NIT-3). Under R2 it now asserts nothing at all: the
    // draft is kept and ordinary Chat answers, which is the intended
    // consequence of the fail-closed rule, recorded here rather than edited
    // because `appKnowledge.ts` owns the pattern.
    const classification = classifyHelpQuestion("How do I send a message to another user?");
    expect(classification.topic).toBe("default-scope");
    expect(classification.appHelp).toBe(false);
    expect(isAppHelpQuestion("How do I send a message to another user?")).toBe(false);

    // The claim itself is unchanged where the vocabulary can read it.
    expect(classifyHelpQuestion("Can I message another user privately?").topic).toBe(
      "unavailable-feature",
    );
    expect(classifyHelpQuestion("Can I send a direct message to another user?").topic).toBe(
      "unavailable-feature",
    );
  });
});

/**
 * CF-070 R2 retry-6 closed three classes the retry-5 review measured: R1 an
 * answered password row (§4a), R2 a false feature denial for questions the
 * vocabulary cannot read (§3a), R3 an unbounded object-slot exemption that
 * answered world questions with FindBack copy (§2). These tests pin the
 * classes, not the individual rows: the same request shape is asserted to
 * answer with an in-vocabulary object and to fail closed with any other noun.
 */
describe("CF-070 R2 retry-6 — the repaired classes", () => {
  it("R2 asserts nothing about the app when the vocabulary cannot read the question", () => {
    // The measured false denial: account deletion is shipped and is a modelled
    // topic (`account-deletion`), so telling the person it does not exist is a
    // false statement, and consuming the draft removed their ability to retry.
    const denied = classifyHelpQuestion("Como elimino mi cuenta de FindBack?");
    expect(denied.topic).toBe("default-scope");
    expect(denied.appHelp).toBe(false);
    expect(builtInHelp("Como elimino mi cuenta de FindBack?")).toContain("I can help with FindBack");

    for (const question of [
      "Comment puis-je supprimer mon compte FindBack ?",
      "FindBack mein apna account kaise delete karun?",
      "How do I upload my tasveer? ",
      "Comment allez-vous aujourd'hui?",
      "Quel temps fait-il a Paris?",
      "Como estas hoy?",
    ]) {
      const classification = classifyHelpQuestion(question);
      expect(classification.appHelp, question).toBe(false);
      expect(builtInHelp(question), question).toContain("I can help with FindBack");
      expect(builtInHelp(question), question).not.toMatch(/don't know.*won't guess/i);
    }
  });

  it("R2 keeps an answer for a readable availability question, without claiming absence", () => {
    // The fail-closed rule must not silence a question the vocabulary CAN read
    // end to end: an availability question ("Does FindBack have/offer …?") is
    // answered, so the two effects are distinguishable. The answer still may
    // not say the app lacks the feature — the term may be a shipped feature
    // written badly (retry-7 R6-1).
    for (const question of [
      "Does FindBack have a Pets category?",
      "Does FindBack offer teleportation?",
    ]) {
      const classification = classifyHelpQuestion(question);
      expect(classification.topic, question).toBe("unknown-feature");
      expect(classification.appHelp, question).toBe(true);
      expect(builtInHelp(question), question).toMatch(/won't guess|don't guess|do not know/i);
      expect(builtInHelp(question), question).not.toMatch(
        /does not have|doesn't have|not in this build|no such/i,
      );
    }
  });

  it("R3 exempts an object slot only when its noun is app vocabulary", () => {
    // The rule is lexical, not a list of rows: "lost <noun>" with a noun the app
    // can have (wallet, backpack, phone, cat, dog, parrot) is app help, and with
    // any other noun the subject survives and the question fails closed.
    const answered = [
      "How do I report a lost wallet?",
      "How do I report a lost backpack?",
      "How do I search for lost phones?",
      "How do I report a lost cat?",
      "How do I report a lost dog?",
      "How do I report a lost parrot?",
    ];
    for (const question of answered) {
      expect(isAppHelpQuestion(question), question).toBe(true);
    }

    const refused = [
      "How do I write a report on a lost boy?",
      "How do I report a lost city?",
      "How do I search for the lost ark?",
      "How do I search for lost souls?",
      "How do I report my lost tama?",
      "How do I report a lost battle to my history teacher?",
      "How do I report a lost wallet on the subway?",
      "How do I report a lost wallet to the police?",
      "How do I report a lost colony of Roanoke for my history project?",
      "How do I report a lost umbrella on the bus?",
      "How do I report a lost pet to the vet?",
      // One unreadable noun is enough: the exemption is per match, so a known
      // noun elsewhere in the question does not carry an unknown one.
      "How do I report my lost backpack in the lost city of Atlantis?",
    ];
    for (const question of refused) {
      const classification = classifyHelpQuestion(question);
      expect(classification.appHelp, question).toBe(false);
      expect(builtInHelp(question), question).toContain("I can help with FindBack");
      expect(builtInHelp(question), question).not.toContain("Report tab");
    }
  });

  it("L6 reads a question through arbitrary keyboard whitespace", () => {
    for (const question of [
      "How do   I    report    a   lost  backpack?????",
      "how do i report a lost backpack",
      "  How do I report a lost backpack?  ",
      "How\ndo\tI report a lost backpack?",
    ]) {
      const classification = classifyHelpQuestion(question);
      expect(classification.appHelp, question).toBe(true);
      expect(classification.topic, question).toBe("report");
    }
  });

  it("L6b reads a capitalised opening word as vocabulary, not as another script", () => {
    // `significantWords` folds case before the scaffold and app-name scrub, so a
    // sentence-case question is not triaged as unreadable Latin text.
    for (const question of [
      "Does FindBack have a Pets category?",
      "Does FindBack offer teleportation?",
      "How Do I Report A Lost Backpack?",
    ]) {
      const classification = classifyHelpQuestion(question);
      expect(classification.topic, question).not.toBe("default-scope");
    }
  });
});

/**
 * CF-070 R2 retry-7 — R6-1. The retry-6 licence to say anything about the app
 * was "the app is named and at most one term is unreadable", and the retry-6
 * review measured that licence as the harm: app-owned questions carrying one
 * unreadable token (`How do I delete my FindBack cuenta?`, `FindBack cuenta?`,
 * `passwrod`, `pass`, `notificatons`, `profle`, `acount`) were answered "I don't
 * know of that feature" — a false statement about features the app ships
 * (`account-deletion`, `password`, `profile`, `notifications`) — and the draft
 * was consumed, on this tree and at base `37d9c1d`. The licence is now the
 * question's shape plus the absence of any near-miss of an app concept, and the
 * answer itself never asserts that the app lacks anything.
 *
 * Every row below was authored for this wave: one per unreadable-token shape
 * (misspelling, transposition, truncation) in English, plus Spanish, German,
 * French and Italian.
 */
describe("CF-070 R2 retry-7 — R6-1: one unreadable token is not an unknown feature", () => {
  const shapes: ReadonlyArray<readonly [string, string]> = [
    ["How do I delete my FindBack acount?", "misspelling of `account`"],
    ["FindBack profle settings?", "misspelling of `profile`"],
    ["Does FindBack offer notificatons?", "misspelling of `notifications`, in an availability question"],
    ["How do I reset my FindBack passwrod?", "transposition of `password`"],
    ["FindBack pasword recovery?", "transposition of `password`"],
    ["How do I reset my FindBack pass?", "truncation of `password`"],
    ["How do I see my FindBack notificat?", "truncation of `notifications`"],
    ["Wie kann ich mein FindBack Passwort andern?", "German `Passwort`: the question is outside the vocabulary"],
    ["Como elimino mi cuenta de FindBack?", "Spanish `cuenta`, tombstone row of the retry-6 review"],
    ["FindBack cuenta?", "Spanish `cuenta` alone: no request, no availability question"],
  ];

  it("asserts nothing about the app for any question carrying one unreadable token", () => {
    for (const [question, why] of shapes) {
      const classification = classifyHelpQuestion(question);
      expect(classification.appHelp, `${question} (${why})`).toBe(false);
      expect(classification.topic, question).toBe("default-scope");
      // Neither the classifier's own answer nor the fallback copy the screen
      // posts may claim the app lacks a feature.
      expect(classification.answer, question).not.toMatch(
        /don't know of that feature|does not have|not in this build/i,
      );
      expect(builtInHelp(question), question).toContain("I can help with FindBack");
      expect(builtInHelp(question), question).not.toMatch(/does not have|not in this build/i);
    }
  });

  it("keeps the draft when the question is not answered", () => {
    // appHelp=false is the classifier's contract for "this is not a built-in
    // answer": the screen keeps the composer instead of consuming the draft.
    for (const [question] of shapes) {
      expect(classifyHelpQuestion(question).appHelp, question).toBe(false);
    }
  });

  it("reads a request in another language as unreadable, not as an unknown feature", () => {
    for (const question of [
      "Wie kann ich mein Konto loschen?",
      "Comment supprimer mon compte FindBack ?",
      "Come posso eliminare il mio account FindBack?",
      "Cuenta de FindBack?",
    ]) {
      expect(classifyHelpQuestion(question).topic, question).toBe("default-scope");
      expect(classifyHelpQuestion(question).appHelp, question).toBe(false);
    }
  });

  it("still answers a readable availability question, without claiming absence", () => {
    // The corpus pins `Does FindBack offer teleportation?` as app help
    // (probes.mjs A-positive), and the two invariants must not trade it away.
    for (const question of [
      "Does FindBack offer teleportation?",
      "Does FindBack have a Pets category?",
    ]) {
      const classification = classifyHelpQuestion(question);
      expect(classification.appHelp, question).toBe(true);
      expect(classification.answer, question).toMatch(/won't guess/i);
      expect(classification.answer, question).not.toMatch(/does not have|not in this build|no such/i);
    }
  });
});

/**
 * CF-070 R2 retry-8 — F-2. The retry-7 review measured the licence's boundary
 * from outside: `namesOneUnknownTerm` was `<= 1`, so a probe question with
 * **zero** unreadable terms reached the branch whose first sentence names a
 * term it could not place. `Does FindBack have a list?` is fully in the app's
 * vocabulary (`list` is an `APP_VOCAB` word) and was answered "I can't place
 * that term, so I won't guess whether FindBack has it" while consuming the
 * draft — a statement about a term that does not exist, and the wrong product
 * answer, because the app does have search and lists.
 *
 * The bound is now exactly one, so the zero-unreadable shape falls to
 * `default-scope` with the draft kept, and the one-unreadable probe (the R6-1
 * decision: an availability question naming one unplaceable term is a shipped
 * feature under another name) keeps its answer. Both shapes are pinned here,
 * because the retry-7 list exercised neither: its only probe-shaped row
 * (`Does FindBack offer notificatons?`) is blocked by the near-miss rule.
 */
describe("CF-070 R2 retry-8 — F-2: the probe band's boundary is pinned on both sides", () => {
  const oneUnreadable: ReadonlyArray<readonly [string, string]> = [
    ["Does FindBack have cuenta?", "Spanish `cuenta` inside availability-probe grammar"],
    ["Does FindBack offer teletransportación?", "accented non-English term inside availability-probe grammar"],
  ];

  it("keeps the one-unreadable probe a non-asserting claim about the named term", () => {
    for (const [question, why] of oneUnreadable) {
      const classification = classifyHelpQuestion(question);
      expect(classification.appHelp, `${question} (${why})`).toBe(true);
      expect(classification.topic, question).toBe("unknown-feature");
      // The copy names the term it could not place and asserts nothing about
      // the app's feature set.
      expect(classification.answer, question).toMatch(/I can't place that term/i);
      expect(classification.answer, question).not.toMatch(
        /does not have|not in this build|no such|don't know of that feature/i,
      );
    }
  });

  it("keeps the draft for a probe question with nothing left to place", () => {
    // Zero unreadable terms: the question is in this app's vocabulary, so there
    // is no term to name. It falls back to ordinary Chat and the person's draft
    // survives.
    const question = "Does FindBack have a list?";
    const classification = classifyHelpQuestion(question);
    expect(classification.appHelp, question).toBe(false);
    expect(classification.topic, question).toBe("default-scope");
    expect(classification.answer, question).not.toMatch(/I can't place that term/i);
    expect(builtInHelp(question), question).toContain("I can help with FindBack");
  });
});
