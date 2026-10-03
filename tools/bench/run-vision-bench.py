#!/usr/bin/env python3
"""Real vision benchmark (F3): SmolVLM2-500M CPU inference over fixture plates.

Runs every plate in build/bench-fixtures/ through the pinned weights with
two prompts (describe + transcribe), then scores: OCR word recall against
the manifest, forbidden brand-claim hits, loop/echo flags, and latency.
Writes tools/bench/reports/vision-bench-<stamp>.json with real
modelRev/runtimeRev — photoCases.executed counts plates actually run, never
a skeleton zero.

Requires: build/bench-models/SmolVLM2-500M.litertlm (fetch-smolvlm-model.mjs)
and the litert-lm package. Backend CPU/CPU: GPU numbers stay device-gated.
"""
import json
import re
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "build" / "bench-fixtures"
WEIGHTS = REPO_ROOT / "build" / "bench-models" / "SmolVLM2-500M.litertlm"
REPORTS = REPO_ROOT / "tools" / "bench" / "reports"

MODEL_REV = "dad030b6e56756201d670cfb4d042736a2ce3a5c"
MODEL_SHA = "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0"
WEIGHTS_BYTES = 360822960

PROMPTS = {
    "describe": "Describe this image in one sentence.",
    "transcribe": "Transcribe all visible text in this image exactly, word for word.",
}


def loop_flag(text):
    """True when a substring repeats pathologically (echo/sentence loop)."""
    words = re.findall(r"[A-Za-z0-9]+", text.lower())
    if len(words) < 12:
        return False
    for span in (1, 2, 4):
        runs = 1
        for i in range(span, len(words), span):
            if words[i : i + span] == words[i - span : i]:
                runs += 1
                if runs >= 6:
                    return True
            else:
                runs = 1
    # Same long sentence echoed 3+ times.
    sentences = [s.strip() for s in re.split(r"[.!?]+", text.lower()) if len(s.strip()) > 20]
    counts = {}
    for s in sentences:
        counts[s] = counts.get(s, 0) + 1
        if counts[s] >= 3:
            return True
    # Single-token run without word boundaries (spaced-out repeats like
    # "4 4 4 ..." collapse to one long run once whitespace is removed).
    nospace = re.sub(r"\s+", "", text)
    if re.search(r"(.)\1{19,}", nospace):
        return True
    return False


def ocr_recall(output, expected_words):
    if not expected_words:
        return None
    found = set(re.findall(r"[A-Za-z0-9]+", output.upper()))
    hits = sum(1 for w in expected_words if w.upper() in found)
    return hits / len(expected_words)


def forbidden_hits(output, forbidden):
    if not forbidden:
        return []
    lowered = output.lower()
    return [claim for claim in forbidden if claim.lower() in lowered]


def main():
    import litert_lm

    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    engine = litert_lm.Engine(
        str(WEIGHTS),
        backend=litert_lm.Backend.CPU(),
        vision_backend=litert_lm.Backend.CPU(),
    )
    report = {
        "modelId": "smolvlm2-500M-vision",
        "modelRev": MODEL_REV,
        "modelSha256": MODEL_SHA,
        "runtimeRev": f"litert-lm-cpu-host",
        "backend": "cpu",
        "photoCases": {"executed": 0, "plates": []},
    }
    with engine as eng:
        for plate_id, plate in manifest["plates"].items():
            case = {"plate": plate_id, "file": plate["file"], "prompts": {}}
            # Fresh conversation per plate: single-image VQA per the model
            # card, and the 256-token kv window cannot hold a multi-plate
            # dialogue (stale context contaminates later plates).
            conv = eng.create_conversation()
            with conv:
                for name, prompt in PROMPTS.items():
                    t0 = time.perf_counter()
                    try:
                        out = conv.send_message(
                            litert_lm.Contents.of(
                                litert_lm.Content.ImageFile(str(FIXTURES / plate["file"])),
                                litert_lm.Content.Text(prompt),
                            )
                        )
                        text = str(out)
                        latency_ms = (time.perf_counter() - t0) * 1000.0
                        case["prompts"][name] = {
                            "output": text[:2000],
                            "latencyMs": round(latency_ms, 1),
                            "loop": loop_flag(text),
                        }
                    except Exception as e:  # noqa: BLE001 - bench records, never crashes
                        case["prompts"][name] = {"error": f"{type(e).__name__}: {e}"[:300]}
                desc = case["prompts"].get("describe", {}).get("output", "")
                trans = case["prompts"].get("transcribe", {}).get("output", "")
                case["ocrRecallDescribe"] = ocr_recall(desc, plate.get("words", []))
                case["ocrRecallTranscribe"] = ocr_recall(trans, plate.get("words", []))
                case["forbiddenHits"] = forbidden_hits(
                    f"{desc} {trans}", plate.get("forbiddenClaims", [])
                )
                report["photoCases"]["plates"].append(case)
                report["photoCases"]["executed"] += 1
                print(f"plate {plate_id}: done", flush=True)

    REPORTS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_path = REPORTS / f"vision-bench-{stamp}.json"
    out_path.write_text(json.dumps(report, indent=2) + "\n")

    recalls = [
        p["ocrRecallTranscribe"]
        for p in report["photoCases"]["plates"]
        if p["ocrRecallTranscribe"] is not None
    ]
    mean_recall = sum(recalls) / len(recalls) if recalls else 0.0
    loops = sum(
        1
        for p in report["photoCases"]["plates"]
        for v in p["prompts"].values()
        if v.get("loop") is True
    )
    forbidden = sum(len(p["forbiddenHits"]) for p in report["photoCases"]["plates"])
    print(f"executed={report['photoCases']['executed']} meanOcrRecall={mean_recall:.2f} loops={loops} forbidden={forbidden}")
    print(f"report: {out_path}")


if __name__ == "__main__":
    sys.exit(main())
