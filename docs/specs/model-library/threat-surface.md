# Import/export threat surface (Tasks 26-27 — SURFACE ONLY for later DeepSeek review)

No implementation in this task. Each item states the attack, the precondition,
and the design constraint the later importer/exporter task MUST satisfy.
Open questions are flagged for the DeepSeek review pass.

## 1. Zip-slip (path traversal on import)

- Attack: crafted `.fbmodel` with `../`, absolute, or drive-letter entry names
  writes outside the model sandbox (overwrites app files / drops payloads).
- Constraint: importer MUST canonicalize every entry path, confine extraction
  to the per-model sandbox dir, and reject symlinks/device nodes/absolute
  paths. Manifest allow-list (§2 of fbmodel-package.md) is the second rail:
  extract ONLY manifest-listed paths.

## 2. Decompression bombs (resource exhaustion)

- Attack: tiny package expands to disk/RAM exhaustion (e.g. highly
  compressible filler with forged manifest sizes, or many small files).
- Constraint: enforce BOTH an absolute expanded-size cap (order: single-digit
  GiB, sized to the largest catalogued entry + margin — exact cap is a later
  task decision) AND a declared-vs-actual streaming check (abort on first
  byte-count mismatch). Never trust central-directory sizes alone.

## 3. Checksum bypass (integrity downgrade)

- Attack: MITM / mirrored release / tampered sidecar swaps weights while
  keeping filenames; attacker strips or re-signs `checksums.json`.
- Constraint: verify per-file SHA-256 against the **shipped pinned catalogue**
  (`catalogue.v1.json` in-app pin), NEVER against values fetched at runtime
  or values read from inside the package under test. Manifest-inside-package
  hashes are a second opinion only. Mismatch = abort + quarantine, no partial
  install, no "use anyway" path through the normal gate.

## 4. Executable injection (code smuggling via model package)

- Attack: native lib / script / APK stowaway inside `.fbmodel` (suffix-spoofed
  or magic-mismatched) executed or side-loaded later.
- Constraint: the §3 hard invariant (suffix + magic sniff deny-list) MUST be
  enforced at import AND re-checked at load time (TOCTOU: re-hash before
  mmap/load). Model dir MUST never be on any executable search path
  (no `dlopen` from model dir, no classpath inclusion).

## 5. Rollback (downgrade to a known-bad revision)

- Attack: re-offer an older release tag / older pinned catalogue whose
  artifact has since been withdrawn (bad weights, license change).
- Constraint: catalogue carries monotonic `catalogueVersion` + pinned tag;
  importer MUST refuse artifacts older than the shipped pin unless the same
  advanced-confirmation gate (ram-ui.md §3) records an explicit override.
  Withdrawal mechanism (block-list delivery) is an OPEN QUESTION for the
  DeepSeek review: options are (a) app-update-only revocation, (b) signed
  revocation file — recommend (a) for v1, no remote trust root.

## 6. Explicitly out of scope for the DeepSeek pass

Downloader networking (TLS pinning, resume attacks), on-device sandboxing of
inference itself, and license-compliance enforcement (LFM $10M threshold,
Gemma terms gating) — noted here so the review stays scoped to package I/O.
