// JVM contract tests consume the actual TypeScript SQL, not hand-copied DDL.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import ts from 'typescript';

const source = await readFile(new URL('../apps/mobile/src/services/messaging/sqliteSchema.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const schema = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const rows = [];
for (const group of ['MESSAGING_SQLITE_SCHEMA', 'MESSAGING_SQLITE_PRAGMAS',
  'MESSAGING_SQLITE_DURABILITY_CHECKS', 'MESSAGING_SQLITE_STATEMENTS']) {
  for (const [key, value] of Object.entries(schema[group])) {
    for (const [index, sql] of (Array.isArray(value) ? value : [value]).entries()) {
      if (typeof sql !== 'string') throw new Error(`Unexpected SQL fixture value: ${group}.${key}`);
      // This is an adapter substitution marker, never a dispatched SQL comment.
      rows.push({ name: `${group}.${key}.${index}`, sql: sql.replace('/*exclude*/', '') });
      if (key === 'nextOutbox') rows.push({ name: `${group}.${key}.excluded`,
        sql: sql.replace('/*exclude*/', 'and o.message_id not in (?,?)') });
    }
  }
}
const output = process.argv[2];
if (!output) throw new Error('Messaging SQL fixture output path required');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(rows));
console.log(`Exported ${rows.length} actual messaging SQL statements`);
