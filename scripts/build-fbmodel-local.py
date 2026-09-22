#!/usr/bin/env python3
"""Build local .fbmodel release packages for the two v1 entries only.

SmolVLM2 500M + Qwen3 0.6B dynamic INT4. Reads the pinned weights from the
local model cache (no network, no download) and writes STORE-weights +
DEFLATE-manifest packages per docs/specs/model-library/fbmodel-package.md:

  <entry-id>.fbmodel
  <entry-id>.fbmodel.sha256
  <entry-id>.checksums.txt
  <entry-id>.provenance.json

Outputs default to /tmp/findback-modeldist (outside git; never commit
weights). No fixB packaging, no Gemma.

Usage:
  python3 scripts/build-fbmodel-local.py [--cache-dir ~/.cache/findback-model-lab] [--out-dir /tmp/findback-modeldist]
"""
import argparse
import datetime
import hashlib
import json
import os
import sys
import zipfile

ENTRIES = [
    {
        "entryId": "smolvlm2-500m-litert-int4",
        "srcName": "SmolVLM2-500M.litertlm",
        "weightsPath": "weights/SmolVLM2-500M.litertlm",
        "upstream": {
            "repo": "litert-community/SmolVLM2-500M",
            "rev": "dad030b6e56756201d670cfb4d042736a2ce3a5c",
            "file": "SmolVLM2-500M.litertlm",
        },
        "license": "apache-2.0",
        "card": "https://huggingface.co/litert-community/SmolVLM2-500M/blob/main/README.md",
        "base": "HuggingFaceTB/SmolVLM2-500M-Video-Instruct",
    },
    {
        "entryId": "qwen3-0.6b-litert-dynamic-int4",
        "srcName": "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
        "weightsPath": "weights/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
        "upstream": {
            "repo": "litert-community/Qwen3-0.6B",
            "rev": "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
            "file": "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
        },
        "license": "apache-2.0",
        "card": "https://huggingface.co/Qwen/Qwen3-0.6B",
        "base": "Qwen/Qwen3-0.6B",
    },
]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", default=os.path.expanduser("~/.cache/findback-model-lab"))
    parser.add_argument("--out-dir", default="/tmp/findback-modeldist")
    args = parser.parse_args()
    created = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    os.makedirs(args.out_dir, exist_ok=True)
    for entry in ENTRIES:
        src = os.path.join(args.cache_dir, entry["srcName"])
        if not os.path.exists(src):
            print(f"missing pinned weights: {src}", file=sys.stderr)
            sys.exit(1)
        size = os.path.getsize(src)
        weights_sha = sha256_file(src)
        checks = {
            "entryId": entry["entryId"],
            "files": [{"path": entry["weightsPath"], "sha256": weights_sha}],
        }
        checks_json = json.dumps(checks, indent=2).encode()
        checks_sha = hashlib.sha256(checks_json).hexdigest()
        manifest = {
            "packageVersion": "1",
            "entryId": entry["entryId"],
            "upstream": entry["upstream"],
            "createdAt": created,
            "files": [
                {
                    "path": entry["weightsPath"],
                    "bytes": size,
                    "sha256": weights_sha,
                    "method": "STORE",
                },
                {
                    "path": "checksums.json",
                    "bytes": len(checks_json),
                    "sha256": checks_sha,
                    "method": "DEFLATE",
                },
            ],
        }
        manifest_json = json.dumps(manifest, indent=2).encode()
        fbmodel = os.path.join(args.out_dir, entry["entryId"] + ".fbmodel")
        with open(src, "rb") as src_file:
            weights_bytes = src_file.read()
        with zipfile.ZipFile(fbmodel, "w") as archive:
            archive.writestr(entry["weightsPath"], weights_bytes, compress_type=zipfile.ZIP_STORED)
            archive.writestr("checksums.json", checks_json, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
            archive.writestr("manifest.json", manifest_json, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
        package_bytes = os.path.getsize(fbmodel)
        package_sha = sha256_file(fbmodel)
        with open(fbmodel + ".sha256", "w") as f:
            f.write(package_sha + "  " + os.path.basename(fbmodel) + "\n")
        with open(os.path.join(args.out_dir, entry["entryId"] + ".checksums.txt"), "w") as f:
            f.write(package_sha + "  " + os.path.basename(fbmodel) + "\n")
            f.write(weights_sha + "  " + entry["weightsPath"] + "\n")
            f.write(checks_sha + "  checksums.json\n")
        provenance = {
            "entryId": entry["entryId"],
            "upstream": entry["upstream"],
            "license": entry["license"],
            "card": entry["card"],
            "base": entry["base"],
            "package": {
                "asset": os.path.basename(fbmodel),
                "bytes": package_bytes,
                "sha256": package_sha,
            },
            "interior": {
                "weights": {"path": entry["weightsPath"], "bytes": size, "sha256": weights_sha},
            },
            "createdAt": created,
            "recipe": "STORE weights, DEFLATE manifest+checksums per fbmodel-package.md",
        }
        with open(os.path.join(args.out_dir, entry["entryId"] + ".provenance.json"), "w") as f:
            json.dump(provenance, f, indent=2)
            f.write("\n")
        print(entry["entryId"] + ": " + str(package_bytes) + " B " + package_sha)


if __name__ == "__main__":
    main()
