#!/usr/bin/env bash
# captures.sh — notification / map / media / AI-benchmark capture entry points.
#
# These are STUBS that wire each acceptance-matrix area to the lab runner and
# the deterministic leaf scripts. Each stub prints the exact manual steps plus
# runs every automatable capture (screenshot, perf probe, logcat dump, uixml)
# under $HARNESS_OUT/<area>/. Human-observed results go in the area NOTES file.
#
# Usage:
#   scripts/device-harness/captures.sh <notification|map|media|ai-bench> [--serial S] [--out DIR]
#
# Matrix wiring:
#   notification -> Push/sharing row (inbox, reaction/comment/mention/status push,
#                   direct reply, deleted target, account switch).
#   map          -> Maps row (render/tap/drag/Places/current location/permission/
#                   services/missing-key/offline/repeated open-close/IME). Keyless
#                   MapLibre pivot: Google Maps markers must stay ABSENT.
#   media        -> Report media row (JPEG/PNG/WebP/GIF/HEIC/AVIF, Motion Photo,
#                   rotated EXIF, GPS strip, 32MP/48MP/>16MB/near-100MiB/>100MiB
#                   rejection, five photos, invalid-first+valid, duplicate, cancel,
#                   retry, kill/restore, immediate publish, cold order; PSS/timing).
#   ai-bench     -> Photo AI + Assistant rows and the performance template
#                   (Smol load/inference, Needle extraction, cloud TTFT; lab-only
#                   LFM/llama.cpp — never on the consumer device).
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

area="${1:-}"
shift || true
SERIAL="${ANDROID_SERIAL:-$FINDBACK_SERIAL}"
OUT="$HARNESS_OUT"
while (($#)); do
  case "$1" in
    --serial) SERIAL="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) harness_err "unknown arg: $1"; exit 1 ;;
  esac
done
case "$area" in
  notification | map | media | ai-bench) ;;
  *)
    harness_err "expected notification|map|media|ai-bench"
    exit 1
    ;;
esac

export ANDROID_SERIAL="$SERIAL"
export HARNESS_OUT="$OUT/$area"
ensure_outdir "$HARNESS_OUT" >/dev/null
NOTES="$HARNESS_OUT/NOTES.md"
[[ -f "$NOTES" ]] || {
  echo "# $area — owner observations (device day)" >"$NOTES"
  echo >>"$NOTES"
  echo "| Step | Expected | Observed | PASS/FAIL |" >>"$NOTES"
  echo "|---|---|---|---|" >>"$NOTES"
}

auto_captures() {
  local tag="$1"
  "$SCRIPT_DIR/capture.sh" screenshot --serial "$SERIAL" --out "$HARNESS_OUT" --name "$tag" || true
  "$SCRIPT_DIR/capture.sh" uixml --serial "$SERIAL" --out "$HARNESS_OUT" --name "$tag" || true
  "$SCRIPT_DIR/perf.sh" all --serial "$SERIAL" --out "$HARNESS_OUT" --name "$tag" || true
  "$SCRIPT_DIR/logcat.sh" dump --serial "$SERIAL" --out "$HARNESS_OUT" || true
}

case "$area" in
  notification)
    cat <<'EOF'
device-harness: notification capture stub (acceptance matrix: Push/sharing).
  Manual steps (record each in NOTES.md):
  1. Trigger each push class: inbox item, reaction, comment, mention, status.
  2. Direct-reply from the notification shade; verify the reply lands.
  3. Open a push whose target was deleted; verify graceful empty state.
  4. Switch accounts; verify no cross-account push leakage.
  5. App Links: Chrome/messaging/cold-start/open/signed-out/invalid (matrix row).
  Automatables run now: dumpsys notification capture + screenshot/uixml/perf/logcat.
EOF
    {
      echo "# dumpsys notification @ $(date -u +%Y%m%dT%H%M%SZ)"
      ANDROID_SERIAL="$SERIAL" adb shell dumpsys notification | grep -i -A3 -B3 findback | head -60
    } >"$HARNESS_OUT/notification-dump.txt" 2>&1 || true
    scrub_file "$HARNESS_OUT/notification-dump.txt"
    auto_captures "notification"
    ;;
  map)
    cat <<'EOF'
device-harness: map capture stub (acceptance matrix: Maps; keyless MapLibre pivot).
  Manual steps (record each in NOTES.md):
  1. Open map: render tiles, tap marker, drag/zoom; screenshot each.
  2. Current-location + permission grant/deny; services-disabled state.
  3. Missing-key/offline behavior; repeated open-close (leak watch via perf probes).
  4. IME over map search field.
  5. Confirm NO Google Maps UI/attribution appears (Maps PRESENT/ABSENT in provenance).
  Automatables run now: screenshot/uixml/perf/logcat.
EOF
    auto_captures "map"
    ;;
  media)
    cat <<'EOF'
device-harness: media capture stub (acceptance matrix: Report media).
  Manual steps (record each in NOTES.md; perf probe per heavy step):
  1. camera/gallery JPEG, PNG, WebP, GIF, HEIC/HEIF, AVIF if available.
  2. Motion Photo, rotated EXIF (verify orientation), GPS strip (verify stripped).
  3. 32MP, 48MP, >16MB ordinary source, near-100MiB safe fixture, >100MiB rejection.
  4. Five photos, invalid-first+valid, duplicate, cancel, retry.
  5. Process kill/restore mid-flow; immediate publish after pick; cold order.
  6. Record PSS + wall timing per heavy step (perf.sh all --name <step>).
  Automatables run now: baseline screenshot/uixml/perf/logcat.
EOF
    auto_captures "media-baseline"
    ;;
  ai-bench)
    cat <<'EOF'
device-harness: AI benchmark stub (acceptance matrix: Photo AI + Assistant;
  figures feed the performance measurement template — no claim without them).
  Manual steps (record each in NOTES.md + perf summary):
  1. Report -> Analyze photo (SmolVLM2 local-first, consented cloud fallback).
  2. Measurement has no consumer screen since 2026-10-25 (owner: no CPU/GPU
     vocabulary on consumer surfaces). Exercise it through the service seam
     (`service.measure('cpu'|'gpu')`, smol-color-plate-v1) until the background
     self-check ships.
  3. Assistant: slow visible partial, retry single-final, rapid double-send
     single-request, Stop with no late emission, photo-only send, large photo.
  4. LFM/llama.cpp are LAB-ONLY (docs/runbooks/native-model-run.md) — never here.
  Automatables run now: baseline screenshot/uixml/perf/logcat.
EOF
    auto_captures "ai-baseline"
    ;;
esac
harness_log "$area stub done -> $HARNESS_OUT (fill NOTES.md on device day)"
