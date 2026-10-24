#!/usr/bin/env node
// Link validation script for FindBack docs and README
// Usage: node scripts/check-links.mjs [directory]
// Checks all markdown links for broken internal references.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';

const root = process.argv[2] || '.';
const broken = [];

function findMarkdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

function checkLinks(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const [, text, url] = match;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      continue; // Skip external links
    }
    if (url.startsWith('#')) {
      continue; // Skip anchor links
    }
    // Resolve relative path
    const dir = dirname(filePath);
    const target = resolve(dir, url.split('#')[0]);
    try {
      statSync(target);
    } catch {
      broken.push({ file: filePath, url, text });
    }
  }
}

const files = findMarkdownFiles(root);
for (const f of files) {
  checkLinks(f);
}

if (broken.length === 0) {
  console.log(`✅ All internal links valid (${files.length} files checked)`);
  process.exit(0);
} else {
  console.log(`❌ Found ${broken.length} broken link(s):`);
  for (const b of broken) {
    console.log(`  ${b.file}: [${b.text}](${b.url})`);
  }
  process.exit(1);
}