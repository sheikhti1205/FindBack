/**
 * Minimal Norfold-inspired block-JSON codec for report descriptions.
 *
 * Canonical doc is block JSON (`{"v":1,"blocks":[...]}`); Markdown is the
 * interchange format stored in the existing `description` TEXT column.
 * Markdown is CONTENT, never trusted HTML: only http(s)/mailto links survive,
 * raw tags stay inert text, and anything unsupported degrades to a paragraph.
 */

export const RICH_TEXT_VERSION = 1 as const;

export type InlineNode =
  | { type: "InlineText"; text: string }
  | { type: "Bold"; text: string }
  | { type: "Italic"; text: string }
  | { type: "Link"; href: string; text: string }
  | { type: "BoldLink"; href: string; text: string }
  | { type: "ItalicLink"; href: string; text: string };

export type Block =
  | { type: "Paragraph"; runs: InlineNode[] }
  | { type: "Heading"; level: 1 | 2 | 3; runs: InlineNode[] }
  | { type: "BulletList"; items: InlineNode[][] }
  | { type: "Quote"; runs: InlineNode[] };

export interface RichTextDocument {
  v: 1;
  blocks: Block[];
}

function stripControlChars(s: string): string {
  return Array.from(s, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "" : ch;
  }).join("");
}

function hasControlChars(s: string): boolean {
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Allowlist gate shared by the codec: http(s) + mailto only, ever. */
export function isSafeRichTextHref(href: unknown): boolean {
  if (typeof href !== "string") return false;
  const cleaned = stripControlChars(href.trim());
  return /^(https?:|mailto:)/i.test(cleaned);
}

export function emptyDocument(): RichTextDocument {
  return { v: 1, blocks: [{ type: "Paragraph", runs: [{ type: "InlineText", text: "" }] }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coerceRun(run: unknown): InlineNode {
  if (!isRecord(run) || typeof run.type !== "string") return { type: "InlineText", text: "" };
  const text = typeof run.text === "string" ? run.text : "";
  switch (run.type) {
    case "Bold":
      return { type: "Bold", text };
    case "Italic":
      return { type: "Italic", text };
    case "Link":
      return typeof run.href === "string" && isSafeRichTextHref(run.href)
        ? { type: "Link", href: run.href, text }
        : { type: "InlineText", text };
    case "BoldLink":
      return typeof run.href === "string" && isSafeRichTextHref(run.href)
        ? { type: "BoldLink", href: run.href, text }
        : { type: "Bold", text };
    case "ItalicLink":
      return typeof run.href === "string" && isSafeRichTextHref(run.href)
        ? { type: "ItalicLink", href: run.href, text }
        : { type: "Italic", text };
    case "InlineText":
      return { type: "InlineText", text };
    default:
      return { type: "InlineText", text };
  }
}

function coerceRuns(value: unknown): InlineNode[] {
  if (!Array.isArray(value)) return [{ type: "InlineText", text: "" }];
  const runs = value.map(coerceRun);
  return runs.length > 0 ? runs : [{ type: "InlineText", text: "" }];
}

/** Coerce unknown input into a valid document. Never throws. */
export function asSafeDocument(value: unknown): RichTextDocument {
  try {
    if (!isRecord(value) || !Array.isArray(value.blocks)) return emptyDocument();
    const blocks: Block[] = [];
    for (const raw of value.blocks) {
      if (!isRecord(raw) || typeof raw.type !== "string") continue;
      switch (raw.type) {
        case "Paragraph":
          blocks.push({ type: "Paragraph", runs: coerceRuns(raw.runs) });
          break;
        case "Heading":
          if (raw.level === 1 || raw.level === 2 || raw.level === 3) {
            blocks.push({ type: "Heading", level: raw.level, runs: coerceRuns(raw.runs) });
          } else {
            blocks.push({ type: "Paragraph", runs: coerceRuns(raw.runs) });
          }
          break;
        case "BulletList": {
          const items = Array.isArray(raw.items)
            ? raw.items.map((item) => coerceRuns(item)).filter((runs) => runs.length > 0)
            : [];
          if (items.length > 0) blocks.push({ type: "BulletList", items });
          break;
        }
        case "Quote":
          blocks.push({ type: "Quote", runs: coerceRuns(raw.runs) });
          break;
        default:
          blocks.push({ type: "Paragraph", runs: [{ type: "InlineText", text: "(unsupported block)" }] });
          break;
      }
    }
    return blocks.length > 0 ? { v: 1, blocks } : emptyDocument();
  } catch {
    return emptyDocument();
  }
}

const INLINE_SPECIALS: Array<[RegExp, string]> = [
  [/\\/g, "\\\\"],
  [/`/g, "\\`"],
  [/\*/g, "\\*"],
  [/_/g, "\\_"],
  [/\[/g, "\\["],
  [/\]/g, "\\]"],
  [/\(/g, "\\("],
  [/\)/g, "\\)"],
  [/!/g, "\\!"],
  [/\|/g, "\\|"],
];

/** Angle brackets ride as entities so emitted Markdown never contains raw tags. */
const ENTITY_RE = /&(amp|lt|gt);/g;

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (_m, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : _m,
  );
}

function escapeText(text: string): string {
  let out = text.replace(/&/g, "&amp;");
  for (const [pattern, replacement] of INLINE_SPECIALS) out = out.replace(pattern, replacement);
  return out.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a leading markdown block marker so text can never forge structure. */
function protectLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      /^(\s{0,3})(#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s|```|\||-{3,}|\*{3,}|_{3,})/.test(line)
        ? line.replace(/^(\s{0,3})/, "$1\\")
        : line,
    )
    .join("\n");
}

function emitRun(run: InlineNode): string {
  switch (run.type) {
    case "Bold":
      return `**${escapeText(run.text)}**`;
    case "Italic":
      return `*${escapeText(run.text)}*`;
    case "Link":
      if (!isSafeRichTextHref(run.href) || /\s/.test(run.href) || hasControlChars(run.href)) {
        return escapeText(run.text);
      }
      return `[${escapeText(run.text)}](${run.href.trim()})`;
    case "BoldLink":
      if (!isSafeRichTextHref(run.href) || /\s/.test(run.href) || hasControlChars(run.href)) {
        return `**${escapeText(run.text)}**`;
      }
      return `**[${escapeText(run.text)}](${run.href.trim()})**`;
    case "ItalicLink":
      if (!isSafeRichTextHref(run.href) || /\s/.test(run.href) || hasControlChars(run.href)) {
        return `*${escapeText(run.text)}*`;
      }
      return `*[${escapeText(run.text)}](${run.href.trim()})*`;
    case "InlineText":
      return escapeText(run.text);
  }
}

function emitInline(runs: InlineNode[]): string {
  return protectLineStarts(runs.map(emitRun).join(""));
}

/** Serialize a document to GFM Markdown. Never throws, never emits unsafe links. */
export function toMarkdown(doc: RichTextDocument): string {
  try {
    const safe = asSafeDocument(doc);
    const parts: string[] = [];
    for (const block of safe.blocks) {
      switch (block.type) {
        case "Paragraph":
          parts.push(emitInline(block.runs));
          break;
        case "Heading":
          parts.push(`${"#".repeat(block.level)} ${emitInline(block.runs).replace(/\n/g, " ")}`);
          break;
        case "BulletList":
          parts.push(block.items.map((item) => `- ${emitInline(item).replace(/\n/g, " ")}`).join("\n"));
          break;
        case "Quote":
          parts.push(
            emitInline(block.runs)
              .split("\n")
              .map((line) => (line === "" ? ">" : `> ${line}`))
              .join("\n"),
          );
          break;
      }
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

function unescapeChar(ch: string | undefined): string {
  return ch === undefined ? "\\" : ch;
}

/** Find `delim` from `from`, skipping backslash-escaped chars. -1 if absent. */
function findCloser(s: string, from: number, delim: string): number {
  let i = from;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (s.startsWith(delim, i)) return i;
    i += 1;
  }
  return -1;
}

/** Find the `)` balancing `(` at `open`, skipping escaped chars. -1 if absent. */
function findBalancedParen(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function parseEmphasisInner(inner: string): InlineNode | null {
  const parsed = parseBracketLink(inner, 0);
  if (!parsed || parsed.next !== inner.length) return null;
  return parsed.node;
}

function parseInline(s: string): InlineNode[] {
  const runs: InlineNode[] = [];
  let literal = "";
  const flush = () => {
    if (literal !== "") {
      runs.push({ type: "InlineText", text: literal });
      literal = "";
    }
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      literal += unescapeChar(s[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "*" && s[i + 1] === "*") {
      const close = findCloser(s, i + 2, "**");
      if (close !== -1) {
        flush();
        const inner = s.slice(i + 2, close);
        const linked = parseEmphasisInner(inner);
        if (linked?.type === "Link") runs.push({ type: "BoldLink", href: linked.href, text: linked.text });
        else if (linked) runs.push({ type: "Bold", text: linked.text });
        else runs.push({ type: "Bold", text: inner });
        i = close + 2;
        continue;
      }
    } else if (ch === "*") {
      const close = findCloser(s, i + 1, "*");
      if (close !== -1 && close > i + 1) {
        flush();
        const inner = s.slice(i + 1, close);
        const linked = parseEmphasisInner(inner);
        if (linked?.type === "Link") runs.push({ type: "ItalicLink", href: linked.href, text: linked.text });
        else if (linked) runs.push({ type: "Italic", text: linked.text });
        else runs.push({ type: "Italic", text: inner });
        i = close + 1;
        continue;
      }
    } else if (ch === "_" && !isWordChar(s[i - 1])) {
      const close = findCloser(s, i + 1, "_");
      if (close !== -1 && close > i + 1 && !isWordChar(s[close + 1])) {
        flush();
        const inner = s.slice(i + 1, close);
        const linked = parseEmphasisInner(inner);
        if (linked?.type === "Link") runs.push({ type: "ItalicLink", href: linked.href, text: linked.text });
        else if (linked) runs.push({ type: "Italic", text: linked.text });
        else runs.push({ type: "Italic", text: inner });
        i = close + 1;
        continue;
      }
    } else if (ch === "`") {
      const close = findCloser(s, i + 1, "`");
      if (close !== -1 && close > i + 1) {
        flush();
        runs.push({ type: "InlineText", text: s.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    } else if (ch === "!" && s[i + 1] === "[") {
      const parsed = parseBracketLink(s, i + 1);
      if (parsed) {
        flush();
        runs.push({ type: "InlineText", text: parsed.text });
        i = parsed.next;
        continue;
      }
    } else if (ch === "[") {
      const parsed = parseBracketLink(s, i);
      if (parsed) {
        flush();
        runs.push(parsed.node);
        i = parsed.next;
        continue;
      }
    }
    literal += ch ?? "";
    i += 1;
  }
  flush();
  return runs.map((run) => ({ ...run, text: decodeEntities(run.text) }));
}

function parseBracketLink(s: string, open: number): { node: InlineNode; text: string; next: number } | null {
  const closeBracket = findCloser(s, open + 1, "]");
  if (closeBracket === -1 || closeBracket === open + 1) return null;
  if (s[closeBracket + 1] !== "(") return null;
  const closeParen = findBalancedParen(s, closeBracket + 1);
  if (closeParen === -1) return null;
  const text = s.slice(open + 1, closeBracket);
  if (text.includes("[") || text.includes("]")) return null;
  const inner = s.slice(closeBracket + 2, closeParen).trim();
  const dest = inner.split(/\s+/)[0] ?? "";
  if (dest === "") return null;
  const next = closeParen + 1;
  if (!isSafeRichTextHref(dest)) return { node: { type: "InlineText", text }, text, next };
  return { node: { type: "Link", href: dest, text }, text, next };
}

/** Parse GFM-ish Markdown into a document. Unknown constructs become paragraphs. Never throws. */
export function fromMarkdown(md: unknown): RichTextDocument {
  try {
    if (typeof md !== "string") return emptyDocument();
    const lines = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(String.fromCharCode(0)).join("").split("\n");
    const blocks: Block[] = [];
    let para: string[] = [];
    let quote: string[] | null = null;
    let list: string[][] | null = null;
    let fence: string[] | null = null;

    const flushPara = () => {
      if (para.length > 0) {
        blocks.push({ type: "Paragraph", runs: parseInline(para.join("\n")) });
        para = [];
      }
    };
    const flushQuote = () => {
      if (quote !== null) {
        blocks.push({ type: "Quote", runs: parseInline(quote.join("\n")) });
        quote = null;
      }
    };
    const flushList = () => {
      if (list !== null) {
        const items = list.map((lines) => parseInline(lines.join("\n")));
        if (items.length > 0) blocks.push({ type: "BulletList", items });
        list = null;
      }
    };
    const flushAll = () => {
      flushPara();
      flushQuote();
      flushList();
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");
      const scan = line.replace(/^\s{0,3}/, "");

      if (fence !== null) {
        if (/^```/.test(scan)) {
          blocks.push({ type: "Paragraph", runs: [{ type: "InlineText", text: fence.join("\n") }] });
          fence = null;
        } else {
          fence.push(rawLine);
        }
        continue;
      }
      if (/^```/.test(scan)) {
        flushAll();
        fence = [];
        continue;
      }
      if (scan === "") {
        flushAll();
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(scan);
      if (heading?.[1] !== undefined) {
        flushAll();
        const level = heading[1].length;
        const content = heading[2] ?? "";
        if (level <= 3) {
          blocks.push({
            type: "Heading",
            level: level as 1 | 2 | 3,
            runs: parseInline(content),
          });
        } else {
          blocks.push({ type: "Paragraph", runs: parseInline(content) });
        }
        continue;
      }
      const quoteMatch = /^>\s?(.*)$/.exec(scan);
      if (quoteMatch) {
        flushPara();
        flushList();
        if (quote === null) quote = [];
        quote.push(quoteMatch[1] ?? "");
        continue;
      }
      const bullet = /^[-+*]\s+(.*)$/.exec(scan);
      if (bullet?.[1] !== undefined && bullet[1] !== "") {
        flushPara();
        flushQuote();
        if (list === null) list = [];
        list.push([bullet[1]]);
        continue;
      }
      if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(scan)) {
        flushAll();
        continue;
      }
      const ordered = /^\d{1,9}[.)]\s+(.*)$/.exec(scan);
      if (ordered?.[1] !== undefined && ordered[1] !== "") {
        flushQuote();
        flushList();
        para.push(ordered[1]);
        continue;
      }
      if (scan.startsWith("|")) {
        flushAll();
        const cells = scan
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim())
          .filter((cell) => cell !== "");
        para.push(cells.join(" "));
        continue;
      }
      flushQuote();
      flushList();
      para.push(scan);
    }
    if (fence !== null) {
      blocks.push({ type: "Paragraph", runs: [{ type: "InlineText", text: fence.join("\n") }] });
    }
    flushAll();
    return blocks.length > 0 ? { v: 1, blocks } : emptyDocument();
  } catch {
    return emptyDocument();
  }
}
