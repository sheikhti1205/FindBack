#!/usr/bin/env bash
# Per-APK release verification for EVERY split APK (+ the AAB signer check).
#
# For each APK in --apk-dir: apksigner signature, exact
# ANDROID_SIGNING_CERT_SHA256 fingerprint match (identical cert across ALL
# variants — a CN-only check is insufficient), app id / versionName /
# versionCode / SDK levels via aapt, expected native ABI contents, strict
# secret scan, and baked Supabase/Sentry config. Any failure blocks the
# release (set -euo pipefail; called as a CI step).
#
# The AAB is verified to carry the same signing certificate via keytool.
#
# Required env: ANDROID_SIGNING_CERT_SHA256 (hex or colon-separated hex),
#   EXPECTED_APP_ID, EXPECTED_VERSION_NAME, EXPECTED_VERSION_CODE.
# Never prints fingerprints or key material: match/mismatch only, with
# lengths on failure.
#
# Usage:
#   scripts/verify-release-apks.sh --apk-dir <dir> [--aab <file>]
set -euo pipefail

APK_DIR=""
AAB=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk-dir) APK_DIR="$2"; shift 2 ;;
    --aab) AAB="$2"; shift 2 ;;
    *) echo "verify-release-apks: unknown arg $1 (expected --apk-dir DIR [--aab FILE])" >&2; exit 1 ;;
  esac
done

[[ -n "$APK_DIR" ]] || { echo "verify-release-apks: --apk-dir is required" >&2; exit 1; }
[[ -d "$APK_DIR" ]] || { echo "verify-release-apks: no such dir $APK_DIR" >&2; exit 1; }
[[ -n "${ANDROID_SIGNING_CERT_SHA256:-}" ]] || { echo "verify-release-apks: ANDROID_SIGNING_CERT_SHA256 is empty" >&2; exit 1; }
[[ -n "${EXPECTED_APP_ID:-}" ]] || { echo "verify-release-apks: EXPECTED_APP_ID is empty" >&2; exit 1; }
[[ -n "${EXPECTED_VERSION_NAME:-}" ]] || { echo "verify-release-apks: EXPECTED_VERSION_NAME is empty" >&2; exit 1; }
[[ -n "${EXPECTED_VERSION_CODE:-}" ]] || { echo "verify-release-apks: EXPECTED_VERSION_CODE is empty" >&2; exit 1; }

norm_fp() { tr -d ' :\t\r\n' <<<"$1" | tr '[:lower:]' '[:upper:]'; }
EXPECTED_FP="$(norm_fp "$ANDROID_SIGNING_CERT_SHA256")"
[[ -n "$EXPECTED_FP" ]] || { echo "verify-release-apks: fingerprint normalizes to empty" >&2; exit 1; }

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -n "$SDK" ]] || { echo "verify-release-apks: no Android SDK (ANDROID_HOME/ANDROID_SDK_ROOT empty)" >&2; exit 1; }
APKSIGNER="$(find "$SDK/build-tools" -maxdepth 2 -name apksigner -type f | sort | tail -1)"
[[ -n "$APKSIGNER" ]] || { echo "verify-release-apks: apksigner not found under $SDK/build-tools" >&2; exit 1; }
AAPT="$(find "$SDK/build-tools" -maxdepth 2 -name aapt -type f | sort | tail -1)"
[[ -n "$AAPT" ]] || { echo "verify-release-apks: aapt not found under $SDK/build-tools" >&2; exit 1; }
echo "verify-release-apks: using $(basename "$APKSIGNER") + aapt from $SDK"

# SDK levels are DERIVED from variables.gradle, never duplicated here.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_SDK="$(grep -E '^\s*minSdkVersion' "$REPO_ROOT/apps/mobile/android/variables.gradle" | grep -oE '[0-9]+')"
TARGET_SDK="$(grep -E '^\s*targetSdkVersion' "$REPO_ROOT/apps/mobile/android/variables.gradle" | grep -oE '[0-9]+')"
[[ -n "$MIN_SDK" && -n "$TARGET_SDK" ]] || { echo "verify-release-apks: cannot derive SDK levels from variables.gradle" >&2; exit 1; }

mapfile -t APKS < <(find "$APK_DIR" -maxdepth 1 -name '*.apk' | sort)
[[ "${#APKS[@]}" -gt 0 ]] || { echo "verify-release-apks: no APKs in $APK_DIR" >&2; exit 1; }
echo "verify-release-apks: ${#APKS[@]} APK variant(s) to verify"

FIRST_FP=""
for APK in "${APKS[@]}"; do
  NAME="$(basename "$APK")"
  echo "--- $NAME ---"

  # 1. Signature + exact fingerprint pin (digests redacted in logs).
  SIG_OUT="$("$APKSIGNER" verify --verbose --print-certs "$APK" | sed -E 's/(digest:).*/\1 <redacted>/')"
  echo "$SIG_OUT" | grep -q 'Verified using v2 scheme.*true' || { echo "verify-release-apks: FAIL $NAME: V2 signature missing" >&2; exit 1; }
  RAW_FP="$(echo "$SIG_OUT" | grep -oE 'SHA-256 digest: [0-9a-fA-F:]+' | head -1 | sed 's/.*: //')"
  [[ -n "$RAW_FP" ]] || { echo "verify-release-apks: FAIL $NAME: no SHA-256 digest in apksigner output" >&2; exit 1; }
  GOT_FP="$(norm_fp "$RAW_FP")"
  [[ "$GOT_FP" == "$EXPECTED_FP" ]] || {
    echo "verify-release-apks: FAIL $NAME: signing fingerprint mismatch (expected_len=${#EXPECTED_FP} got_len=${#GOT_FP})" >&2
    exit 1
  }
  if [[ -z "$FIRST_FP" ]]; then
    FIRST_FP="$GOT_FP"
  elif [[ "$GOT_FP" != "$FIRST_FP" ]]; then
    echo "verify-release-apks: FAIL $NAME: certificate differs from sibling variants" >&2
    exit 1
  fi
  echo "verify-release-apks: $NAME signature OK (V2, pinned fingerprint match)"

  # 2. App id / versionName / versionCode / SDK levels.
  BADGING="$("$AAPT" dump badging "$APK")"
  PKG="$(echo "$BADGING" | grep -oE "package: name='[^']+'" | head -1)"
  [[ "$PKG" == "package: name='$EXPECTED_APP_ID'" ]] || { echo "verify-release-apks: FAIL $NAME: app id $PKG != $EXPECTED_APP_ID" >&2; exit 1; }
  echo "$BADGING" | grep -q "versionCode='$EXPECTED_VERSION_CODE'" || { echo "verify-release-apks: FAIL $NAME: versionCode mismatch (expected $EXPECTED_VERSION_CODE)" >&2; exit 1; }
  echo "$BADGING" | grep -q "versionName='$EXPECTED_VERSION_NAME'" || { echo "verify-release-apks: FAIL $NAME: versionName mismatch (expected $EXPECTED_VERSION_NAME)" >&2; exit 1; }
  echo "$BADGING" | grep -q "sdkVersion:'$MIN_SDK'" || { echo "verify-release-apks: FAIL $NAME: minSdk mismatch (expected $MIN_SDK)" >&2; exit 1; }
  echo "$BADGING" | grep -q "targetSdkVersion:'$TARGET_SDK'" || { echo "verify-release-apks: FAIL $NAME: targetSdk mismatch (expected $TARGET_SDK)" >&2; exit 1; }
  echo "verify-release-apks: $NAME identity OK (id, versionName, versionCode, sdk $MIN_SDK->$TARGET_SDK)"

  # 3. ABI contents: per-split APK carries its ABI; universal carries all.
  LIBS="$(unzip -Z1 "$APK" | grep -E '^lib/[^/]+/' | cut -d/ -f2 | sort -u | tr '\n' ' ')"
  case "$NAME" in
    *arm64-v8a*) WANT="arm64-v8a " ;;
    *armeabi-v7a*) WANT="armeabi-v7a " ;;
    *x86_64*) WANT="x86_64 " ;;
    *universal*) WANT="arm64-v8a armeabi-v7a x86_64 " ;;
    *) echo "verify-release-apks: FAIL $NAME: unexpected APK name (want an ABI or universal split)" >&2; exit 1 ;;
  esac
  for ABI in $WANT; do
    [[ "$LIBS" == *"$ABI"* ]] || { echo "verify-release-apks: FAIL $NAME: native lib for $ABI missing (has: $LIBS)" >&2; exit 1; }
  done
  # No unexpected ABIs (e.g. 32-bit x86, mips) may sneak in.
  for ABI in $LIBS; do
    [[ "arm64-v8a armeabi-v7a x86_64 " == *"$ABI"* ]] || { echo "verify-release-apks: FAIL $NAME: unexpected ABI lib $ABI" >&2; exit 1; }
  done
  echo "verify-release-apks: $NAME ABI contents OK (libs: $LIBS)"

  # 4. Strict secret scan (DEX/assets, forbidden weights, JNI, 16 KiB).
  node "$REPO_ROOT/scripts/scan-apk.mjs" --strict "$APK"

  # 5. Baked Supabase + Sentry client config.
  node "$REPO_ROOT/scripts/check-mobile-build-config.mjs" --apk "$APK"

  # 6. Integrity record (hashes only).
  sha256sum "$APK"
done

# 7. AAB carries the same certificate (keytool on the packaged signature).
if [[ -n "$AAB" ]]; then
  [[ -f "$AAB" ]] || { echo "verify-release-apks: FAIL: AAB not found at $AAB" >&2; exit 1; }
  TMPD="$(mktemp -d)"
  trap 'rm -rf "$TMPD"' EXIT
  unzip -p "$AAB" 'META-INF/*.RSA' > "$TMPD/sig.RSA" 2>/dev/null || true
  RSA="$(find "$TMPD" -name 'sig.RSA' -size +0c | head -1)"
  # Bundletool-style AABs may store the cert under BUNDLE-METADATA or META-INF;
  # fall back to any RSA/DSA block in the archive.
  if [[ -z "$RSA" ]]; then
    ENTRY="$(unzip -Z1 "$AAB" | grep -E 'META-INF/.*\.(RSA|DSA|EC)' | head -1)"
    [[ -n "$ENTRY" ]] || { echo "verify-release-apks: FAIL: no signature block in AAB" >&2; exit 1; }
    unzip -p "$AAB" "$ENTRY" > "$TMPD/sig.RSA"
    RSA="$TMPD/sig.RSA"
  fi
  AAB_FP="$(keytool -printcert -file "$RSA" 2>/dev/null | grep -i 'SHA256:' | sed 's/.*SHA256: //' | tr -d ' :\t\r\n' | tr '[:lower:]' '[:upper:]')"
  [[ -n "$AAB_FP" ]] || { echo "verify-release-apks: FAIL: cannot read AAB signing certificate" >&2; exit 1; }
  [[ "$AAB_FP" == "$EXPECTED_FP" ]] || {
    echo "verify-release-apks: FAIL: AAB signing fingerprint mismatch (expected_len=${#EXPECTED_FP} got_len=${#AAB_FP})" >&2
    exit 1
  }
  echo "verify-release-apks: $(basename "$AAB") signer OK (same pinned certificate as APKs)"
fi

echo "verify-release-apks: ALL ${#APKS[@]} APK variant(s) verified (identical pinned cert, identity, ABI, secrets, config, integrity)"
