#!/usr/bin/env node
// Migration verification script
// Checks: all migrations have commit; at end; schema version matches latest migration; no trailing junk
// Usage: node scripts/verify-migrations.mjs

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const migrationsDir = 'supabase/migrations';
const files = readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

console.log(`Found ${files.length} migration files`);

let errors = 0;
let latestMigration = '';

for (const f of files) {
  const content = readFileSync(join(migrationsDir, f), 'utf-8');
  const ts = f.split('_')[0];
  
  // Check for trailing junk (lines after commit;)
  const lines = content.trim().split('\n');
  // Find last non-comment, non-empty line
  let lastCodeLine = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l && !l.startsWith('--')) { lastCodeLine = l; break; }
  }
  if (lastCodeLine !== 'commit;' && lastCodeLine !== 'COMMIT;' && !lastCodeLine.endsWith(';')) {
    console.error(`  ❌ ${f}: trailing junk: "${lastCodeLine}"`);
    errors++;
  }
  
  // Check for begin/commit pairing
  const beginCount = (content.match(/\bbegin;/gi) || []).length;
  const commitCount = (content.match(/\bcommit;/gi) || []).length;
  if (beginCount !== commitCount) {
    console.error(`  ❌ ${f}: begin/commit mismatch (${beginCount}/${commitCount})`);
    errors++;
  }
  
  latestMigration = ts;
}

// Check schema version
const caps = readFileSync('apps/mobile/src/services/appCapabilities.ts', 'utf-8');
const versionMatch = caps.match(/BACKEND_SCHEMA_VERSION\s*=\s*"([^"]+)"/);
const schemaVersion = versionMatch ? versionMatch[1] : null;

if (schemaVersion !== latestMigration) {
  console.error(`  ❌ Schema version mismatch: appCapabilities=${schemaVersion}, latest migration=${latestMigration}`);
  errors++;
} else {
  console.log(`  ✅ Schema version matches latest migration: ${schemaVersion}`);
}

if (errors === 0) {
  console.log(`\n✅ All ${files.length} migrations verified. Latest: ${latestMigration}`);
  process.exit(0);
} else {
  console.log(`\n❌ Found ${errors} error(s)`);
  process.exit(1);
}