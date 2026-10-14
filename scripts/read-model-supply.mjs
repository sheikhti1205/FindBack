import ts from "typescript";
import { readFileSync } from "node:fs";

/** Read literal manifest arguments only; no catalogue code or weights execute. */
export function parseSupplyCandidates(source) {
  const ast = ts.createSourceFile("modelSupply.ts", source, ts.ScriptTarget.Latest, true);
  let entries;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === "SUPPLY_CANDIDATES");
    if (declaration && ts.isArrayLiteralExpression(declaration.initializer)) entries = declaration.initializer.elements;
  }
  if (!entries?.length) throw new Error("Missing literal supply catalogue");
  function literal(node, kind) {
    if (kind === "string" && node && ts.isStringLiteral(node)) return node.text;
    if (kind === "number" && node && ts.isNumericLiteral(node) && Number.isSafeInteger(Number(node.text))) return Number(node.text);
    throw new Error("Supply manifest argument must be a literal");
  }
  function call(node, name, min, max) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== name || node.arguments.length < min || node.arguments.length > max) throw new Error("Unsupported supply manifest expression");
    return node.arguments;
  }
  return entries.map((entry) => {
    const a = call(entry, "candidate", 8, 10);
    const d = { modelId: literal(a[0], "string"), displayName: literal(a[1], "string"), upstreamRepo: literal(a[2], "string"), revision: literal(a[3], "string"), fileName: literal(a[4], "string"), bytes: literal(a[5], "number"), sha256: literal(a[6], "string"), minRamMb: literal(a[7], "number"), vision: false };
    if (a[8]) {
      if (![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(a[8].kind)) throw new Error("Modality must be literal");
      d.vision = a[8].kind === ts.SyntaxKind.TrueKeyword;
    }
    if (a[9]) {
      const p = call(a[9], "artifact", 5, 5);
      d.companions = [{ upstreamRepo: literal(p[0], "string"), revision: literal(p[1], "string"), fileName: literal(p[2], "string"), bytes: literal(p[3], "number"), sha256: literal(p[4], "string") }];
    }
    return d;
  });
}

export function readSupplyCandidates() {
  return parseSupplyCandidates(readFileSync(new URL("../apps/mobile/src/services/ai/modelSupply.ts", import.meta.url), "utf8"));
}
