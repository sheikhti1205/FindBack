/**
 * A tiny cascade evaluator for Home's app-bar focus-ring rules.
 *
 * WHY THIS EXISTS: the previous contract test matched selector *text* in
 * `index.css`, so it could not see (a) a higher-specificity rule that removes
 * the ring, or (b) whether the ring still exists in an engine that cannot parse
 * `:has()`. jsdom cannot answer either question: it has no `:focus-visible` /
 * `:focus-within` matching and drops `@supports` blocks, so a DOM-based test
 * there would be a false positive.
 *
 * WHAT IT IS: a model, not a browser. It reads the real `index.css`, parses real
 * rule blocks (including `@supports` nesting), computes real selector
 * specificity, and resolves which `outline` declaration wins for the pill, the
 * input and the field's buttons in a given focus state, under a given engine
 * capability. Unknown selectors or at-rules that mention the field throw — a
 * future rule must be modelled explicitly rather than silently ignored.
 *
 * WHAT IT IS NOT: it does not model Tailwind utilities in `@layer utilities`
 * (they cannot set `outline` on the pill today — the app-wide rule is
 * unlayered) and it does not model paint. The rendered readback in the handoff
 * is the browser evidence for the modern path; this covers the branch a browser
 * on this machine cannot enter.
 */

export type RingEngine = { hasSelector: boolean };
export type FieldFocus = "none" | "input" | "button";
export type RingTarget = "pill" | "input" | "button";

export interface RingOutcome {
  /** Winning `outline` for the pill (`null` = no rule wins). */
  pill: string | null;
  /** Winning `outline-offset` for the pill. */
  pillOffset: string | null;
  /** Winning `outline` for the input. */
  input: string | null;
  /** Winning `outline` for the field's Close/Clear buttons. */
  button: string | null;
}

interface Declaration {
  prop: string;
  value: string;
}

interface Rule {
  atStack: string[];
  selector: string;
  declarations: Declaration[];
  order: number;
}

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  pseudos: Array<{ name: string; arg: string | null }>;
}

const FIELD_CLASS = "fb-home-search-field";

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced braces in CSS");
}

function parseDeclarations(body: string): Declaration[] {
  return body
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const colon = chunk.indexOf(":");
      if (colon === -1) throw new Error(`unparsed declaration: ${chunk}`);
      return {
        prop: chunk.slice(0, colon).trim().toLowerCase(),
        value: chunk.slice(colon + 1).trim(),
      };
    });
}

function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let order = 0;

  function walk(source: string, atStack: string[]): void {
    let cursor = 0;
    while (cursor < source.length) {
      const open = source.indexOf("{", cursor);
      if (open === -1) return;
      const header = source.slice(cursor, open).trim();
      const close = matchingBrace(source, open);
      const body = source.slice(open + 1, close);
      if (header.startsWith("@")) {
        walk(body, [...atStack, header]);
      } else {
        rules.push({ atStack, selector: header, declarations: parseDeclarations(body), order });
        order += 1;
      }
      cursor = close + 1;
    }
  }

  walk(stripComments(css), []);
  return rules;
}

function parseCompound(text: string): Compound {
  const compound: Compound = { tag: null, ids: [], classes: [], pseudos: [] };
  let i = 0;
  const readIdent = () => {
    let out = "";
    while (i < text.length && /[\w-]/.test(text[i] ?? "")) {
      out += text[i];
      i += 1;
    }
    return out;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === ".") {
      i += 1;
      compound.classes.push(readIdent());
    } else if (ch === "#") {
      i += 1;
      compound.ids.push(readIdent());
    } else if (ch === ":") {
      i += 1;
      if (text[i] === ":") i += 1; // pseudo-element: irrelevant here, still consume
      const name = readIdent();
      let arg: string | null = null;
      if (text[i] === "(") {
        const close = matchingParen(text, i);
        arg = text.slice(i + 1, close);
        i = close + 1;
      }
      compound.pseudos.push({ name, arg });
    } else if (ch === "*") {
      compound.tag = "*";
      i += 1;
    } else if (/[a-zA-Z]/.test(ch ?? "")) {
      compound.tag = readIdent().toLowerCase();
    } else {
      throw new Error(`unmodelled selector token "${ch}" in "${text}"`);
    }
  }
  return compound;
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced parentheses in "${text}"`);
}

function splitSelector(selector: string): string[] {
  if (selector.includes(">") || selector.includes("+") || selector.includes("~")) {
    throw new Error(`combinators are not modelled: "${selector}"`);
  }
  return selector.trim().split(/\s+/).filter(Boolean);
}

function isRingSelector(selector: string): boolean {
  return selector.includes(FIELD_CLASS) || selector.trim() === ":focus-visible";
}

/** `@supports` conditions this file may use. Anything else is a modelling gap. */
function supportsApplies(condition: string, engine: RingEngine): boolean {
  const normalised = condition.replace(/\s+/g, " ").trim();
  if (normalised === "@supports selector(:has(*))") return engine.hasSelector;
  if (normalised === "@supports not selector(:has(*))") return !engine.hasSelector;
  throw new Error(`unmodelled @supports condition: "${condition}"`);
}

/** Whether a selector's final compound targets the given element. */
function targetOf(compound: Compound): RingTarget | "focus-only" {
  if (compound.tag === "input") return "input";
  if (compound.tag === "button") return "button";
  if (compound.classes.includes(FIELD_CLASS)) return "pill";
  if (compound.classes.length === 0 && compound.tag === null) return "focus-only";
  throw new Error(`unmodelled selector target: ${JSON.stringify(compound)}`);
}

function compoundMatches(
  compound: Compound,
  target: RingTarget,
  state: FieldFocus,
  engine: RingEngine,
): boolean {
  const resolved = targetOf(compound);
  if (resolved === "focus-only") {
    // The app-wide `:focus-visible` rule applies to whatever currently has it.
    const [only] = compound.pseudos;
    if (compound.pseudos.length !== 1 || only?.name !== "focus-visible") {
      throw new Error(`unmodelled focus-only selector: ${JSON.stringify(compound)}`);
    }
    return state === target;
  }
  if (resolved !== target) return false;
  if (resolved === "pill" && !compound.classes.includes(FIELD_CLASS)) return false;

  for (const pseudo of compound.pseudos) {
    if (pseudo.name === "focus-within") {
      if (state === "none") return false;
    } else if (pseudo.name === "focus-visible" || pseudo.name === "focus") {
      if (state !== target) return false;
    } else if (pseudo.name === "has") {
      if (!engine.hasSelector) return false; // invalid selector: the browser drops the rule
      if (pseudo.arg === null) throw new Error(":has() without an argument");
      if (pseudo.arg.trim() === "*") continue;
      if (!compoundMatches(parseCompound(pseudo.arg.trim()), "input", state, engine)
        && !compoundMatches(parseCompound(pseudo.arg.trim()), "button", state, engine)) {
        return false;
      }
    } else {
      throw new Error(`unmodelled pseudo-class ":${pseudo.name}"`);
    }
  }
  return true;
}

function selectorMatches(
  selector: string,
  target: RingTarget,
  state: FieldFocus,
  engine: RingEngine,
): boolean {
  const parts = splitSelector(selector);
  const lastPart = parts[parts.length - 1];
  if (lastPart === undefined) return false;
  if (!compoundMatches(parseCompound(lastPart), target, state, engine)) return false;
  // Ancestors are only modelled as document roots: the rules this test owns are
  // unprefixed, and a prefixed override (`html .field…`) is exactly the bypass
  // the specificity test reproduces.
  for (const ancestor of parts.slice(0, -1)) {
    const compound = parseCompound(ancestor);
    const bare = compound.classes.length === 0 && compound.ids.length === 0;
    const rootLike =
      bare && (["html", "body", "*"].includes(compound.tag ?? "")
        || (compound.tag === null && compound.pseudos.length === 1
          && compound.pseudos[0]?.name === "root"));
    if (rootLike) continue;
    // The pill is the only ancestor modelled inside the field: `.field input`
    // / `.field button`.
    if (target !== "pill" && compound.classes.includes(FIELD_CLASS)
      && compoundMatches(compound, "pill", state, engine)) {
      continue;
    }
    throw new Error(`unmodelled ancestor selector "${ancestor}" in "${selector}"`);
  }
  return true;
}

function specificity(selector: string): [number, number, number] {
  let ids = 0;
  let classes = 0;
  let elements = 0;
  for (const part of splitSelector(selector)) {
    const compound = parseCompound(part);
    ids += compound.ids.length;
    classes += compound.classes.length;
    for (const pseudo of compound.pseudos) {
      if (pseudo.name === "has" && pseudo.arg) {
        const inner = specificity(pseudo.arg);
        ids += inner[0];
        classes += inner[1];
        elements += inner[2];
      } else {
        classes += 1;
      }
    }
    if (compound.tag && compound.tag !== "*") elements += 1;
  }
  return [ids, classes, elements];
}

function beats(
  a: { spec: [number, number, number]; order: number },
  b: { spec: [number, number, number]; order: number } | null,
): boolean {
  if (!b) return true;
  for (let i = 0; i < 3; i += 1) {
    const mine = a.spec[i] ?? 0;
    const theirs = b.spec[i] ?? 0;
    if (mine !== theirs) return mine > theirs;
  }
  return a.order > b.order;
}

function winner(
  rules: Rule[],
  target: RingTarget,
  state: FieldFocus,
  engine: RingEngine,
  property: string,
): string | null {
  let best: { spec: [number, number, number]; order: number; value: string } | null = null;
  for (const rule of rules) {
    if (!isRingSelector(rule.selector)) continue;
    let applies = true;
    for (const atRule of rule.atStack) {
      if (!atRule.startsWith("@supports")) {
        throw new Error(`home ring rules must not live in "${atRule}"`);
      }
      if (!supportsApplies(atRule, engine)) applies = false;
    }
    if (!applies) continue;
    if (!selectorMatches(rule.selector, target, state, engine)) continue;
    const declaration = [...rule.declarations].reverse().find((d) => d.prop === property);
    if (!declaration) continue;
    // This model ranks specificity and document order only. An `!important`
    // ring declaration outranks both, so pretending to resolve it would turn a
    // rule that *removes* the ring into a silent false pass (review
    // HOME-SCROLL-FIXFORWARD-R2 NIT-1).
    if (declaration.value.includes("!important")) {
      throw new Error(
        `home ring declaration "${property}" on "${rule.selector}" uses !important, which this cascade model cannot rank`,
      );
    }
    const candidate = { spec: specificity(rule.selector), order: rule.order, value: declaration.value };
    if (beats(candidate, best)) best = candidate;
  }
  return best ? best.value : null;
}

/**
 * Resolve the field's ring for one engine generation and one focus state.
 *
 * `state` is *which* element has keyboard focus: `"input"` (in the text field),
 * `"button"` (Close or Clear, which are interchangeable here), or `"none"`.
 */
export function ringOutcome(css: string, engine: RingEngine, state: FieldFocus): RingOutcome {
  const rules = parseRules(css);
  return {
    pill: winner(rules, "pill", state, engine, "outline"),
    pillOffset: winner(rules, "pill", state, engine, "outline-offset"),
    input: winner(rules, "input", state, engine, "outline"),
    button: winner(rules, "button", state, engine, "outline"),
  };
}
