import { config } from "../config.js";

export interface AiAnswer {
  text: string;
  /** "llm" when a real provider answered, "fallback" for the deterministic demo. */
  source: "llm" | "fallback";
  model?: string;
}

export interface AiAssistantProvider {
  ask(question: string): Promise<AiAnswer>;
}

const SYSTEM_PROMPT = [
  "You are the FindBack Help Assistant, a small support bot for a lost-and-found app.",
  "Answer only short, practical questions about using FindBack: reporting a lost or found item,",
  "marking an item recovered/matched, adding photos, locations, search, comments, ratings and safety.",
  "Keep replies under 120 words. If a question is off-topic, politely say you can only help with FindBack.",
].join(" ");

/** No hard dependency on a provider: if no API key is set, stays deterministic. */
export const aiAssistantProvider: AiAssistantProvider = {
  async ask(question: string): Promise<AiAnswer> {
    if (config.llm.baseUrl && config.llm.apiKey) {
      try {
        const res = await fetch(`${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.llm.apiKey}`,
          },
          body: JSON.stringify({
            model: config.llm.model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: question },
            ],
            max_tokens: 300,
            temperature: 0.3,
          }),
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) return { text, source: "llm", model: config.llm.model };
      } catch {
        // fall through to the deterministic answer; never crash help chat
      }
    }
    return { text: fallbackAnswer(question), source: "fallback" };
  },
};

/**
 * Deterministic demo fallback covering the app's own help topics so the Help
 * screen always works with no credentials. Clearly labeled "demo" in the UI.
 */
export function fallbackAnswer(questionRaw: string): string {
  const q = questionRaw.toLowerCase();

  const has = (...words: string[]) => words.some((w) => q.includes(w));

  if (has("lost", "report", "reporting") && (has("item", "how", "found") || q.includes("report"))) {
    return (
      "To report a lost item: tap the + Report button on Home, choose Lost, then fill in the " +
      "title, description, category dropdown, the date it happened, and an approximate " +
      "location from the map. You can add a photo and an optional YouTube link. Tap Publish " +
      "and it will appear on the feed instantly."
    );
  }
  if (has("found")) {
    return (
      "Found something? Tap + Report, choose Found, and include as many details as possible: " +
      "category, date, map location and a clear photo. Anyone searching that category can then " +
      "contact you through a comment to arrange a match. Remember to mark it Recovered once " +
      "the owner collects it."
    );
  }
  if (has("recover", "match", "closed", "status", "mark")) {
    return (
      "Open your own post and use the status control to move it through Open -> Matched -> " +
      "Recovered -> Closed. Once an item is back with its owner, mark it Recovered so it stops " +
      "appearing in the open feed."
    );
  }
  if (has("search", "filter", "find")) {
    return (
      "Use the Search tab or the search bar on Home. You can switch between Lost and Found, " +
      "filter by category or status, and sort newest/oldest. Results paginate automatically."
    );
  }
  if (has("comment")) {
    return "Open any post and type in the comment box at the bottom. Comments appear live — the other person sees them without refreshing.";
  }
  if (has("like", "dislike", "rating", "star", "rate")) {
    return "Under each post you can like or dislike (one per user) and give a 1-5 star rating. Counts and the average update live for everyone viewing the post.";
  }
  if (has("photo", "image", "upload", "picture", "attach")) {
    return "When creating a report you can attach one photo. Pick the image, confirm the preview, and publish. The image is uploaded to the server and shown on the post page.";
  }
  if (has("verif", "email", "phone", "otp", "code")) {
    return "After registering, verify your email and phone from the Verify screens. A 6-digit code is sent (in this demo build the code is shown by the dev server). This proves your contact details are real in the full version.";
  }
  if (has("account", "delete", "logout", "sign out", "log out")) {
    return "Go to Profile. Use Log out to end the session. There is no account deletion in this version yet.";
  }
  if (has("location", "map", "gps")) {
    return "You can pin an approximate one-time location on the map when creating a report. FindBack never tracks your location in the background.";
  }
  if (has("youtube", "video", "embed")) {
    return "You may paste an optional YouTube link into a report (for example a security-cam or item video). It plays embedded on the post page with a fallback to open YouTube if playback is blocked.";
  }
  if (has("hello", "hi", "hey", "help")) {
    return "Hi! I can help with FindBack. Ask me how to report a lost or found item, mark it recovered, search, comment, rate, or verify your account.";
  }
  return (
    "I can only help with FindBack app questions — for example reporting a lost or found item, " +
    "changing its status, searching and filtering, comments, likes/ratings, photos, and " +
    "verification. Try rephrasing your question."
  );
}
