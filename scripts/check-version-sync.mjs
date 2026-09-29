#!/usr/bin/env node
/**
 * Version-sync assertions for the release pipeline.
 *
 * Read-only: never bumps, edits, or publishes any version. Fails closed
 * BEFORE any signing step when:
 *   * root package.json version != apps/mobile/package.json version
 *   * on a v* tag build: tag != "v" + mobile version, exactly
 *   * on a v* tag build: checkout commit != tagged commit
 *   * the working tree is dirty (never build a release from a dirty tree)
 *
 * Usage:
 *   node scripts/check-version-sync.mjs                    # equality + clean tree
 *   node scripts/check-version-sync.mjs --tag v0.1.0-beta.1 # + tag assertions
 *   node scripts/check-version-sync.mjs --ref refs/tags/vX  # GitHub ref form
 *
 * Pure Node builtins. Test suite: scripts/check-version-sync.test.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * Pure assertion core. Returns a list of failure strings (empty = pass).
 * All inputs are plain data so this is unit-testable without git or files.
 */
export function assertSync({ rootVersion, mobileVersion, tag, headSha, tagSha, dirtyFiles }) {
  const errors = [];
  if (!rootVersion) errors.push("root package.json has no version");
  if (!mobileVersion) errors.push("apps/mobile/package.json has no version");
  if (rootVersion && mobileVersion && rootVersion !== mobileVersion) {
    errors.push(
      `version mismatch: root package.json is ${rootVersion} but apps/mobile/package.json is ${mobileVersion}`,
    );
  }
  if (tag) {
    const expected = `v${mobileVersion}`;
    if (tag !== expected) {
      errors.push(`tag/version mismatch: tag is ${tag} but mobile version requires ${expected} exactly`);
    }
    if (headSha && tagSha && headSha !== tagSha) {
      errors.push(
        `tag points at ${tagSha} but the checkout is ${headSha} — release must build the exact tagged commit`,
      );
    }
  }
  if (dirtyFiles && dirtyFiles.length > 0) {
    errors.push(`dirty working tree (${dirtyFiles.length} file(s)) — never build a release from a dirty tree`);
  }
  return errors;
}

function readVersion(relativePath) {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8"));
  return pkg.version;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", cwd: REPO_ROOT }).trim();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    let tag = null;
    const tagIdx = args.indexOf("--tag");
    const refIdx = args.indexOf("--ref");
    if (tagIdx !== -1) {
      tag = args[tagIdx + 1];
      if (!tag) throw new Error("check-version-sync: --tag requires a value");
    } else if (refIdx !== -1) {
      const ref = args[refIdx + 1];
      if (!ref) throw new Error("check-version-sync: --ref requires a value");
      const match = /^refs\/tags\/(v.+)$/.exec(ref.trim());
      if (match) tag = match[1];
    } else if (process.env.GITHUB_REF?.startsWith("refs/tags/v")) {
      tag = process.env.GITHUB_REF.replace("refs/tags/", "");
    }

    const rootVersion = readVersion("package.json");
    const mobileVersion = readVersion("apps/mobile/package.json");
    const headSha = git(["rev-parse", "HEAD"]);
    const tagSha = tag ? git(["rev-list", "-n", "1", tag]) : null;
    const porcelain = git(["status", "--porcelain"]);
    const dirtyFiles = porcelain ? porcelain.split("\n").filter(Boolean) : [];

    const errors = assertSync({ rootVersion, mobileVersion, tag, headSha, tagSha, dirtyFiles });
    if (errors.length > 0) {
      for (const error of errors) console.error(`check-version-sync: FAIL: ${error}`);
      process.exit(1);
    }
    console.log(
      `check-version-sync: PASS (root=${rootVersion} mobile=${mobileVersion}` +
        (tag ? ` tag=${tag} sha=${headSha}` : " untagged") +
        ")",
    );
  } catch (error) {
    console.error(
      error.message.startsWith("check-version-sync:") ? error.message : `check-version-sync: ${error.message}`,
    );
    process.exit(1);
  }
}
