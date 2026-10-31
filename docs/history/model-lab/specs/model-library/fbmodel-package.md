# `.fbmodel` data-only package specification (Tasks 26-27, SPEC ONLY)

## 1. What it is

`.fbmodel` is a **ZIP container** (APPNOTE.TXT-compatible; readable by any
standard unzip) with a fixed interior layout. It exists for
**integrity + portability + metadata + import/export** — NOT for compression
of weights (§4).

## 2. Interior layout (v1)

```
<entry-id>.fbmodel
├── manifest.json        # package schema v1: packageVersion, entryId,
│                        # upstream{repo,rev,file}, createdAt, files[{path,bytes,sha256,method}]
├── weights/
│   └── <model>.litertlm # the single runtime artifact (STORE, §4)
├── tokenizer/
│   └── *               # tokenizer files if shipped separately (DEFLATE)
├── projector/
│   └── *               # vision projector IF the runtime requires a sidecar
│                        # (e.g. GGUF mmproj class); omitted otherwise
└── checksums.json       # SHA-256 per interior path (DEFLATE)
```

`manifest.json` is the source of truth for extraction: exact file list,
exact byte counts, per-file SHA-256, and part enumeration for chunked large
packages. Anything not listed in the manifest MUST be ignored-or-rejected
(reject is the recommended posture for the later importer task).

## 3. HARD INVARIANT — no executables, ever

`.fbmodel` is **data-only**. The following MUST NEVER appear in a package,
and the later importer MUST reject the package if present (by suffix AND by
content sniff — suffixes alone are bypassable):

- `.so` / `.dll` / `.dylib` / `.dex` / `.odex` / `.apk` / `.aab` / `.exe` /
  `.msi` / `.sh` / `.bat` / `.cmd` / `.py` / `.js` (outside tokenizer vocab
  JSON) / any Mach-O / ELF (`\x7fELF`) / MZ (`MZ`) / dex (`dex\n`) magic.
- Symlinks, device nodes, absolute paths, `..` segments, drive-letter paths.

Rationale: the model runtime (LiteRT-LM) is already bundled with the app via
audited Maven artifacts; letting a model package smuggle native code would
collapse the supply-chain boundary the pinned catalogue exists to enforce.

## 4. Compression policy + micro-benchmark (small representative artifacts only)

Method (2026-09-21, repo machine, Python `zipfile`; NO model downloaded):
1 MiB `os.urandom` bytes (stands in for quantized int4/int8 weights —
high-entropy by construction) + ~403 KiB repetitive vocab-style JSON
(stands in for a tokenizer) + 52 B manifest-style JSON. STORE vs DEFLATE-6:

| Artifact | Method | Ratio (zip/orig) | Time |
|---|---|---|---|
| weights-like 1 MiB | STORE | 1.000 | 2.6 ms |
| weights-like 1 MiB | DEFLATE-6 | **1.000** | 39.4 ms |
| tokenizer-like 403 KiB | STORE | 1.000 | 1.3 ms |
| tokenizer-like 403 KiB | DEFLATE-6 | **0.113** | 5.2 ms |
| manifest-like 52 B | either | ~3.5 (zip overhead dominates) | <1 ms |

Findings:
1. **Quantized weights are incompressible** (ratio exactly 1.000) — DEFLATE
   buys zero bytes at ~15x CPU cost per MB. On a phone this is pure battery +
   import-time cost for nothing.
2. **Text artifacts compress ~9:1** — worth it, and they are tiny anyway.
3. Policy: **STORE for `weights/` + `projector/` binaries; DEFLATE (level 6)
   for `manifest.json`, `tokenizer/`, `checksums.json`.**
4. Primary benefits statement (for the catalogue UI copy): integrity
   (per-file SHA-256), portability (one file per model), metadata
   (upstream rev + license pinned inside), import/export (shareable offline).
   Compression is explicitly NOT a claimed benefit for weights.

Prior evidence consistent with this: quantized `.litertlm`/GGUF artifacts are
distributed uncompressed upstream (litert-community cards list raw sizes;
`gvij/qwen3-0.6b-gguf` lists per-quant raw MB) — nobody deflates int4 weights
in transit because there is nothing to gain.

## 5. Chunked large packages (future, Gemma-class only)

If a single `.fbmodel` would exceed 2 GiB (GitHub per-asset limit), split at
package-build time into `.fbmodel.part01/.part02…` (<2 GiB each); the release
`checksums.txt` AND the in-manifest part list both enumerate parts with
per-part SHA-256. Reassembly order is manifest-defined. Not needed for any v1
small entry.
