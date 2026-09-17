# Chunk manifest provenance (metadata only — no model bytes)

Generated on the development machine from the exact pinned immutable
Hugging Face artifacts. Each file was verified by exact byte count AND
whole-file SHA-256 before chunking into sequential 8 MiB chunks.

## 500M — `smolvlm2-500m__SmolVLM2-500M.litertlm.json`
- repo: `litert-community/SmolVLM2-500M`
- rev: `dad030b6e56756201d670cfb4d042736a2ce3a5c`
- remote file: `SmolVLM2-500M.litertlm`
- expectedBytes: `360822960`
- whole SHA-256: `b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0`
- chunkSize: `8388608`, chunks: **44** (43 × 8388608 + 1 × 112816)

## 256M TFLite — `smolvlm-256m__smolvlm-256m-instruct_q8_ekv2048_single_image.tflite.json`
- repo: `litert-community/SmolVLM-256M-Instruct`
- rev: `dc16f6046d86c646bcc5dfe249c879d028f8b2f2`
- remote file: `smalvlm-256m-instruct_q8_ekv2048_single_image.tflite`
  (upstream filename contains the typo `smalvlm`; the local `spec.path`
  keeps the corrected spelling — `ModelFileSpec.remotePath` maps it.
  Verified 2026-09-18: the `smolvlm-...` URL returns `Entry not found`.)
- expectedBytes: `288229208`
- whole SHA-256: `48991855eb6365aae8cd1d8fe3013e6059dfea44b4ae26dd76dfa2a942dba3c4`
- chunkSize: `8388608`, chunks: **35** (34 × 8388608 + 1 × 3016536)

## 256M tokenizer — `smolvlm-256m__tokenizer.model.json`
- repo: `litert-community/SmolVLM-256M-Instruct`
- rev: `dc16f6046d86c646bcc5dfe249c879d028f8b2f2`
- remote file: `tokenizer.model`
- expectedBytes: `881895`
- whole SHA-256: `6682f47d3b33538490b21265ba3b2a83f8d48e09dcd7f957b46b508abb427a04`
- chunkSize: `8388608`, chunks: **1** (1 × 881895)

Layout rule: contiguous indexes from 0, no gaps/overlaps, exact coverage of
`[0, expectedBytes)`, every chunk has a 64-char SHA-256. Enforced by
`ChunkManifest.validateLayout` + `chunksFromManifestJson` header gating.
