import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WB-02 client-side absence guard + C1 catalogue-era route guard: the mobile app must
 * make ZERO active calls to the legacy `ai-help` Supabase Edge route and must carry no
 * second (LLM_MODEL/LLM_BASE_URL) or unapproved-proxy route, no embedded/raw key, and no
 * `VITE_*` key env.
 *
 * C1 change (deliberate, reviewed): the old blanket ban on vendor-qualified/paid model
 * IDs (`openai/…`, `gpt-4`, …) in *fixtures* is REMOVED. The app now ships a dynamic
 * OpenRouter catalogue (`services/ai/modelCatalog.ts`) where paid models are browsable
 * data, gated at send time by `priceClass` + per-task paid consent (`modelPolicy.ts`
 * over the frozen `isSelectionAuthorized`) — never by string-matching fixtures. Paid
 * model ids therefore remain banned in SHIPPED (non-test) modules but are legal in
 * `*.test.*` fixtures. If paid-model protection regresses, it regresses in policy
 * tests, not here.
 *
 * Still banned: legacy `ai-help`/`functions/v1`, the retired server-key
 * `ai-relay` route (deleted 2026-10-02 — OpenAI/DeepSeek became ordinary BYOK
 * providers, so no server-held key or relay function may reappear),
 * `LLM_MODEL`/`LLM_BASE_URL`, `sk-or-` literals outside tests,
 * `VITE_OPENROUTER_API_KEY`, `api/v1/byok`, unapproved `/api/v1` base
 * URLs/proxies (only `openrouter.ai` approved), and calling an
 * OpenRouter-served model a "direct connection" (it is `Via OpenRouter`, never direct).
 *
 * Static + import-graph scan (CI-safe: no network, no build, no key, no subprocess).
 * Chosen over an import-graph-only check because a URL built from a string literal is
 * invisible to module resolution; the import graph from `main.tsx` is asserted as a
 * second, independent check so *reachable* code is proven clean too.
 *
 * Comments are stripped before matching so JSDoc that merely mentions the old function
 * name is not a false positive; string literals are preserved so a real endpoint string
 * still fails the test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const mobileSrcRoot = resolve(here, "..");
const selfRel = relative(mobileSrcRoot, fileURLToPath(import.meta.url));

type SourceFile = {
  abs: string;
  rel: string;
  isTest: boolean;
  raw: string;
  code: string;
};

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const TEST_RE = /\.(?:test|spec)\.[tj]sx?$/;

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) found.push(...walk(full));
    } else if (/\.(?:ts|tsx)$/.test(name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Remove `//` and `/* *\/` comments while keeping string/template/regex bodies verbatim,
 * so a forbidden token inside a string literal still trips the scan but the same token in
 * a doc comment does not. Line breaks are preserved so failure lines stay meaningful.
 */
function stripComments(source: string): string {
  const regexPreceders = new Set([
    "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">",
  ]);
  const regexKeywords = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "case", "do", "else", "yield", "await", "void", "delete",
  ]);
  let out = "";
  let i = 0;
  let prev = "";
  let word = "";
  const n = source.length;
  while (i < n) {
    const c = source[i] as string;
    const next = i + 1 < n ? (source[i + 1] as string) : "";
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        const d = source[i] as string;
        if (d === "\\") {
          out += d + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += d;
        i += 1;
        if (d === quote) break;
      }
      prev = quote;
      word = "";
      continue;
    }
    if (c === "`") {
      out += c;
      i += 1;
      while (i < n) {
        const d = source[i] as string;
        if (d === "\\") {
          out += d + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += d;
        i += 1;
        if (d === "`") break;
      }
      prev = "`";
      word = "";
      continue;
    }
    if (c === "/" && (regexPreceders.has(prev) || regexKeywords.has(word))) {
      out += c;
      i += 1;
      let inClass = false;
      while (i < n) {
        const d = source[i] as string;
        if (d === "\n" && !inClass) break;
        out += d;
        if (d === "\\") {
          out += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          i += 1;
          break;
        }
        i += 1;
      }
      while (i < n && /[a-z]/i.test(source[i] as string)) {
        out += source[i] as string;
        i += 1;
      }
      prev = "/";
      word = "";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) {
      prev = c;
      word = /[A-Za-z_$]/.test(c) ? word + c : "";
    }
    i += 1;
  }
  return out;
}

function matchesOf(code: string, pattern: RegExp): string[] {
  const rx = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const hits: string[] = [];
  let m: RegExpExecArray | null = rx.exec(code);
  while (m !== null) {
    hits.push(m[0]);
    if (m.index === rx.lastIndex) rx.lastIndex += 1;
    m = rx.exec(code);
  }
  return hits;
}

/** Rules that must hold in every shipped (non-test) module. */
const SHIPPED_RULES: Array<{ id: string; re: RegExp }> = [
  { id: "legacy ai-help symbol", re: /ai-help/i },
  { id: "legacy ai-relay route", re: /ai-relay/i },
  { id: "legacy functions/v1 endpoint", re: /functions\/v1/ },
  { id: "LLM_MODEL second route", re: /\bLLM_MODEL\b/ },
  { id: "LLM_BASE_URL second route", re: /\bLLM_BASE_URL\b/ },
  { id: "non-free openrouter route", re: /openrouter\/(?!free\b)/ },
  {
    id: "vendor-qualified paid model id",
    // NOTE: `openai/(?!v1/)` — Groq's documented OpenAI-compatible endpoint
    // path (`api.groq.com/openai/v1/...`) is a URL prefix, not a paid model
    // id like `openai/gpt-4o`. IF-001 multi-provider adoption.
    re: /(?:\bopenai\/(?!v1\/)|\b(?:anthropic|google|meta-llama|deepseek|deepseek-chat|mistralai|mistral|perplexity|x-ai|cohere|microsoft|togethercomputer|ai21|qwen|moonshotai|z-ai)\/)/,
  },
  {
    id: "bare paid model id",
    re: /\bgpt-(?:3|4|5)|\bclaude-[0-9]|\bgemini-[0-9]|\bdeepseek-chat\b|\bdeepseek-v[0-9]|\bcommand-r|\bgrok-[0-9]|\bchatgpt-/,
  },
  { id: "raw OpenRouter key literal", re: /\bsk-or-[A-Za-z0-9]/ },
  { id: "VITE OpenRouter key env", re: /VITE_OPENROUTER_API_KEY|\bOPENROUTER_API_KEY\s*[:=]/ },
  { id: "byok provider endpoint", re: /api\/v1\/byok/ },
  {
    id: "unapproved API base URL/proxy",
    re: /https?:\/\/(?!openrouter\.ai)[A-Za-z0-9.-]+\/api\/v1/,
  },
  {
    id: "direct-connection labeling of OpenRouter model",
    re: /direct(ly)?\s+connect/i,
  },
];

/**
 * Rules that must hold in *every* source file, test fixtures included.
 * Paid-model ids are intentionally NOT banned here since C1: catalogue/policy
 * fixtures must be free to name paid models (gating lives in modelPolicy tests).
 */
const ALL_FILE_RULES: Array<{ id: string; re: RegExp }> = [
  { id: "legacy functions/v1/ai-help URL", re: /functions\/v1\/ai-help/ },
  { id: "ai-help function invocation", re: /\.invoke\(\s*["'`]ai-help["'`]/ },
  { id: "LLM_MODEL second route", re: /\bLLM_MODEL\b/ },
  { id: "LLM_BASE_URL second route", re: /\bLLM_BASE_URL\b/ },
  { id: "VITE OpenRouter key env", re: /VITE_OPENROUTER_API_KEY|\bOPENROUTER_API_KEY\s*[:=]/ },
  { id: "byok provider endpoint", re: /api\/v1\/byok/ },
];

/** Test-fixture-only tokens: allowed in `*.test.*`, forbidden anywhere else. */
const TEST_ONLY_TOKENS: Array<{ id: string; re: RegExp }> = [
  { id: "openrouter/auto smuggle vector", re: /openrouter\/auto/ },
  { id: "sk-or key literal", re: /\bsk-or-[A-Za-z0-9]/ },
];

const files: SourceFile[] = walk(mobileSrcRoot)
  .map((abs) => {
    const rel = relative(mobileSrcRoot, abs);
    const raw = readFileSync(abs, "utf8");
    return { abs, rel, isTest: TEST_RE.test(rel), raw, code: stripComments(raw) };
  })
  .filter((f) => f.rel !== selfRel)
  .sort((a, b) => a.rel.localeCompare(b.rel));

const shipped = files.filter((f) => !f.isTest);
const tests = files.filter((f) => f.isTest);

function violations(list: SourceFile[], rules: Array<{ id: string; re: RegExp }>): string[] {
  const out: string[] = [];
  for (const file of list) {
    for (const rule of rules) {
      for (const hit of matchesOf(file.code, rule.re)) out.push(`${file.rel} :: ${rule.id} :: ${hit}`);
    }
  }
  return out;
}

/** Relative-module graph starting at the app entry point. */
function buildImportGraph(entryAbs: string): { nodes: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue: string[] = [entryAbs];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:ts|tsx)$/.test(file)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    const specifiers = code.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g);
    for (const match of specifiers) {
      const spec = match[1] as string;
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(file), spec);
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
        `${base}.json`,
      ];
      const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
      if (hit) queue.push(hit);
      else unresolved.push(`${relative(mobileSrcRoot, file)} -> ${spec}`);
    }
  }
  return { nodes: [...seen].map((p) => relative(mobileSrcRoot, p)).sort(), unresolved };
}

const graph = buildImportGraph(resolve(mobileSrcRoot, "main.tsx"));
const graphFiles = files.filter((f) => graph.nodes.includes(f.rel));

describe("legacy AI route absence (WB-02 client guard)", () => {
  it("scans a real, non-vacuous slice of the mobile source tree", () => {
    expect(files.length).toBeGreaterThanOrEqual(150);
    expect(shipped.length).toBeGreaterThanOrEqual(100);
    expect(tests.length).toBeGreaterThanOrEqual(40);
    expect(selfRel).toBe("services/noLegacyAiRoute.test.ts");
    expect(shipped.some((f) => f.rel === "services/openRouter.ts")).toBe(true);
  });

  it("ships no ai-help symbol, second LLM route, paid model id, key literal, unapproved base URL or direct-connection label", () => {
    expect(violations(shipped, SHIPPED_RULES)).toEqual([]);
  });

  it("contains no legacy ai-help endpoint or invocation in any source file", () => {
    const endpointOnly = ALL_FILE_RULES.filter((r) => r.id.includes("ai-help"));
    expect(violations(files, endpointOnly)).toEqual([]);
  });

  it("keeps openrouter/auto and raw sk-or literals confined to test fixtures", () => {
    const escaped: string[] = [];
    for (const file of files) {
      for (const token of TEST_ONLY_TOKENS) {
        for (const hit of matchesOf(file.code, token.re)) {
          if (!file.isTest) escaped.push(`${file.rel} :: ${token.id} :: ${hit}`);
        }
      }
    }
    expect(escaped).toEqual([]);
    // Both tokens must still be present in tests: they are the contract's negative controls.
    expect(tests.some((f) => matchesOf(f.code, /openrouter\/auto/).length > 0)).toBe(true);
    expect(tests.some((f) => matchesOf(f.code, /\bsk-or-[A-Za-z0-9]/).length > 0)).toBe(true);
  });

  it("pins exactly one free route literal: openrouter/free", () => {
    const openRouter = shipped.find((f) => f.rel === "services/openRouter.ts");
    expect(openRouter).toBeDefined();
    expect(matchesOf(openRouter?.code ?? "", /openrouter\/free/).length).toBeGreaterThanOrEqual(1);
    expect(matchesOf(openRouter?.code ?? "", /export const OPENROUTER_MODEL/).length).toBe(1);
    // No shipped file may carry any other openrouter/... model route.
    expect(violations(shipped, [{ id: "non-free openrouter route", re: /openrouter\/(?!free\b)/ }])).toEqual([]);
  });

  it("has no second LLM route anywhere, tests included", () => {
    expect(violations(files, ALL_FILE_RULES.filter((r) => r.id.startsWith("LLM_")))).toEqual([]);
  });

  it("allows paid-model ids in test fixtures (dynamic catalogue era)", () => {
    // Paid-model gating lives in modelPolicy tests (priceClass + consent), not in
    // string bans — so catalogue/policy fixtures must be free to name paid models.
    expect(tests.some((f) => /\b(?:openai|anthropic|meta-llama)\//.test(f.code))).toBe(true);
  });

  it("new bans trigger on representative violation strings (and spare approved ones)", () => {
    const baseUrl = SHIPPED_RULES.find((r) => r.id === "unapproved API base URL/proxy");
    const directLabel = SHIPPED_RULES.find((r) => r.id === "direct-connection labeling of OpenRouter model");
    expect(baseUrl).toBeDefined();
    expect(directLabel).toBeDefined();
    expect(baseUrl?.re.test("https://proxy.example.com/api/v1/chat")).toBe(true);
    expect(baseUrl?.re.test("https://openrouter.ai/api/v1/models")).toBe(false);
    expect(directLabel?.re.test("Direct connection to openai/gpt-4")).toBe(true);
    expect(directLabel?.re.test("Generated via OpenRouter free model")).toBe(false);
  });

  it("resolves every relative import and keeps the main.tsx graph free of legacy markers", () => {
    expect(graph.unresolved).toEqual([]);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(40);
    expect(violations(graphFiles, SHIPPED_RULES)).toEqual([]);
  });
});
