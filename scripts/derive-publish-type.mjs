#!/usr/bin/env node
/**
 * Derive the GitHub Release publish type from a SemVer release tag.
 *
 * Every prerelease tag (-beta.*, -rc.*, -alpha, ...) publishes as a GitHub
 * PRE-RELEASE so it is never Latest/production. Plain stable (e.g. v1.0.0) →
 * normal release + stable title. Build metadata (+...) never implies
 * prerelease.
 *
 * Usage (consumed by the `publish` job in .github/workflows/release.yml):
 *   node scripts/derive-publish-type.mjs --tag v0.2.0-beta.1 --field title
 *   --field is one of: prerelease (true|false), prerelease-flag
 *   (--prerelease or empty), title, notes, json.
 *
 * A release may override the derived notes by committing
 * docs/release-notes/<tag>.md; the publish job prefers that file when present.
 *
 * Pure Node builtins.
 */

export function derivePublishType(tag) {
  const m = /^v(\d+\.\d+\.\d+)((?:-[0-9A-Za-z.-]+)?)((?:\+[0-9A-Za-z.-]+)?)$/.exec(tag ?? "");
  if (!m) throw new Error(`derive-publish-type: invalid release tag ${JSON.stringify(tag)} (want v<semver>[-prerelease][+build])`);
  const [, version, pre] = m;
  void version;
  if (pre) {
    return {
      prerelease: true,
      prereleaseFlag: "--prerelease",
      title: `FindBack ${tag} (pre-release)`,
      notes: "Pre-release signed beta. See release-manifest.json for versionCode, git SHA, and per-artifact checksums.",
    };
  }
  return {
    prerelease: false,
    prereleaseFlag: "",
    title: `FindBack ${tag}`,
    notes: "Stable release. See release-manifest.json for versionCode, git SHA, and per-artifact checksums.",
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const tagIdx = args.indexOf("--tag");
    const fieldIdx = args.indexOf("--field");
    if (tagIdx === -1 || !args[tagIdx + 1]) throw new Error("derive-publish-type: --tag <tag> is required");
    if (fieldIdx === -1 || !args[fieldIdx + 1]) {
      throw new Error("derive-publish-type: --field <prerelease|prerelease-flag|title|notes|json> is required");
    }
    const info = derivePublishType(args[tagIdx + 1]);
    const field = args[fieldIdx + 1];
    if (field === "prerelease") console.log(info.prerelease ? "true" : "false");
    else if (field === "prerelease-flag") console.log(info.prereleaseFlag);
    else if (field === "title") console.log(info.title);
    else if (field === "notes") console.log(info.notes);
    else if (field === "json") console.log(JSON.stringify(info));
    else throw new Error(`derive-publish-type: unknown field ${JSON.stringify(field)}`);
  } catch (error) {
    console.error(
      error.message.startsWith("derive-publish-type:")
        ? error.message
        : `derive-publish-type: ${error.message}`,
    );
    process.exit(1);
  }
}
