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

# --- Pure helpers (no side effects; unit-tested via
# `VERIFY_RELEASE_APKS_TEST=1 source scripts/verify-release-apks.sh`) ---
norm_fp() { tr -d ' :\t\r\n' <<<"$1" | tr '[:lower:]' '[:upper:]'; }

# Redact certificate material for logs. Reads the UNREDACTED apksigner
# capture on stdin; the digest hex never reaches logs.
redact_cert_log() {
  sed -E -e 's/(SHA-256 digest:).*/\1 <redacted>/' \
         -e 's/(SHA1 digest:).*/\1 <redacted>/' \
         -e 's/(digest:).*/\1 <redacted>/'
}

# Extract the raw SHA-256 digest from UNREDACTED apksigner output on stdin.
# MUST run on the private capture, never on redacted log output (redaction
# destroys the value — see regression test).
extract_cert_fp() {
  grep -oE 'SHA-256 digest: [0-9a-fA-F:]+' | head -1 | sed 's/.*: //'
}

# ABIs the release set advertises (mirrors the Gradle splits include list;
# changing the set means changing Gradle + this verifier together).
SUPPORTED_ABIS="arm64-v8a armeabi-v7a x86_64"

# .so basenames shipped for one ABI, from an `unzip -Z1`-style listing on
# stdin. Matches APK entries (lib/<abi>/...) and AAB entries
# (base/lib/<abi>/...).
so_basenames_for_abi() {
  local abi="$1"
  # `|| true`: an ABI legitimately absent from a listing is data, not an error;
  # the caller fails closed on an empty reference for a required ABI.
  { grep -E "(^|/)lib/${abi}/[^/]*\\.so$" || true; } | sed -E "s#(^|.*/)lib/${abi}/##" | sort -u
}

# Compare the ABI's .so set in the listing on stdin against that ABI's exact
# reference set (file $1, one basename per line) for $2. Native engines are
# deliberately ABI-gated (Needle/llama/vision ship for arm64-v8a only), so the
# contract is exact per-ABI equality, NOT a cross-ABI union. Prints
# `missing <name>` / `extra <name>` lines; returns non-zero unless equal.
assert_abi_matches_set() {
  local req_file="$1" abi="$2" have req_sorted have_sorted missing extra
  have="$(so_basenames_for_abi "$abi" || true)"
  req_sorted="$(sort -u "$req_file")"
  have_sorted="$(printf '%s\n' "$have" | sed '/^[[:space:]]*$/d' | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$req_sorted") <(printf '%s\n' "$have_sorted"))"
  extra="$(comm -13 <(printf '%s\n' "$req_sorted") <(printf '%s\n' "$have_sorted"))"
  if [[ -z "$missing" && -z "$extra" ]]; then
    return 0
  fi
  # Intentional word-splitting: .so basenames never contain whitespace.
  [[ -n "$missing" ]] && printf 'missing %s\n' $missing
  [[ -n "$extra" ]] && printf 'extra %s\n' $extra
  return 1
}

# Unit-test hook: sourcing with VERIFY_RELEASE_APKS_TEST=1 exposes the
# functions above without running verification.
if [[ "${VERIFY_RELEASE_APKS_TEST:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

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

EXPECTED_FP="$(norm_fp "$ANDROID_SIGNING_CERT_SHA256")"
[[ -n "$EXPECTED_FP" ]] || { echo "verify-release-apks: fingerprint normalizes to empty" >&2; exit 1; }
# Fail closed on a malformed pinned value (length only — never the value).
[[ "$EXPECTED_FP" =~ ^[0-9A-F]{64}$ ]] || { echo "verify-release-apks: pinned fingerprint is not 64 hex chars (len=${#EXPECTED_FP})" >&2; exit 1; }

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

# Reference native-lib inventory (R2): the universal APK is the per-ABI
# reference. Native engines are deliberately ABI-gated — Needle, the
# llama.cpp lab bridge and the LiteRT-LM vision runtime ship for arm64-v8a
# only, while 32-bit and x86_64 remain intentionally engine-unavailable (see
# scripts/fetch-needle-model.mjs and app/src/main/cpp/CMakeLists.txt). A single
# cross-ABI union is therefore NOT the contract. Instead:
#   * the universal APK must carry EVERY supported ABI, each with >=1 .so
#   * each per-ABI split must ship EXACTLY its ABI's universal set
#   * the AAB (when provided) must agree with the universal set per ABI
# Fail closed on any missing, extra, or absent ABI.
UNIVERSAL_APK="$(find "$APK_DIR" -maxdepth 1 -name '*universal*.apk' | sort | head -1)"
[[ -n "$UNIVERSAL_APK" ]] || { echo "verify-release-apks: FAIL: no universal APK in $APK_DIR (reference inventory required)" >&2; exit 1; }
UNIVERSAL_LISTING="$(unzip -Z1 "$UNIVERSAL_APK")"
REQ_DIR="$(mktemp -d)"
trap 'rm -rf "$REQ_DIR"' EXIT
for ABI in $SUPPORTED_ABIS; do
  so_basenames_for_abi "$ABI" <<<"$UNIVERSAL_LISTING" > "$REQ_DIR/$ABI.txt" || true
  [[ -s "$REQ_DIR/$ABI.txt" ]] || { echo "verify-release-apks: FAIL: universal $(basename "$UNIVERSAL_APK") ships no native .so for $ABI" >&2; exit 1; }
done
if [[ -n "$AAB" ]]; then
  [[ -f "$AAB" ]] || { echo "verify-release-apks: FAIL: AAB not found at $AAB" >&2; exit 1; }
  AAB_LISTING="$(unzip -Z1 "$AAB")"
  for ABI in $SUPPORTED_ABIS; do
    if ! DIFF="$(assert_abi_matches_set "$REQ_DIR/$ABI.txt" "$ABI" <<<"$AAB_LISTING")"; then
      echo "verify-release-apks: FAIL: AAB native set differs from universal for $ABI ($(echo "$DIFF" | tr '\n' ' '))" >&2
      exit 1
    fi
  done
fi
echo "verify-release-apks: per-ABI reference native sets: $(for ABI in $SUPPORTED_ABIS; do printf '%s(%s) ' "$ABI" "$(wc -l <"$REQ_DIR/$ABI.txt" | tr -d ' ')"; done)"

FIRST_FP=""
for APK in "${APKS[@]}"; do
  NAME="$(basename "$APK")"
  echo "--- $NAME ---"

  # 1. Signature + exact fingerprint pin.
  # Capture the UNREDACTED apksigner output privately; ONLY a redacted view
  # reaches logs; the comparison value is parsed from the private capture.
  SIG_RAW="$("$APKSIGNER" verify --verbose --print-certs "$APK")"
  echo "$SIG_RAW" | redact_cert_log
  echo "$SIG_RAW" | grep -q 'Verified using v2 scheme.*true' || { echo "verify-release-apks: FAIL $NAME: V2 signature missing" >&2; exit 1; }
  RAW_FP="$(echo "$SIG_RAW" | extract_cert_fp)"
  [[ -n "$RAW_FP" ]] || { echo "verify-release-apks: FAIL $NAME: no SHA-256 digest in apksigner output" >&2; exit 1; }
  GOT_FP="$(norm_fp "$RAW_FP")"
  # Normalized fingerprints are exactly 64 hex chars (colons/space stripped).
  [[ "$GOT_FP" =~ ^[0-9A-F]{64}$ ]] || { echo "verify-release-apks: FAIL $NAME: fingerprint not 64 hex chars (got_len=${#GOT_FP})" >&2; exit 1; }
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

  # 3. ABI completeness: each split claims an ABI by filename, then PROVES it
  # by shipping exactly that ABI's universal reference .so set; universal must
  # carry every supported ABI, each matching its reference.
  LISTING="$(unzip -Z1 "$APK")"
  LIBS="$(echo "$LISTING" | grep -Eo 'lib/[^/]+/' | cut -d/ -f2 | sort -u | tr '\n' ' ' || true)"
  case "$NAME" in
    *arm64-v8a*) WANT="arm64-v8a" ;;
    *armeabi-v7a*) WANT="armeabi-v7a" ;;
    *x86_64*) WANT="x86_64" ;;
    *universal*) WANT="$SUPPORTED_ABIS" ;;
    *) echo "verify-release-apks: FAIL $NAME: unexpected APK name (want an ABI or universal split)" >&2; exit 1 ;;
  esac
  for ABI in $WANT; do
    if ! DIFF="$(assert_abi_matches_set "$REQ_DIR/$ABI.txt" "$ABI" <<<"$LISTING")"; then
      echo "verify-release-apks: FAIL $NAME: native set for $ABI differs from reference ($(echo "$DIFF" | tr '\n' ' '); reference: $(tr '\n' ' ' <"$REQ_DIR/$ABI.txt"))" >&2
      exit 1
    fi
  done
  # No unexpected ABIs (e.g. 32-bit x86, mips) may sneak in.
  for ABI in $LIBS; do
    [[ "$SUPPORTED_ABIS " == *"$ABI "* ]] || { echo "verify-release-apks: FAIL $NAME: unexpected ABI lib $ABI" >&2; exit 1; }
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
