#!/usr/bin/env bash
# capture.sh — screenshot, screen recording, UIAutomator dump.
#
# Usage:
#   scripts/device-harness/capture.sh screenshot [--serial S] [--out DIR] [--name NAME]
#   scripts/device-harness/capture.sh record     [--serial S] [--out DIR] [--name NAME] [--seconds 30]
#   scripts/device-harness/capture.sh uixml      [--serial S] [--out DIR] [--name NAME]
#
# All artifacts land under $OUT (default $HARNESS_OUT). Filenames embed a UTC
# timestamp so reruns never overwrite historical failure evidence.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

cmd="${1:-}"
shift || true
SERIAL="${ANDROID_SERIAL:-$FINDBACK_SERIAL}"
OUT="$HARNESS_OUT"
NAME="capture"
SECONDS_N=30
while (($#)); do
  case "$1" in
    --serial) SERIAL="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --seconds) SECONDS_N="${2:-}"; shift 2 ;;
    *) harness_err "unknown arg: $1"; exit 1 ;;
  esac
done

require_adb
export ANDROID_SERIAL="$SERIAL"
ensure_outdir "$OUT" >/dev/null
TS="$(date -u +%Y%m%dT%H%M%SZ)"

case "$cmd" in
  screenshot)
    dest="$OUT/${TS}_${NAME}.png"
    adb exec-out screencap -p >"$dest"
    harness_log "screenshot -> $dest"
    ;;
  record)
    # screenrecord caps at 180s; default 30s keeps artifacts small.
    ((SECONDS_N >= 1 && SECONDS_N <= 180)) || {
      harness_err "--seconds must be 1..180"
      exit 1
    }
    remote="/sdcard/${TS}_${NAME}.mp4"
    dest="$OUT/${TS}_${NAME}.mp4"
    harness_log "recording ${SECONDS_N}s on device (interact now)…"
    adb shell screenrecord --time-limit="$SECONDS_N" "$remote"
    adb pull "$remote" "$dest"
    adb shell rm -f "$remote"
    harness_log "recording -> $dest"
    ;;
  uixml)
    remote="/sdcard/${TS}_${NAME}.uix"
    dest="$OUT/${TS}_${NAME}.uix.xml"
    adb shell uiautomator dump "$remote"
    adb pull "$remote" "$dest"
    adb shell rm -f "$remote"
    harness_log "uiautomator dump -> $dest"
    ;;
  *)
    harness_err "expected screenshot|record|uixml"
    exit 1
    ;;
esac
