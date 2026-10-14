#!/usr/bin/env node
/**
 * TDD RED-first tests for scripts/check-sentry-config.mjs (S1).
 *
 * Run: `node --test scripts/check-sentry-config.test.mjs` from the repo root.
 * Uses the root TypeScript parser for source hygiene. Never prints key material.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  validateSentryDsn,
  loadSentryFileEnv,
  validateSentryTraceRate,
  loadTraceRateFileEnv,
  checkEffectiveTraceRate,
  SENTRY_DSN_PATTERN_HINT,
} from "./check-sentry-config.mjs";

const VALID = "https://abc123def456@o123456.ingest.sentry.io/7890123";
const UPLOAD_TOKEN_NAME = ["SENTRY", "AUTH", "TOKEN"].join("_");
const CLIENT_TOKEN_NAME = ["VITE", UPLOAD_TOKEN_NAME].join("_");
const isHygieneFile = (file) => /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|gradle|java|kt|xml|yml|yaml|env|properties|toml)$|(?:^|\/)\.env(?:\.[^/]+)?$/.test(file);

function tokenHygieneViolations(text, file) {
  const hits = new Set();
  const forbiddenValue = (value) => value.trim() !== "" && !/^(<.*>|\[.*\])$/.test(value.trim());
  if (/\.(?:[cm]?js|mjs|tsx?|jsonc?)$/.test(file)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      /\.jsonc?$/.test(file) ? ts.ScriptKind.JSON : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const literal = (node) => {
      if (!node) return undefined;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return literal(node.expression);
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return node.text;
      if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
      if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
      return undefined;
    };
    const nameOf = (node) => {
      if (!node) return undefined;
      if (ts.isComputedPropertyName(node)) return literal(node.expression);
      if (ts.isPropertyAccessExpression(node)) return node.name.text;
      if (ts.isElementAccessExpression(node)) return literal(node.argumentExpression);
      return ts.isIdentifier(node) ? node.text : literal(node);
    };
    const assignment = (name, value) => {
      if (name === CLIENT_TOKEN_NAME) hits.add("client-token");
      const raw = literal(value);
      if (name === UPLOAD_TOKEN_NAME && raw !== undefined && forbiddenValue(raw)) hits.add("literal-token");
    };
    const forbiddenIndex = (node) => {
      if (ts.isLiteralTypeNode(node) && literal(node.literal) === CLIENT_TOKEN_NAME) return true;
      return ts.forEachChild(node, forbiddenIndex) === true;
    };
    const visit = (node) => {
      // Inert diagnostic strings and negative fixture source are not env
      // accesses. Inspect syntax, never execute expressions or read values.
      if (ts.isIdentifier(node) && node.text === CLIENT_TOKEN_NAME) hits.add("client-token");
      if (ts.isElementAccessExpression(node) && nameOf(node) === CLIENT_TOKEN_NAME) hits.add("client-token");
      if (node.name && nameOf(node.name) === CLIENT_TOKEN_NAME) hits.add("client-token");
      if (node.propertyName && nameOf(node.propertyName) === CLIENT_TOKEN_NAME) hits.add("client-token");
      if (ts.isIndexedAccessTypeNode(node) && forbiddenIndex(node.indexType)) hits.add("client-token");
      if (ts.isBindingElement(node)) assignment(nameOf(node.propertyName ?? node.name), node.initializer);
      if (node.name && "initializer" in node) assignment(nameOf(node.name), node.initializer);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignment(nameOf(node.left), node.right);
      ts.forEachChild(node, visit);
    };
    visit(source);
  } else {
    // Configuration surfaces have actual key/value assignments. Secret-store
    // references and documented placeholders are not embedded credentials.
    const pattern = new RegExp(`(?<!\\$\\{)(["']?)\\b(${CLIENT_TOKEN_NAME}|${UPLOAD_TOKEN_NAME})\\1\\s*[:=](?!=)\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#;,]+))`, "g");
    const clientKey = new RegExp(`(["']?)\\b${CLIENT_TOKEN_NAME}\\1\\s*[:=](?!=)`);
    const config = text.split(/\r?\n/).filter((line) => !/^\s*(?:#|\/\/|\*)/.test(line)).join("\n");
    if (clientKey.test(config)) hits.add("client-token");
    for (const match of config.matchAll(pattern)) {
        const value = match[3] ?? match[4] ?? match[5] ?? "";
        if (match[2] === CLIENT_TOKEN_NAME) hits.add("client-token");
        else if (!value.startsWith("${{") && forbiddenValue(value)) hits.add("literal-token");
    }
  }
  return [...hits];
}

describe("upload-token hygiene classifications", () => {
  it("does not confuse diagnostics, comments, equality, or dynamic fixture keys with exposed secrets", () => {
    for (const text of [
      `// no ${CLIENT_TOKEN_NAME} in bundles`,
      `if (text.includes("${CLIENT_TOKEN_NAME}")) throw new Error("forbidden");`,
      `const negativeFixture = "# ${CLIENT_TOKEN_NAME} must never exist";`,
      `const present = typeof source.${UPLOAD_TOKEN_NAME} === "string";`,
      `const env = { ${UPLOAD_TOKEN_NAME}: tokenFromSecretStore };`,
    ]) assert.deepEqual(tokenHygieneViolations(text, "probe.mjs"), []);
    for (const text of [
      `${UPLOAD_TOKEN_NAME}: \u0024{{ secrets.UPLOAD }}`,
      `[ -n "\u0024{${UPLOAD_TOKEN_NAME}:-}" ] || exit 1`,
    ]) assert.deepEqual(tokenHygieneViolations(text, "workflow.yml"), []);
  });

  it("still rejects literal upload credentials and actual client-prefixed accesses or configuration", () => {
    for (const [file, text] of [
      ["probe.mjs", `process.env.${UPLOAD_TOKEN_NAME} = "synthetic-fixture";`],
      ["probe.mjs", `const env = { ${UPLOAD_TOKEN_NAME}: "synthetic-fixture" };`],
      ["probe.json", `{ "${UPLOAD_TOKEN_NAME}": "synthetic-fixture" }`],
      [".env.production", `${UPLOAD_TOKEN_NAME}=synthetic-fixture`],
      ["workflow.yml", `${UPLOAD_TOKEN_NAME}: synthetic-fixture`],
      ["probe.ts", `const token = import.meta.env.${CLIENT_TOKEN_NAME};`],
      ["probe.ts", `const token = import.meta.env["${CLIENT_TOKEN_NAME}"];`],
      [".env.production", `${CLIENT_TOKEN_NAME}=synthetic-fixture`],
      ["workflow.yml", `${CLIENT_TOKEN_NAME}: \u0024{{ secrets.UPLOAD }}`],
      ["workflow.yml", `"${CLIENT_TOKEN_NAME}": \u0024{{ secrets.UPLOAD }}`],
      ["config.toml", `'${CLIENT_TOKEN_NAME}' = "synthetic-fixture"`],
      ["probe.ts", `const { "${CLIENT_TOKEN_NAME}": token } = import.meta.env;`],
      ["probe.ts", `class Config { "${CLIENT_TOKEN_NAME}" = tokenFromSecretStore; }`],
      ["probe.ts", `class Config { ${UPLOAD_TOKEN_NAME} = "synthetic-fixture"; }`],
      ["probe.ts", `function upload(${UPLOAD_TOKEN_NAME} = "synthetic-fixture") {}`],
      ["probe.ts", `const ${UPLOAD_TOKEN_NAME} = "$synthetic-fixture";`],
      ["workflow.yml", `${CLIENT_TOKEN_NAME}:\n  \u0024{{ secrets.UPLOAD }}`],
      ["workflow.yml", `${UPLOAD_TOKEN_NAME}:\n  "synthetic-fixture"`],
      ["probe.ts", `const { uploadToken: ${UPLOAD_TOKEN_NAME} = "synthetic-fixture" } = config;`],
      ["probe.ts", `enum Config { ${UPLOAD_TOKEN_NAME} = "synthetic-fixture" }`],
      ["probe.ts", `type UploadToken = ImportMetaEnv["${CLIENT_TOKEN_NAME}"];`],
      ["probe.ts", `import { "${CLIENT_TOKEN_NAME}" as token } from "./env";`],
      ["probe.ts", `const ${UPLOAD_TOKEN_NAME} = "synthetic-fixture" as const;`],
      ["probe.ts", `const ${UPLOAD_TOKEN_NAME} = "synthetic-fixture" satisfies string;`],
      ["probe.ts", `const ${UPLOAD_TOKEN_NAME} = ("synthetic-fixture")!;`],
      ["probe.ts", `const ${UPLOAD_TOKEN_NAME} = 123;`],
      ["probe.ts", `type Token = ImportMetaEnv[("${CLIENT_TOKEN_NAME}")];`],
      ["probe.ts", `type Token = ImportMetaEnv["${CLIENT_TOKEN_NAME}" | "MODE"];`],
    ]) assert.ok(tokenHygieneViolations(text, file).length > 0, `must reject ${file}`);
  });

  it("scans legacy env extensions as well as Vite mode-specific env files", () => {
    for (const file of ["config.env", ".env", "apps/mobile/.env.production", "config.jsonc"])
      assert.equal(isHygieneFile(file), true);
  });
});

describe("validateSentryDsn", () => {
  it("accepts a well-formed https DSN and reports shapes only", () => {
    const result = validateSentryDsn(VALID);
    assert.equal(result.ok, true);
    assert.equal(result.host, "o123456.ingest.sentry.io");
    assert.equal(result.projectId, "7890123");
    assert.ok(result.keyLen > 0);
    // The key itself must never be echoed back.
    assert.ok(!JSON.stringify(result).includes("abc123def456"));
  });

  it("exposes the expected DSN shape hint", () => {
    assert.match(SENTRY_DSN_PATTERN_HINT, /https:\/\//);
  });

  it("rejects missing and empty values", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const result = validateSentryDsn(raw);
      assert.equal(result.ok, false, `expected reject: ${String(raw)}`);
      assert.equal(result.reason, "missing");
    }
  });

  it("rejects non-https and non-URL values", () => {
    for (const raw of [
      "not-a-url",
      "http://abc123@o123.ingest.sentry.io/456",
      "ftp://abc123@o123.ingest.sentry.io/456",
      "//abc123@o123.ingest.sentry.io/456",
    ]) {
      const result = validateSentryDsn(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "malformed");
    }
  });

  it("rejects DSNs with missing key, host, or project id", () => {
    for (const raw of [
      "https://@o123.ingest.sentry.io/456",
      "https:///456",
      "https://abc123@/456",
      "https://abc123@o123.ingest.sentry.io/",
      "https://abc123@o123.ingest.sentry.io",
    ]) {
      const result = validateSentryDsn(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
    }
  });

  it("rejects placeholder values", () => {
    for (const raw of [
      "https://changeme@o123.ingest.sentry.io/456",
      "https://example@o123.ingest.sentry.io/456",
      "https://abc123@example.com/456",
      "https://abc123@changeme/456",
      "https://test@o123.ingest.sentry.io/456",
      "https://abc123@o123.ingest.sentry.io/example",
    ]) {
      const result = validateSentryDsn(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "placeholder");
    }
  });
});

describe("loadSentryFileEnv (same source Vite embeds)", () => {
  it("reads VITE_SENTRY_DSN from the mobile env dir like import.meta.env does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-env-"));
    try {
      await writeFile(join(dir, ".env.production"), `VITE_SENTRY_DSN=${VALID}\n`);
      assert.equal(loadSentryFileEnv("production", dir), VALID);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns undefined when no env file provides a DSN", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-env-"));
    const prev = process.env.VITE_SENTRY_DSN;
    delete process.env.VITE_SENTRY_DSN;
    try {
      assert.equal(loadSentryFileEnv("production", dir), undefined);
    } finally {
      if (prev !== undefined) process.env.VITE_SENTRY_DSN = prev;
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("prefers exported shell values over env files (Vite precedence)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-env-"));
    const prev = process.env.VITE_SENTRY_DSN;
    await writeFile(join(dir, ".env.production"), `VITE_SENTRY_DSN=${VALID}\n`);
    process.env.VITE_SENTRY_DSN = "https://shellkey@o9.ingest.sentry.io/99";
    try {
      assert.equal(
        loadSentryFileEnv("production", dir),
        "https://shellkey@o9.ingest.sentry.io/99",
      );
    } finally {
      if (prev === undefined) delete process.env.VITE_SENTRY_DSN;
      else process.env.VITE_SENTRY_DSN = prev;
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("trace-rate validation (canonical build-context owner)", () => {
  it("defaults to the code-conservative 0.1 when empty (never 1.0 in code)", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const result = validateSentryTraceRate(raw);
      assert.equal(result.ok, true);
      assert.equal(result.rate, 0.1);
      assert.notEqual(result.rate, 1.0, "maximum comes from env, never code");
    }
  });

  it("accepts explicit 0..1 values, including the runbook maximum 1.0", () => {
    assert.deepEqual(validateSentryTraceRate("1.0"), { ok: true, rate: 1, source: "explicit" });
    assert.deepEqual(validateSentryTraceRate("0"), { ok: true, rate: 0, source: "explicit" });
  });

  it("rejects NaN and out-of-range values fail-closed", () => {
    for (const raw of ["abc", "NaN"]) {
      const result = validateSentryTraceRate(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "nan");
    }
    for (const raw of ["-0.1", "1.5"]) {
      const result = validateSentryTraceRate(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "out-of-range");
    }
  });

  it("loads VITE_SENTRY_TRACES_SAMPLE_RATE from the mobile env dir like Vite embeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-rate-"));
    const prev = process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
    delete process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
    try {
      await writeFile(join(dir, ".env.production"), "VITE_SENTRY_TRACES_SAMPLE_RATE=0.5\n");
      assert.equal(loadTraceRateFileEnv("production", dir), "0.5");
      assert.deepEqual(checkEffectiveTraceRate({ mode: "production", mobileDir: dir }), {
        ok: true,
        rate: 0.5,
        source: "explicit",
      });
    } finally {
      if (prev === undefined) delete process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
      else process.env.VITE_SENTRY_TRACES_SAMPLE_RATE = prev;
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to the 0.1 default when no env file provides a rate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-rate-"));
    const prev = process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
    delete process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
    try {
      assert.equal(loadTraceRateFileEnv("production", dir), undefined);
      const result = checkEffectiveTraceRate({ mode: "production", mobileDir: dir });
      assert.equal(result.ok, true);
      assert.equal(result.rate, 0.1);
    } finally {
      if (prev === undefined) delete process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
      else process.env.VITE_SENTRY_TRACES_SAMPLE_RATE = prev;
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("SENTRY_AUTH_TOKEN never appears as a value in repo files", () => {
  it("no tracked file assigns SENTRY_AUTH_TOKEN (comments/docs allowed)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "..");
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const hits = [];
    for (const file of files) {
      if (/(^|\/)(node_modules|\.git|dist|build|\.gradle)\//.test(file)) continue;
      if (!isHygieneFile(file))
        continue;
      let text;
      try {
        text = readFileSync(resolve(root, file), "utf8");
      } catch {
        continue;
      }
      for (const violation of tokenHygieneViolations(text, file)) hits.push(`${file}: ${violation}`);
    }
    assert.deepEqual(hits, []);
  });
});
