/**
 * AI Help Assistant — Supabase Edge Function (Block 10J).
 *
 * mobile → this function (authenticated user only) → OpenAI-compatible provider
 * if `LLM_BASE_URL` + `LLM_API_KEY` secrets are configured → deterministic
 * fallback otherwise. The provider secret never leaves the function and is never
 * logged. Input is length-validated and output is bounded.
 */
import { withSupabase } from "npm:@supabase/server";

const MAX_QUESTION = 500;
const MAX_ANSWER = 1200;
const LLM_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = [
  "You are the FindBack Help Assistant, a small support bot for a lost-and-found app.",
  "Answer only short, practical questions about using FindBack: reporting a lost or found item,",
  "marking an item recovered/matched, adding photos, locations, search, comments, ratings and safety.",
  "Keep replies under 120 words. If a question is off-topic, politely say you can only help with FindBack.",
].join(" ");

interface AiAnswer {
  text: string;
  source: "llm" | "fallback";
  model?: string;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, _ctx) => {
    let question = "";
    try {
      const body = await req.json();
      question = typeof body?.question === "string" ? body.question.trim() : "";
    } catch {
      // fall through to the empty-question error
    }
    if (!question) return Response.json({ error: "question is required" }, { status: 400 });
    if (question.length > MAX_QUESTION) return Response.json({ error: "question too long" }, { status: 400 });

    return Response.json(await answerQuestion(question));
  }),
};

async function answerQuestion(question: string): Promise<AiAnswer> {
  const baseUrl = Deno.env.get("LLM_BASE_URL");
  const apiKey = Deno.env.get("LLM_API_KEY");
  const model = Deno.env.get("LLM_MODEL") ?? "gpt-4o-mini";
  if (baseUrl && apiKey) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: question },
          ],
          max_tokens: 300,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) return { text: text.slice(0, MAX_ANSWER), source: "llm", model };
      }
    } catch {
      // never crash the help chat; use the deterministic answer
    }
  }
  return { text: fallbackAnswer(question), source: "fallback" };
}

/** Deterministic demo fallback so Help always works with no provider secret. */
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
    return "When creating a report you can attach one photo. It is normalized on your device, uploaded to secure cloud storage, and shown on the post page.";
  }
  if (has("verif", "email", "phone", "otp", "code")) {
    return "After registering, verify your email from the Verify screen — Supabase emails a real one-time code. Phone verification is not enabled in this build yet because no SMS provider is configured.";
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
