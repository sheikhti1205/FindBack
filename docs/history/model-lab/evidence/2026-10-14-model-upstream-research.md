# FindBack model acquisition, licensing and runtime research — 2026-10-14

## Scope, method and evidence strength

Owner-requested **research, not implementation**. Enumerated all **11** entries in `apps/mobile/src/services/ai/modelDescriptors.ts`, read their pins in `modelProfiles.ts`, and checked Android dependency/fetch/JNI configuration. Also researched the actual LFM2.5 artifacts already mentioned in profiles and smaller official LFM2.5 successors. Only this document is an authorized write; no product edits, commits, builds, model downloads or device runs were performed.

- **[VERIFIED]** means directly observed repository configuration, an upstream API response, license text, publisher model card or HTTP HEAD result. A publisher's performance claim is verified **as a claim**, not independently reproduced here.
- **[INFERRED]** means a recommendation or compatibility interpretation, not a device result.
- **[UNKNOWN]** means not established. In particular, none of the newly researched artifacts is FindBack-device-qualified by this report.
- Hashes below are **HF-reported LFS SHA-256 of artifact contents**, not Git blob IDs, Xet hashes or hashes computed from downloaded models. Integer sizes are exact **bytes**, not rounded MB. Non-LFS text hashes explicitly say they were computed from fetched text.
- Used HF JSON metadata (`?blobs=true`), raw textual cards/licenses, Google Maven XML/POM, upstream source and release/issue APIs, and HEAD only for binaries. No binary response bodies were requested. Tavily/Firecrawl are unavailable in this session; direct primary endpoints were sufficient. Subagent delegation was unavailable (depth limit), so this is one research pass, not an independent implementation review.
- Important earlier statements were not taken on trust. Fresh upstream results **contradict** FindBack's blanket LFM redistribution prohibition and its LFM2-VL/LFM2.5 provenance.

## Executive findings

1. **[VERIFIED] LFM Open License v1.0 is not evaluation-only and does not categorically prohibit redistribution.** Sections 2 and 4 expressly permit distribution, subject to compliance and section 5's commercial limitation. The text defines a US$10M annual-revenue Threshold and uses “not exceeding”/“exceeds” language in section 5. Preserve that wording and obtain owner/legal review at the boundary; do not silently translate it into a different test. FindBack's `lfm-1.0-eval-only`, “license forbids redistribution”, and “no bundling or redistributable download” claims are inaccurate as upstream-license facts. A conservative product gate can remain, but must be labeled product policy/legal eligibility pending, not an upstream prohibition.
2. **[VERIFIED] Exact LFM2 text GGUFs are in official `LiquidAI/*-GGUF` repositories**, not the safetensors repositories named in the descriptors.
3. **[VERIFIED] The investigated `LFM2-VL-450M-int4.litertlm` and `LFM2-VL-1.6B-int4.litertlm` descriptor filenames are not present in the named official LFM2-VL repository inventories.** Actual community LiteRT candidates found are **LFM2.5-VL**, with different model identities and underscore filenames. They are not same-byte mirrors or silent replacements for LFM2-VL.
4. **[VERIFIED] Official IBM Granite 3.3 2B Q4_0 GGUF exists.** Bartowski's community Q4_0 has a different filename, size and hash. Prefer official IBM when evaluating this exact candidate; do not describe community and official quantizations as interchangeable download sources.
5. **[VERIFIED] Current stable LiteRT-LM is 0.18.0**, released 2026-10-06; both GitHub and Google Maven agree. FindBack pins **0.17.1**. Current Qwen3 **1.7B** bundles explicitly require **>=0.18.0**. The existing **0.6B dynamic INT4** bundle explicitly supports **0.17.1** and its present pin/hash/bytes are valid. Do not impose the newer INT8 artifact's requirement on the old dynamic INT4 artifact.
6. **[VERIFIED] The existing Needle, SmolVLM2 and Qwen3 0.6B byte pins match upstream.** Current repository revisions also contain those same bytes. No reason was found to replace their weights merely because the repository HEAD moved.
7. **[VERIFIED] HF HEAD redirects use signed Xet CDN endpoints.** Removing the signature query produced **403** for tested Qwen0.6, Qwen1.7 and Needle routes. No unsigned, permanent CDN mirror was verified. Never fabricate `cdn-lfs.../<artifact-sha>` paths or use the final CDN ETag as the model SHA-256.
8. **[VERIFIED] LFM2.5-VL stock bundles have an open upstream top-quarter-image defect report; hybrid models have an open cross-conversation recurrent-state report.** A version upgrade alone does not prove either is fixed. `fixB` changes the artifact bytes and conversion graph; it is not a fallback URL for stock bytes.

## 1. All current descriptor entries

Source: [`modelDescriptors.ts`](../../apps/mobile/src/services/ai/modelDescriptors.ts), especially lines 181–280 and 350–479; [`modelProfiles.ts`](../../apps/mobile/src/services/ai/modelProfiles.ts), lines 93–285. The three production entries have asserted roles; eight Advanced entries have empty `taskRoles`. This report **does not expand any roles** or independently revalidate existing product-role claims.

| Exact model ID | Current intended artifact/runtime | Fresh acquisition finding | Research decision, not promotion |
|---|---|---|---|
| `needle3-cact-l20` | `needle3.cact`; Needle/Cactus | Exact existing pinned model and Android archive verified, N below | Retain paired model/engine pin; Apache-2.0; no extra tokenizer download for inference |
| `smolvlm2-500M-vision` | `SmolVLM2-500M.litertlm`; LiteRT-LM | Existing pin verified, S below; conversion of official SmolVLM2-500M-Video-Instruct | Keep bytes; community conversion provenance must remain explicit |
| `qwen3-0.6b-dynamic-int4` | dynamic INT4 `.litertlm`; LiteRT-LM | Existing pin verified, Q06 below; community conversion of official Qwen | Keep bytes; publisher explicitly supports runtime 0.17.1 |
| `qwen3-1.7b-dynamic-int4` | dynamic INT4 `.litertlm`; LiteRT-LM | Exact current artifact verified, Q17 below | Pin possible, but runtime >=0.18.0 and FindBack device acceptance still required |
| `lfm2-350m-q4_0` | Q4_0 `.gguf`; llama.cpp lab | Official `LiquidAI/LFM2-350M-GGUF`, L350 below | Correct source repo; legal-policy gate and device qualification separate |
| `lfm2-700m-q4_0` | Q4_0 `.gguf`; llama.cpp lab | Official `LiquidAI/LFM2-700M-GGUF`, L700 below | Same separation |
| `lfm2-1.2b-q4_0` | Q4_0 `.gguf`; llama.cpp lab | Official `LiquidAI/LFM2-1.2B-GGUF`, L12 below | Same separation; not LFM2.5-1.2B-Instruct |
| `granite-3.3-2b-instruct-q4_0` | Q4_0 `.gguf`; llama.cpp lab | Official `ibm-granite/granite-3.3-2b-instruct-GGUF`, G below | Correct repo; community alternative is a different quantization artifact |
| `lfm2-vl-450m-int4` | claimed LFM2-VL `.litertlm`; Smol runtime ID | Named official repo has no `.litertlm`; official LFM2-VL GGUF+projector verified, V450 below | Keep unavailable as exact descriptor; either deliberately evaluate original LFM2-VL on a real vision-capable GGUF lane or create explicitly different LFM2.5 candidate after approval |
| `lfm2-vl-1.6b-int4` | claimed LFM2-VL `.litertlm`; Smol runtime ID | Same family/format problem; V16 below | Same; cannot repair just by changing URL |
| `qwen3-vl-2b-instruct-int4` | claimed `.litertlm`; Smol runtime ID | Official Qwen repository has no `.litertlm`; official GGUF+projector verified, QVL below | Exact LiteRT artifact remains unverified; official GGUF requires multimodal integration absent from current JNI bridge |

**[UNKNOWN]** A public API's absence is not proof that no private, gated or newly published conversion exists anywhere. The attempted `https://huggingface.co/api/models/litert-community/Qwen3-VL-2B-Instruct?blobs=true` returned 401; do not label a guessed repository a verified source.

## 2. Immutable acquisition-source index

For each code in the tables, the link is the **exact immutable metadata API**. Artifact acquisition URL is exactly:

`https://huggingface.co/{repository}/resolve/{40-character revision}/{case-sensitive filename}`

No `main`, tag, UI `/blob/` URL, guessed mirror or model-family alias belongs in an install pin. All filenames in the following tables refer to this formula and their listed source code. “Official” means published in the model creator's namespace; “community” means a conversion publisher's namespace, even when using Google's runtime.

| Code | Repository/provenance | Immutable revision and exact API |
|---|---|---|
| N | `Cactus-Compute/needle3` — official model **and paired native engine** | [`c7c415a3d1b3d929014bc6e866d51ebb971f7089`](https://huggingface.co/api/models/Cactus-Compute/needle3/revision/c7c415a3d1b3d929014bc6e866d51ebb971f7089?blobs=true) |
| S | `litert-community/SmolVLM2-500M` — community conversion | [`dad030b6e56756201d670cfb4d042736a2ce3a5c`](https://huggingface.co/api/models/litert-community/SmolVLM2-500M/revision/dad030b6e56756201d670cfb4d042736a2ce3a5c?blobs=true) |
| Q06 | `litert-community/Qwen3-0.6B` — community conversion; retain current FindBack pin | [`a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76`](https://huggingface.co/api/models/litert-community/Qwen3-0.6B/revision/a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76?blobs=true) |
| Q17 | `litert-community/Qwen3-1.7B` — community conversion, current snapshot | [`79bf0667b32ae025b972e5fe555fe72ca6e8816c`](https://huggingface.co/api/models/litert-community/Qwen3-1.7B/revision/79bf0667b32ae025b972e5fe555fe72ca6e8816c?blobs=true) |
| L350 | `LiquidAI/LFM2-350M-GGUF` — official | [`8fdc9d526b7ed346b19257551b05816c7912ecc2`](https://huggingface.co/api/models/LiquidAI/LFM2-350M-GGUF/revision/8fdc9d526b7ed346b19257551b05816c7912ecc2?blobs=true) |
| L700 | `LiquidAI/LFM2-700M-GGUF` — official | [`fd39e80d7a5ac61494ffff577e61bbbfddbd0d02`](https://huggingface.co/api/models/LiquidAI/LFM2-700M-GGUF/revision/fd39e80d7a5ac61494ffff577e61bbbfddbd0d02?blobs=true) |
| L12 | `LiquidAI/LFM2-1.2B-GGUF` — official | [`5399e76c648f4eb8c053feb1ab747277dea5bf8b`](https://huggingface.co/api/models/LiquidAI/LFM2-1.2B-GGUF/revision/5399e76c648f4eb8c053feb1ab747277dea5bf8b?blobs=true) |
| G | `ibm-granite/granite-3.3-2b-instruct-GGUF` — official IBM conversion | [`7cdf86ccd1f1bb3491c9b7017b033f2e51367397`](https://huggingface.co/api/models/ibm-granite/granite-3.3-2b-instruct-GGUF/revision/7cdf86ccd1f1bb3491c9b7017b033f2e51367397?blobs=true) |
| GB | `bartowski/ibm-granite_granite-3.3-2b-instruct-GGUF` — community, **different bytes** | [`4e06dce39d4c5fcf65ca1cc69b92962e411d38e1`](https://huggingface.co/api/models/bartowski/ibm-granite_granite-3.3-2b-instruct-GGUF/revision/4e06dce39d4c5fcf65ca1cc69b92962e411d38e1?blobs=true) |
| V450 | `LiquidAI/LFM2-VL-450M-GGUF` — official original LFM2-VL | [`7cf9679aa137039135e342aa77014f7b5f2bef73`](https://huggingface.co/api/models/LiquidAI/LFM2-VL-450M-GGUF/revision/7cf9679aa137039135e342aa77014f7b5f2bef73?blobs=true) |
| V16 | `LiquidAI/LFM2-VL-1.6B-GGUF` — official original LFM2-VL | [`6121de267003bb4d4f325fe10abdc735aee06747`](https://huggingface.co/api/models/LiquidAI/LFM2-VL-1.6B-GGUF/revision/6121de267003bb4d4f325fe10abdc735aee06747?blobs=true) |
| QVL | `Qwen/Qwen3-VL-2B-Instruct-GGUF` — official Qwen | [`52d6c8ffea26cc873ac5ad116f8631268d7eb503`](https://huggingface.co/api/models/Qwen/Qwen3-VL-2B-Instruct-GGUF/revision/52d6c8ffea26cc873ac5ad116f8631268d7eb503?blobs=true) |
| L25I | `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` — official **different model from L12** | [`8ed288026e23958ad9dfa92d53ed773a8eee7125`](https://huggingface.co/api/models/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/revision/8ed288026e23958ad9dfa92d53ed773a8eee7125?blobs=true) |
| L25T | `LiquidAI/LFM2.5-1.2B-Thinking-GGUF` — official thinking variant | [`9584426effbfa44b677e925793a12188a36b44ce`](https://huggingface.co/api/models/LiquidAI/LFM2.5-1.2B-Thinking-GGUF/revision/9584426effbfa44b677e925793a12188a36b44ce?blobs=true) |
| L2523 | `LiquidAI/LFM2.5-230M-GGUF` — official smaller successor | [`03502067c64ce32ac4fe87b0cec0310a1a13d3e9`](https://huggingface.co/api/models/LiquidAI/LFM2.5-230M-GGUF/revision/03502067c64ce32ac4fe87b0cec0310a1a13d3e9?blobs=true) |
| L2535 | `LiquidAI/LFM2.5-350M-GGUF` — official smaller successor | [`657e078c94084481950a2d555a941481f715536b`](https://huggingface.co/api/models/LiquidAI/LFM2.5-350M-GGUF/revision/657e078c94084481950a2d555a941481f715536b?blobs=true) |
| L25V450 | `LiquidAI/LFM2.5-VL-450M-GGUF` — official newer vision model | [`1abed04b6fe71314d8c446a1371c03d7c332266d`](https://huggingface.co/api/models/LiquidAI/LFM2.5-VL-450M-GGUF/revision/1abed04b6fe71314d8c446a1371c03d7c332266d?blobs=true) |
| L25V16 | `LiquidAI/LFM2.5-VL-1.6B-GGUF` — official newer vision model | [`36fc16bc95133424921bcc3da009e83b2f23ffb5`](https://huggingface.co/api/models/LiquidAI/LFM2.5-VL-1.6B-GGUF/revision/36fc16bc95133424921bcc3da009e83b2f23ffb5?blobs=true) |
| C25V450 | `litert-community/LFM2.5-VL-450M` — community conversion of LFM2.5, **not LFM2** | [`da7396bf02715c332c21d0117d48a05851db5fb0`](https://huggingface.co/api/models/litert-community/LFM2.5-VL-450M/revision/da7396bf02715c332c21d0117d48a05851db5fb0?blobs=true) |
| C25V16 | `litert-community/LFM2.5-VL-1.6B` — community conversion of LFM2.5 | [`7d5dcfca5dba114646a0beb723a55ab9fb30821e`](https://huggingface.co/api/models/litert-community/LFM2.5-VL-1.6B/revision/7d5dcfca5dba114646a0beb723a55ab9fb30821e?blobs=true) |
| C25I | `litert-community/LFM2.5-1.2B-Instruct` — community text conversion | [`2b81a4be8ceaec7a74614fc6df2efcae5ed55828`](https://huggingface.co/api/models/litert-community/LFM2.5-1.2B-Instruct/revision/2b81a4be8ceaec7a74614fc6df2efcae5ed55828?blobs=true) |

Discovery endpoints, used only for research, **not** acquisition pins:

- `https://huggingface.co/api/models?author=LiquidAI&search=LFM2&limit=100`
- `https://huggingface.co/api/models?author=litert-community&search=LFM&limit=100`
- `https://huggingface.co/api/models?search=Qwen3-VL-2B&limit=50`

The Liquid list includes many >2B, audio, embedding and specialized variants. This document exhaustively maps the **current descriptor set**, not every Liquid product. Extra LFM2.5 rows are explicitly named evaluation choices, not new FindBack descriptors. MoE “active parameters” must not be confused with total weights or the <=2B candidate policy.

## 3. Deployable artifact table — exact bytes

All hash/size entries in this section are **[VERIFIED] publisher LFS metadata** from the index above. “Deployable” means published in a supported upstream format, **not** integrated/accepted in FindBack. Legal classification: Apache = Apache-2.0; LFM = conditional LFM Open License v1.0 (§5).

### 3A. Existing models, exact originals and official vision alternatives

| Source | Exact filename | Bytes | LFS SHA-256 | Runtime/companion requirement |
|---|---|---:|---|---|
| N | `needle3.cact` | 35335380 | `c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38` | Needle3 paired engine; tokenizer embedded; Apache |
| N | `android-arm64/libneedle.a` | 2128166 | `16752fb75adea7af89bbc435a97d1cda7e71bc74d04578d551d0d3bbd5f9e633` | Required FindBack native build input, not an end-user model companion |
| N | `tokenizer/tokenizer.model` | 126520 | `97dfd5666620b19875deba9e55953d312364e7763bd08bee428b94f1b9491b25` | Reference/training tokenizer; upstream says no separate device tokenizer required |
| S | `SmolVLM2-500M.litertlm` | 360822960 | `b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0` | LiteRT-LM; bundled vision encoder/adapter, tokenizer/template; Apache |
| Q06 | `Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm` | 344671744 | `03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856` | LiteRT-LM; existing exact bytes; Apache |
| Q17 | `Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm` | 977184032 | `2a72330b504a6596d53a2c00923c57173b10f1b83e6a541213ffec08d1fc5de8` | LiteRT-LM **>=0.18.0**, bundled model metadata/tokenizer; Apache |
| Q17 | `Qwen3_1.7B.litertlm` | 2056729520 | `362ec1c906a49bbe1e68b118fdb789b70a713063b00ac914043cbda03bcf3d9a` | Distinct dynamic INT8 variant; >=0.18.0; not same-byte alternative |
| L350 | `LFM2-350M-Q4_0.gguf` | 219306944 | `8e3ebc1c608dc8683adf8c3b3e6a40e2f4eab22aa33b908bff2ac03a1c16d796` | llama.cpp LFM2 text; tokenizer/template in GGUF; LFM |
| L700 | `LFM2-700M-Q4_0.gguf` | 446321600 | `bf9c70678aff2a6ee2152b6fef4b2993892eae6449d056cf77cc1e34072424b3` | Same runtime family; LFM |
| L12 | `LFM2-1.2B-Q4_0.gguf` | 695749568 | `2cd9650c6ca71dca428cccb552b65ebc027f6c86c48e530a9d414fd67b33530b` | Same runtime family; LFM |
| G | `granite-3.3-2b-instruct-Q4_0.gguf` | 1453389088 | `d5da3f5bb5a6ae442f830bdde0df4fcccb7e8bd395dc9ee5d28e704db4065592` | llama.cpp Granite text; no vision projector; Apache |
| GB | `ibm-granite_granite-3.3-2b-instruct-Q4_0.gguf` | 1458632256 | `417330dc64f62dde19b285952097b60f2f5a04f73ef7c87d99345749d6d8a896` | Community artifact; **not G bytes**, Apache declaration |
| V450 | `LFM2-VL-450M-Q4_0.gguf` | 219307424 | `1fbf4797e8669cdeabd97fa1d31ab046907cb1fc78b1c3d4bda1ba879574e5d7` | llama.cpp **mtmd** + one matching V450 projector; LFM |
| V450 | `mmproj-LFM2-VL-450M-Q8_0.gguf` | 103890016 | `a6a813fae4ba3f90852a990fdd4786a017dba0e80e599a366853ba539ee2b5ef` | Vision companion; fastest pair shown in official card |
| V450 | `mmproj-LFM2-VL-450M-F16.gguf` | 193346656 | `416a085c5c7ba0f8d02bb8326c719a6f8f2210c2641c6bf64194a57c11c76e59` | Alternative **different-byte** projector, not an extra required second projector |
| V16 | `LFM2-VL-1.6B-Q4_0.gguf` | 695750048 | `ce0d4b122d328d14390ef160785da3a51a527f96844f392a04cb2db96f134e5d` | llama.cpp mtmd + V16 projector; LFM |
| V16 | `mmproj-LFM2-VL-1.6B-Q8_0.gguf` | 564115648 | `65ec437db88d65fff93f472d00c145e09880769ac67fedff5cd1c0f8d8301d87` | Vision companion |
| V16 | `mmproj-LFM2-VL-1.6B-F16.gguf` | 830339008 | `b637bfa6060be2bc7503ec23ba48b407843d08c2ca83f52be206ea8563ccbae2` | Alternative projector |
| QVL | `Qwen3VL-2B-Instruct-Q4_K_M.gguf` | 1107409952 | `089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae` | Official Qwen **Q4_K_M**, not descriptor's claimed LiteRT INT4; mtmd + QVL projector; Apache |
| QVL | `mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf` | 445053216 | `f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82` | Vision companion |
| QVL | `mmproj-Qwen3VL-2B-Instruct-F16.gguf` | 819394848 | `c3d5afbef5287953acd57b4043d2269456e5761a4eaccb3b71b062996970aea5` | Alternative projector |

N also requires the **text header** `android-arm64/needle.h`: 3322 bytes, fetched-text SHA-256 `90f347f9dca1199de79967ab199a56e0588bd473fe306051f8d80d146976a324`; exact [raw source](https://huggingface.co/Cactus-Compute/needle3/raw/c7c415a3d1b3d929014bc6e866d51ebb971f7089/android-arm64/needle.h). This is not an LFS hash. The API's `tokenizer/tokenizer.vocab` is ordinary Git text (106870 bytes, Git blob `25262e86b663f8c9dca1fd94a6f8cf7e37ac0ea7`); no content SHA is asserted here because it is not required for deployment.

### 3B. Official LFM2.5 alternatives — do not rename them LFM2

| Source | Exact filename | Bytes | LFS SHA-256 | Meaning |
|---|---|---:|---|---|
| L2523 | `LFM2.5-230M-Q4_0.gguf` | 149080928 | `430fbec5b1b355e9bb12cd0638c9f2a8f21fedd6eafb4103e42c7e88887daa73` | Official small text model; LFM |
| L2535 | `LFM2.5-350M-Q4_0.gguf` | 219309792 | `85e32858daafad55b7bcd6b97a1343ee0661188e8036f9862d14d6b563142f50` | Official small text model; LFM |
| L25I | `LFM2.5-1.2B-Instruct-Q4_0.gguf` | 695751488 | `2ea801949d760cdf1a2cc04a54262c22c3c0c54f0769d57760c9adeb0e59233f` | Official instruction model; matches existing profile's hash but uses the **correct source/revision** here |
| L25I | `LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf` | 695755488 | `bb741ebb106d543e9de114b843a3d3d73d51c74b5801e69da2abde821a0cb3e1` | Official quantization-aware distilled variant; different weights/artifact, not a mirror |
| L25T | `LFM2.5-1.2B-Thinking-Q4_0.gguf` | 695751680 | `cbabfbf76fdb35f0fc9bc8bf175cbb25173060bc8ff14b9b7d81d3c7a84fc16f` | Distinct thinking model; reasoning/latency budget not qualified |
| L25V450 | `LFM2.5-VL-450M-Q4_0.gguf` | 219311264 | `6d2757dd0f0b98aea7dc90477bb5b3a0df1089be85ef92943f8cecb05121ccbf` | Official vision language component; requires matching projector |
| L25V450 | `mmproj-LFM2.5-VL-450m-Q8_0.gguf` | 102815168 | `ebfc428baa37efad8bae93864f914b2634a09009f91ad59f974fe1a1565d8561` | Matching quantized vision companion; lowercase `m` in filename |
| L25V450 | `mmproj-LFM2.5-VL-450m-F16.gguf` | 189126080 | `51b458cfdbc736982145a35f798ce37611af0aab639e58b33473ba0c7815fd99` | Alternative projector |
| L25V16 | `LFM2.5-VL-1.6B-Q4_0.gguf` | 695752480 | `8186364a4e7c3ad30f6dd3d3b7a4e0074c77dd91eed6cad5d8be9090ce285804` | Official larger vision language component; projector required |
| L25V16 | `mmproj-LFM2.5-VL-1.6b-Q8_0.gguf` | 583109888 | `2ce89e610c56f3198ece2b86cf61743a08b9307279c89125eb2412ebb908689d` | Matching vision companion; lowercase `b` in filename |
| L25V16 | `mmproj-LFM2.5-VL-1.6b-F16.gguf` | 853993856 | `2cddba98b98390c011c606c416de2e63dcfdd3b21452bf71ad6aab59fa52d2ee` | Alternative projector |

These text GGUFs need no external projector or runtime tokenizer file. GGUF encodes model/tokenizer metadata; the caller still must render the **correct model-specific chat template**. The current native lab bridge accepts a prepared prompt and does not apply a chat template itself. Publisher docs demonstrate `llama-cli --conversation` or `llama-mtmd-cli`, not this raw JNI seam. **[INFERRED]** A table of pins alone is insufficient to expose these models in production.

### 3C. Genuine community LiteRT LFM2.5 bundles — not official Liquid LiteRT exports

| Source | Exact filename | Bytes | LFS SHA-256 | Runtime caveat |
|---|---|---:|---|---|
| C25V450 | `LFM2.5-VL-450M_int4.litertlm` | 406820224 | `45a0224180c89a25299078524e5a8dfcce131686fd0f941cdcf3507095db4797` | Stock vision graph; top-quarter defect report |
| C25V450 | `LFM2.5-VL-450M_int4_fixB.litertlm` | 406817104 | `6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033` | Converter-side graph repair; **different artifact** |
| C25V450 | `LFM2.5-VL-450M_int8.litertlm` | 563549568 | `f941a5f9482e31c1b7980456ac94269f2e45fffa28cd49f50c8435475c106dda` | Distinct stock INT8 variant |
| C25V16 | `LFM2.5-VL-1.6B_int4.litertlm` | 1298142592 | `44816005b42bef8887bc3dc40b7d6483ea4dd8569fb1591f00faa33ef3043e8d` | Stock vision graph; same reported defect family |
| C25V16 | `LFM2.5-VL-1.6B_int4_fixB.litertlm` | 1298139472 | `79ca9db8af91e40486a5dfcaf26549180fd6c811ad85f826e3aef20ad0bd565c` | Distinct converter-side repair |
| C25V16 | `LFM2.5-VL-1.6B_int8.litertlm` | 1808995712 | `d6a254aa3edefab51684918e7c717d096c60e495c085fcc35fd845fb8c80c8bd` | Distinct stock INT8 variant |
| C25I | `LFM2.5-1.2B-Instruct_int4.litertlm` | 736015744 | `e904729a8a8a0160658cb7cd22992e270a0547c05cc45b08c47ece5c0e29425b` | Publisher CPU-only; do not assume GPU from extension |
| C25I | `LFM2.5-1.2B-Instruct_int4_gpu.litertlm` | 736220768 | `8d3a4d73e121166ad377e9c51148d38ee383c223661f4219e01f22a0fe1d4a1a` | Publisher CPU + GPU >=0.16; current repack changes GPU defaults, device rows predate repack |
| C25I | `LFM2.5-1.2B-Instruct_int8.litertlm` | 1247091440 | `ed8201f88a1a116218bf03cf7cc5c33accdc2f6f502aa8d682f616beea1ec870` | CPU; current model type >=0.15; tool parsing >=0.18 claimed |

**Bundled companions:** publisher cards explicitly describe complete `.litertlm` bundles with tokenizer, chat template, executor metadata and (for VL) vision encoder/adapter and image-placeholder configuration. No separate `.gguf` `mmproj` belongs beside these LiteRT bundles. `litertlm_manifest.json` is published metadata, not a separately stated runtime dependency. Binary section contents were **not independently inspected** in this no-download pass.

**Local provenance defect:** `modelProfiles.ts:202–235` associates the C25V450 stock/fixB hashes with revision `1abed04b...`. That revision is the **official L25V450 GGUF** repository revision (table above), not a verified LiteRT community revision. `benchmark/labCatalog.ts:294–305` additionally names the **LFM2**, not LFM2.5, repository/file while carrying the LFM2.5 LiteRT hash. Model identity, artifact publisher, exact filename, repository commit and byte hash must be corrected together. Never transplant a commit ID from a different repository merely because both files came from the same model family.

## 4. Provenance and licenses — actual upstream terms

### 4A. Apache-2.0 models

**[VERIFIED]** Qwen3-0.6B, Qwen3-1.7B, Qwen3-VL-2B-Instruct, SmolVLM2-500M-Video-Instruct, Granite 3.3 2B Instruct and Needle3 publishers declare **Apache-2.0**, and their conversion publishers preserve that license declaration. No revenue/MAU threshold occurs in Apache-2.0. Commercial use, redistribution, conversion/quantization and user-local use are permitted subject to its conditions. This does not automatically validate a third party's provenance or FindBack product task suitability.

Exact original-publisher sources:

- Qwen0.6: [pinned original model API](https://huggingface.co/api/models/Qwen/Qwen3-0.6B/revision/c1899de289a04d12100db370d81485cdf75e47ca?blobs=true), [actual LICENSE](https://huggingface.co/Qwen/Qwen3-0.6B/raw/c1899de289a04d12100db370d81485cdf75e47ca/LICENSE), copyright Alibaba Cloud. Qwen1.7: [pinned original API](https://huggingface.co/api/models/Qwen/Qwen3-1.7B/revision/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e?blobs=true), [actual LICENSE](https://huggingface.co/Qwen/Qwen3-1.7B/raw/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/LICENSE).
- Qwen VL: [pinned original API](https://huggingface.co/api/models/Qwen/Qwen3-VL-2B-Instruct/revision/89644892e4d85e24eaac8bacfd4f463576704203?blobs=true); official GGUF card linked below declares Apache-2.0. The original HF inventory has **no standalone LICENSE**. Official code project's [LICENSE](https://raw.githubusercontent.com/QwenLM/Qwen3-VL/main/LICENSE) was read as Apache-2.0, but is a moving code-repo URL, not a substitute for an immutable model-license attachment. Retain the model card's declaration and package the canonical [Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0.txt); owner legal approval remains needed for release packaging.
- Smol: [official original API](https://huggingface.co/api/models/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/revision/7b375e1b73b11138ff12fe22c8f2822d8fe03467?blobs=true); no standalone LICENSE in that inventory. Conversion card explicitly identifies this source (not generic SmolVLM or SmolVLM 500M).
- Granite: [official original API](https://huggingface.co/api/models/ibm-granite/granite-3.3-2b-instruct/revision/707f574c62054322f6b5b04b6d075f0a8f05e0f0?blobs=true), [official GGUF card](https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF/raw/7cdf86ccd1f1bb3491c9b7017b033f2e51367397/README.md). Both declare Apache-2.0; neither listed a standalone LICENSE. GB is community and differs by **5243168 bytes** as well as hash. It is not an IBM endpoint.
- Needle: [actual LICENSE at N](https://huggingface.co/Cactus-Compute/needle3/raw/c7c415a3d1b3d929014bc6e866d51ebb971f7089/LICENSE), 11358 bytes, fetched-text SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`. The engine's license is also relevant, not only the model label `redistributable-cactus`.

Apache **section 4** obligations: give recipients the license; mark modified files prominently; retain relevant copyright/patent/trademark/attribution notices in distributed derivative source; reproduce relevant upstream NOTICE contents when a NOTICE accompanies the work. Patent-litigation termination and lack of trademark rights remain. “Download from upstream” and “import locally” are not separate exemptions from use-license compliance.

**NOTICE audit:** current HF inventories for N/S/Q06/Q17/L350/L700/L12/G/GB/C25V450/C25V16/L25I/L25T/L2523/L2535/L25V16/QVL returned **no filename containing `notice`**. This is a verified repository-inventory observation, **not** proof that every embedded binary or ancestral dependency contains no notices. Preserve card attributions and ship appropriate license texts; run a real release notice inventory later, including native dependencies. No complete NOTICE packet was generated in this research pass.

### 4B. Exact LFM license permissions and commercial limitation

**All investigated LFM2 original text/vision and LFM2.5 alternatives use LFM Open License v1.0**, not Apache-2.0 and not a generic “noncommercial/eval-only” license. Different LICENSE files have whitespace/header differences; do not assume text SHA equality from the license name.

Direct immutable license evidence:

| Model/source | Exact license text |
|---|---|
| LFM2-350M GGUF | [L350/LICENSE](https://huggingface.co/LiquidAI/LFM2-350M-GGUF/raw/8fdc9d526b7ed346b19257551b05816c7912ecc2/LICENSE) |
| LFM2-700M GGUF | [L700/LICENSE](https://huggingface.co/LiquidAI/LFM2-700M-GGUF/raw/fd39e80d7a5ac61494ffff577e61bbbfddbd0d02/LICENSE), fetched 10596 bytes, text SHA-256 `5188f2b355da20647257a3156db5834c794e5fb5e6d8dc4d4cdbb3180e75b85b` |
| LFM2-1.2B GGUF | [L12/LICENSE](https://huggingface.co/LiquidAI/LFM2-1.2B-GGUF/raw/5399e76c648f4eb8c053feb1ab747277dea5bf8b/LICENSE) |
| Original LFM2-VL-450M | [actual LICENSE](https://huggingface.co/LiquidAI/LFM2-VL-450M/raw/d355d88bf86e5c7054230232120e573ca2238286/LICENSE), fetched 10644 bytes, text SHA-256 `61d7e939a05911c765b7e98ffaa1ab5ca6c0174a65350766c25cb10197d19fc8` |
| Original LFM2-VL-1.6B | [actual LICENSE](https://huggingface.co/LiquidAI/LFM2-VL-1.6B/raw/2c2e7f9b0f48a478d7d497ef1864519dfd3994cd/LICENSE), same fetched size/text SHA as preceding row |
| Official LFM2.5-VL-450M | [actual LICENSE](https://huggingface.co/LiquidAI/LFM2.5-VL-450M/raw/fc6221ca597f3315e4f82fc2df606783267b34ba/LICENSE), 10574 bytes, text SHA-256 `4d28ca14dedc0b3d0fcc2b3339f0e79931faa33874f3d24f522183a8fc70068c` |
| Community LFM2.5-VL-450M | [C25V450/LICENSE](https://huggingface.co/litert-community/LFM2.5-VL-450M/raw/da7396bf02715c332c21d0117d48a05851db5fb0/LICENSE); actual text read, same terms |
| Original LFM2-VL GGUFs | [V450/LICENSE](https://huggingface.co/LiquidAI/LFM2-VL-450M-GGUF/raw/7cf9679aa137039135e342aa77014f7b5f2bef73/LICENSE), [V16/LICENSE](https://huggingface.co/LiquidAI/LFM2-VL-1.6B-GGUF/raw/6121de267003bb4d4f325fe10abdc735aee06747/LICENSE); both actual texts fetched |
| Official LFM2.5 text | [L25I/LICENSE](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/raw/8ed288026e23958ad9dfa92d53ed773a8eee7125/LICENSE), [L25T/LICENSE](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking-GGUF/raw/9584426effbfa44b677e925793a12188a36b44ce/LICENSE); actual texts fetched |
| Official LFM2.5 small text | [L2523/LICENSE](https://huggingface.co/LiquidAI/LFM2.5-230M-GGUF/raw/03502067c64ce32ac4fe87b0cec0310a1a13d3e9/LICENSE), [L2535/LICENSE](https://huggingface.co/LiquidAI/LFM2.5-350M-GGUF/raw/657e078c94084481950a2d555a941481f715536b/LICENSE); actual texts fetched |
| Official LFM2.5 vision GGUF | [L25V450/LICENSE](https://huggingface.co/LiquidAI/LFM2.5-VL-450M-GGUF/raw/1abed04b6fe71314d8c446a1371c03d7c332266d/LICENSE), [L25V16/LICENSE](https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-GGUF/raw/36fc16bc95133424921bcc3da009e83b2f23ffb5/LICENSE); actual texts fetched |
| Community LFM2.5 text / 1.6B vision | [C25I/LICENSE](https://huggingface.co/litert-community/LFM2.5-1.2B-Instruct/raw/2b81a4be8ceaec7a74614fc6df2efcae5ed55828/LICENSE), [C25V16/LICENSE](https://huggingface.co/litert-community/LFM2.5-VL-1.6B/raw/7d5dcfca5dba114646a0beb723a55ab9fb30821e/LICENSE); actual texts fetched |

Additional **[VERIFIED] fetched-text byte identities** (not LFS): L350, L700, L25I, L25T, L2535 and C25V16 each returned 10596 bytes, SHA-256 `5188f2b355da20647257a3156db5834c794e5fb5e6d8dc4d4cdbb3180e75b85b`; L12, V450, V16, L25V450, L25V16 and C25I each returned 10644 bytes, SHA-256 `61d7e939a05911c765b7e98ffaa1ab5ca6c0174a65350766c25cb10197d19fc8`. L2523 returned 10574 bytes, SHA-256 `30adf9d6478191fb87f2424f63ba0728598335aaf99cd2848ef17e8e545fe94b`, different from the same-length official 450M VL license above. All fetched texts identify LFM Open License v1.0 and contain the redistribution grant, US$10M threshold and NOTICE obligations. Preserve the **actual same-repository license**, even when its substantive terms look equivalent.

Key actual clauses, not the old code's interpretation:

- **§2:** grants reproduction, derivatives, public display/performance, sublicense and distribution in Source/Object form, subject to terms including §5.
- **§4:** “You may reproduce and distribute copies ... in any medium, with or without modifications ...” provided recipients receive the license, modified files carry notices, relevant source attribution is retained, and applicable NOTICE contents are reproduced. This permits compliant model hosting/bundling/downloading in eligible circumstances; it is not an eval-only clause.
- **§1:** Commercial Use is **direct or indirect** commercial advantage/monetary compensation. Legal Entity includes controlling, controlled and commonly controlled entities; it is not merely revenue earned by FindBack or this feature. Threshold is “annual revenue of 10 million United States dollars ($10,000,000) or more.”
- **§5(a):** commercial rights conditioned on You/Your Legal Entity **“not exceeding the Threshold”**. **§5(b):** commercial use by a Legal Entity **“that exceeds the Threshold”** is not licensed. **[UNKNOWN]** This report does not determine FindBack owner's eligibility, affiliate revenue, or the precise treatment at exactly US$10M; obtain explicit legal interpretation/permission before using a mechanical gate. Conservatively require review at or above US$10M rather than guessing.
- **§5(c):** qualified nonprofit use for **Non-Commercial or Research Purposes** is excepted from the Threshold. This is not a blanket exemption for all nonprofit commercial activity or all small apps.
- **§3:** patent license mentions import, use and transfer. User-local import is not a commercial-restriction bypass; evaluation and local use remain subject to the license.
- **§7:** no general trademark rights. **§11:** automatic termination on noncompliance, cease use and delete copies.

**[INFERRED recommendation]** Replace legal misinformation with a conditional-license policy design only after owner approval: license identity, commercial eligibility, distribution compliance, supported artifact pin, runtime support and device qualification are separate gates. Leave downloads/import unavailable until those gates are deliberately implemented. Research does not authorize enabling them.

## 5. Runtime compatibility and latest stable migration

### 5A. What FindBack actually pins and exposes

**[VERIFIED local]**

- [`android/variables.gradle`](../../apps/mobile/android/variables.gradle): LiteRT-LM **0.17.1**, Kotlin **2.4.0**, coroutines **1.10.2**, app minSdk **24**, NDK **29.0.13113456**, CMake **3.31.6**. `app/build.gradle:388` consumes `com.google.ai.edge.litertlm:litertlm-android:$litertLmVersion`.
- [`scripts/fetch-llama-cpp.mjs`](../../scripts/fetch-llama-cpp.mjs): llama.cpp **v0.5.0**, commit `c13fcbf684171d5e0bca3fc5c34be6a99174b05f`. The misleadingly small version number is a tag, not proof of missing modern model support. [`upstream pinned architecture map`](https://github.com/ggml-org/llama.cpp/blob/c13fcbf684171d5e0bca3fc5c34be6a99174b05f/src/llama-arch.cpp) and the local downloaded source contain `lfm2`, `granite`, `qwen3vl` architecture IDs. **[UNKNOWN]** Successful loads/answers for each artifact on this FindBack build were not measured.
- [`CMakeLists.txt`](../../apps/mobile/android/app/src/main/cpp/CMakeLists.txt): llama JNI is **arm64-v8a lab only**, CPU-only (`n_gpu_layers=0` in bridge), not production. Needle archive/bridge exists only when paired `libneedle.a` and `needle.h` have been fetched, currently arm64.
- [`llama_bridge.cpp`](../../apps/mobile/android/app/src/main/cpp/llama/llama_bridge.cpp): includes `llama.h`, loads one language-model file and tokenizes the supplied prompt. **No mtmd/image/projector API**. Therefore official Qwen/LFM vision GGUFs cannot perform vision merely by being passed into this bridge.
- [`scripts/fetch-needle-model.mjs`](../../scripts/fetch-needle-model.mjs): paired N model/archive/header pins verified against fresh HF metadata/text. No conventional semantic engine version is attached to the script pin; use the **repository revision + library SHA**, not an invented “Cactus latest” version. Upstream has newer package/engine releases; this report does not replace the paired archive.
- [`SmolVlmPlugin.kt`](../../apps/mobile/android/app/src/main/java/com/findback/app/vlm/SmolVlmPlugin.kt): decoder uses `Backend.CPU()` even when the requested **visionBackend** is GPU. Publisher whole-model GPU numbers therefore are not this app's measured configuration.
- [`QwenTextPlugin.kt`](../../apps/mobile/android/app/src/main/java/com/findback/app/ai/QwenTextPlugin.kt): selects text CPU/GPU, creates fresh conversations on a resident engine, extracts `Content.Text` only (`messageText`, lines 443–446). Thinking/channel behavior must be rechecked when selecting the current Q17 configuration; stripping old literal thought delimiters alone is not a complete new-artifact qualification.

### 5B. Fresh official release facts

- [GitHub latest-release API](https://api.github.com/repos/google-ai-edge/LiteRT-LM/releases/latest): `tag_name=v0.18.0`, `prerelease=false`, published **2026-10-06T18:18:59Z**. [Release page](https://github.com/google-ai-edge/LiteRT-LM/releases/tag/v0.18.0).
- [Google Maven metadata](https://dl.google.com/dl/android/maven2/com/google/ai/edge/litertlm/litertlm-android/maven-metadata.xml): `<latest>` and `<release>` **0.18.0**, lastUpdated `20261006154905`.
- [0.18.0 Android POM](https://dl.google.com/dl/android/maven2/com/google/ai/edge/litertlm/litertlm-android/0.18.0/litertlm-android-0.18.0.pom): Apache-2.0 AAR; compile dependencies **Gson 2.14.0**, **kotlin-reflect 2.4.0**, **kotlinx-coroutines-android 1.11.0**. FindBack's declared coroutines is 1.10.2; audit Gradle's resolved graph rather than assume the direct string wins transitive conflict resolution.
- [Release source tree API](https://api.github.com/repos/google-ai-edge/LiteRT-LM/git/trees/v0.18.0?recursive=1) resolves release source to **`b2f686e2ed4718fb84ec398a61dd59ca0f0aff27`**.
- [Immutable Kotlin guide](https://github.com/google-ai-edge/LiteRT-LM/blob/b2f686e2ed4718fb84ec398a61dd59ca0f0aff27/docs/api/kotlin/getting_started.md) still documents `EngineConfig`, CPU/GPU/NPU, visionBackend, `sendMessageAsync`, extra template context and manual/automatic tool handling. Android GPU manifest requires optional `libvndksupport.so`/`libOpenCL.so`. Generic NPU support is **not** evidence that every downloadable file supports every SoC.
- [Immutable ModelInfo implementation](https://github.com/google-ai-edge/LiteRT-LM/blob/b2f686e2ed4718fb84ec398a61dd59ca0f0aff27/kotlin/java/com/google/ai/edge/litertlm/ModelInfo.kt): `ModelInfo.from(path)`, `minRuntimeVersion()`, modality/backend/SoC/context inspection before engine creation. Minimum can be **null**, not a universal compatibility guarantee. No artifact was loaded or introspected here because binaries were not downloaded.
- [Immutable Message API](https://github.com/google-ai-edge/LiteRT-LM/blob/b2f686e2ed4718fb84ec398a61dd59ca0f0aff27/kotlin/java/com/google/ai/edge/litertlm/Message.kt): separate **`channels: Map<String,String>`**, `toolCalls`, and `Contents`/`Content.Text`. Never concatenate channels into consumer text just to make the UI nonempty.

**[UNKNOWN]** The 0.18 AAR's embedded manifest minSdk, actual APK JNI contents/16KiB alignment, resolved dependency graph and device drivers were not binary-inspected. App minSdk 24 is a local declaration, not verified runtime minimum. No build was run, so no claim of a drop-in tested upgrade is made.

### 5C. Per-artifact runtime distinctions

| Artifact | Verified publisher/runtime statements | What remains unverified |
|---|---|---|
| Q06 dynamic INT4 | Current [Q06 card](https://huggingface.co/litert-community/Qwen3-0.6B/raw/e6687177e00897731e7716267eebd4eba0dde7c2/README.md) explicitly says **runs on 0.17.1 and current main**; re-exported 2026-09-20, template accepts string or parts. 4096 context, static prefill lengths 128/1024. | FindBack device task quality, all backend/RAM combinations and new-runtime regression behavior |
| Q06 current dynamic INT8 | **Different artifact** `Qwen3-0.6B.litertlm` now explicitly needs **>=0.18.0**, official Qwen3 config, reasoning channel/tool parsing. Current revision `e6687177...`, 613722264 bytes, SHA `c5f39b4191926786c3e6668b62af4d6eb15248dfc7a5348252a9b406f33f2108`. | Not a same-byte replacement for FindBack dynamic INT4; no recommendation to silently switch |
| Q17 current INT4/INT8 | [Pinned card](https://huggingface.co/litert-community/Qwen3-1.7B/raw/79bf0667b32ae025b972e5fe555fe72ca6e8816c/README.md): **both >=0.18.0**, tested there; thinking on unless `enable_thinking=false`, reasoning in thought channel, tool calls parsed by runtime. | Old card benchmark rows used 0.16/earlier bytes; cannot override new current-byte minimum or be treated as integrated FindBack results |
| S SmolVLM2 | [Current card](https://huggingface.co/litert-community/SmolVLM2-500M/raw/78a25681a0811230bfa3079504a717e9a4a139d1/README.md): image path conversion, 2048 context, bundled tokenizer/template/preprocessing, single-image recommendation. Android 0.16 GPU row was a **text-only** gate; card explicitly says vision GPU not measured there. macOS 0.15 GPU emitted unusable tokens; CPU recommended there. | Exact universal minimum runtime not stated; no full-image device acceptance derived from text-only benchmark |
| C25I LFM2.5 text | [Pinned card](https://huggingface.co/litert-community/LFM2.5-1.2B-Instruct/raw/2b81a4be8ceaec7a74614fc6df2efcae5ed55828/README.md): current `lfm2` type **>=0.15**; CPU for all; `_int4_gpu` GPU **>=0.16**. Latest 2026-10-13 metadata repack adds tool parsing on **0.18**, changes GPU executor defaults, earlier phone GPU rows not rerun. | Fresh current-byte GPU/device and conversation-isolation measurements |
| C25V450/C25V16 | [450M pinned card](https://huggingface.co/litert-community/LFM2.5-VL-450M/raw/da7396bf02715c332c21d0117d48a05851db5fb0/README.md), [1.6B pinned card](https://huggingface.co/litert-community/LFM2.5-VL-1.6B/raw/7d5dcfca5dba114646a0beb723a55ab9fb30821e/README.md): CPU; GPU >=0.16 publisher claims; `fixB` ruler evidence on 0.16.1/0.17.0; one Engine per conversation warning remains on **0.18**. | No FindBack production roles; `fixB` is not proven coordinate-grounding qualification |
| Official LFM2/LFM2.5/Granite text GGUF | Official cards target llama.cpp; pinned llama architecture map includes LFM2/Granite. [L25I card](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/raw/8ed288026e23958ad9dfa92d53ed773a8eee7125/README.md) distinguishes QAD from ordinary Q4_0. | No exact historical minimum llama.cpp build established, no model-load/device outcome here |
| QVL/LFM vision GGUF | [Official QVL card](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/raw/52d6c8ffea26cc873ac5ad116f8631268d7eb503/README.md) documents language+mmproj and `llama-mtmd-cli`; asks for latest llama.cpp and links b6907, not a formally stated minimum. [Official V450 card](https://huggingface.co/LiquidAI/LFM2-VL-450M-GGUF/raw/7cf9679aa137039135e342aa77014f7b5f2bef73/README.md) also uses `llama-mtmd-cli`. | Current FindBack bridge does not support image input/projector loading at all; architecture ID alone is insufficient |
| N Needle3 | Official [format guide](https://cactuscompute.com/blog/cact-format) says tokenizer embedded, generation tag matters, archive tied to engine version within a generation. [Current official card](https://huggingface.co/Cactus-Compute/needle3/raw/93e88ede867e4311c39151285e74df513e4b835b/README.md) describes structured tools/extraction/embedding, not general chat. | Marketing size/context values differ across prose/current examples; use exact pinned byte metadata and actual runtime introspection/device tests, not prose to lower RAM or expand roles |

### 5D. Current upstream correctness blockers

Fresh issue API observations (not independent reproductions):

- [LiteRT-LM #3246 API](https://api.github.com/repos/google-ai-edge/LiteRT-LM/issues/3246), [issue](https://github.com/google-ai-edge/LiteRT-LM/issues/3246): **open**, updated `2026-10-06T11:30:10Z`. Report says LFM2.5-VL encoder has 1024 rows, but runtime forwards only 256 to adapter; top quarter survives. `fixB` re-exports the graphs with pixel-unshuffle inside encoder. Current publisher cards retain the warning; **not** proof 0.18 resolves stock bundles.
- [LiteRT-LM #3165 API](https://api.github.com/repos/google-ai-edge/LiteRT-LM/issues/3165), [issue](https://github.com/google-ai-edge/LiteRT-LM/issues/3165): **open**, updated `2026-10-13T13:53:30Z`. Report concerns cross-conversation prefix dedup/recurrent state. Current C25I/VL cards recommend **fresh Engine per conversation** on 0.18; one short probe passing for a variant does not establish absence of the general hazard. Do not register LFM hybrid candidates into FindBack's resident engine lifecycle without testing isolation/cancellation/unload. This is not a claim that transformer-only Qwen3 or SmolVLM2 has the same recurrent-state bug.

### 5E. Recommended migration investigation, not an implemented migration

**[INFERRED]** To evaluate **current Q17**, move the pinned Android dependency to **0.18.0**, not `latest.release`/main, in a separately approved implementation wave. Required verification before any rollout:

1. Resolve and review Gradle dependencies against the POM (especially coroutines 1.11.0 and Kotlin 2.4.0); check AAR manifest minimum and native packaging/ABI/16KiB page alignment. Do not lower compatibility gates on assumption.
2. Compile both existing LiteRT plugins; keep `Engine`, `Conversation`, sampler, cancellation and background-load ownership canonical. There is documentation-level API overlap, **not** a compile result here.
3. Use new `ModelInfo` for declared runtime minimum/modality/backend/context; missing metadata is unknown, not pass. Enforce current Q17's >=0.18 requirement even if an old benchmark mentions 0.16.
4. Explicitly test `enable_thinking=false` versus enabled reasoning, empty-content/channel-only responses, tool-call objects, unicode, prompt-template parts, output bounds and leak prevention. Current Qwen3 configs are not necessarily the exact behavior of the old Q06 bundle.
5. Re-run exact pinned Q06 and S bytes as regressions on the owner device, CPU/GPU combinations actually used by FindBack, image fixtures including bottom-half/position/counting, cold/warm loading, multiple conversations, cancellation and unload/reload. Separate model's maximum context from FindBack output limits.
6. Test LFM hybrids on a separate evaluation lane with fresh-engine isolation and full-image ruler fixtures; do not infer that upgrading removes open correctness blockers or qualifies extraction/chat/grounding roles.
7. Owner/device measurements and independent reviewer PASS are still required. Any FindBack build must obey the mandatory configured Supabase pre-/post-build checks; this research did not build.

## 6. Same-byte alternatives — observed endpoints, not fabricated mirrors

### 6A. Verified HEAD behavior

HEAD against each exact source below and the same URL with `?download=true` returned **302** and identical **`X-Linked-Etag` = artifact LFS SHA-256**, **`X-Linked-Size` = table bytes**. HEAD against the same path on `https://hf.co/` returned **307** to the identical `huggingface.co` URL. These are **same-service URL alternatives**, not independent hosting/failure domains.

| Verified primary URL (also tested with `?download=true` and `hf.co` host) | Linked content SHA-256 | Linked bytes |
|---|---|---:|
| [Q06 existing resolve](https://huggingface.co/litert-community/Qwen3-0.6B/resolve/a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm) | `03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856` | 344671744 |
| [Q17 current resolve](https://huggingface.co/litert-community/Qwen3-1.7B/resolve/79bf0667b32ae025b972e5fe555fe72ca6e8816c/Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm) | `2a72330b504a6596d53a2c00923c57173b10f1b83e6a541213ffec08d1fc5de8` | 977184032 |
| [N existing resolve](https://huggingface.co/Cactus-Compute/needle3/resolve/c7c415a3d1b3d929014bc6e866d51ebb971f7089/needle3.cact) | `c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38` | 35335380 |
| [S existing resolve](https://huggingface.co/litert-community/SmolVLM2-500M/resolve/dad030b6e56756201d670cfb4d042736a2ce3a5c/SmolVLM2-500M.litertlm) | `b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0` | 360822960 |
| [L350 official resolve](https://huggingface.co/LiquidAI/LFM2-350M-GGUF/resolve/8fdc9d526b7ed346b19257551b05816c7912ecc2/LFM2-350M-Q4_0.gguf) | `8e3ebc1c608dc8683adf8c3b3e6a40e2f4eab22aa33b908bff2ac03a1c16d796` | 219306944 |
| [G official resolve](https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF/resolve/7cdf86ccd1f1bb3491c9b7017b033f2e51367397/granite-3.3-2b-instruct-Q4_0.gguf) | `d5da3f5bb5a6ae442f830bdde0df4fcccb7e8bd395dc9ee5d28e704db4065592` | 1453389088 |

Alternative immutable repository revision URLs, also HEAD-verified with the same linked hash and length:

- [Q06 at current repository revision `e6687177...`](https://huggingface.co/litert-community/Qwen3-0.6B/resolve/e6687177e00897731e7716267eebd4eba0dde7c2/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm).
- [S at current revision `78a25681...`](https://huggingface.co/litert-community/SmolVLM2-500M/resolve/78a25681a0811230bfa3079504a717e9a4a139d1/SmolVLM2-500M.litertlm).
- [N weights at current revision `93e88ede...`](https://huggingface.co/Cactus-Compute/needle3/resolve/93e88ede867e4311c39151285e74df513e4b835b/needle3.cact). **Weights only** equality; this does not authorize substituting a new-revision native archive/header for the N engine pair.

These alternatives are verified metadata equality, not an independent downloaded checksum computation. A future acquisition still must hash all received bytes and match length before installation. No identical-byte external mirror was verified for any other table artifact. Official safetensors, different quantizations, GGUF versus LiteRT, `fixB`, QAD and Bartowski are **not** fallback endpoints for existing hashes.

### 6B. Why a naked content-addressed CDN URL is not safe here

Followed HEAD (still no body) returned **200** and exact Content-Length for Q06, Q17 and N. Redirects used signed URLs under `https://us.aws.cdn.hf.co/xet-bridge-us/...`. The paths below are recorded **only as observed non-working unsigned evidence**, not download recommendations:

| Model | CDN route after signature query removed | Unsigned HEAD |
|---|---|---:|
| Q06 | `https://us.aws.cdn.hf.co/xet-bridge-us/6933120140f459ddcd1e34e1/fefb87b6fd149a4f7ebce4b35e2e4d9d256064fad023161ce08b0573b11d0476` | 403 |
| Q17 | `https://us.aws.cdn.hf.co/xet-bridge-us/6a3cd0921a4628b9942bf432/4194181f1dfeb2aae33aa415dfa9228f86fd2edf7268727570999842f9e77401` | 403 |
| N | `https://us.aws.cdn.hf.co/xet-bridge-us/6aaa3a20fdb71e3f09e002c0/7113b8ae547d87f8fe2a630dfd054beaa0a23017b6117f051ef0895ab97b9e86` | 403 |

The final CDN **ETag equals the Xet route hash**, different from the model-content SHA in the tables. Signed query values are intentionally not persisted. **[INFERRED]** Obtain fresh authorized redirect URLs from pinned HF resolve, follow permitted HTTPS destinations with bounded redirects, and verify actual downloaded SHA/bytes. Do not hardcode expiring signed URLs, construct old LFS CDN paths or call HF alias/`download=true` an independent mirror. **[UNKNOWN]** Stable independent same-byte mirrors/redundant regions were not established.

## 7. Recommended source/policy changes for a later approved wave

These are **recommendations only**; no changes below were applied.

| Priority | Exact change to consider | Evidence/guard |
|---|---|---|
| P0 | Correct LFM license claims in descriptors, profiles, lab catalogue and docs; replace blanket eval-only/redistribution-ban assertions with accurate conditional LFM v1.0 terms | §4 above; keep operational actions disabled until eligibility/compliance review and owner approval |
| P0 | Resolve LFM2-VL versus LFM2.5-VL identity/format mismatch | Do not attach C25V450 hash to Liquid LFM2 repo/official GGUF commit or to invented hyphen `.litertlm` filenames |
| P0 | Keep current Q17 unavailable on LiteRT-LM 0.17.1; plan pinned 0.18 migration before evaluation | Current Q17 card explicitly requires 0.18, Maven stable verified; not a device-qualified upgrade |
| P1 | Point LFM2-350/700/1.2 GGUF provenance to respective official `-GGUF` repositories and attach exact pins in §2/3 | Artifact existence/hash/bytes verified; correcting a pin does not establish supported production ABI/task role |
| P1 | Point Granite Q4_0 at official `ibm-granite/granite-3.3-2b-instruct-GGUF` | Keep GB as separately named community artifact only if deliberately selected; never fail over between G and GB under one hash |
| P1 | Preserve N/S/Q06 existing weight pins unless an evidence-based change is needed | Current-revision HEADs contain same bytes; N engine/archive must stay paired |
| P1 | Keep exact Qwen3-VL LiteRT row unavailable or explicitly define a new GGUF+mmproj evaluation lane | No published exact claimed LiteRT artifact verified; current JNI lacks vision mtmd support |
| P1 | Record acquisition companions, runtime minimum and source publisher separately in a future manifest | Vision GGUF language-only sizes understate total download; both projector and language file need own hashes/bytes/licenses |
| P2 | Add same-byte alternatives only where observed; improve controlled HTTP retry/redirect handling rather than invent mirrors | §6; HF alias/download query/current-revision equality offers no independent outage protection |
| P2 | Evaluate official LFM2.5 candidates deliberately, with exact identity/variant | Smaller text candidates and GGUF/LiteRT choices in §3; `fixB`/QAD/Thinking are distinct artifacts, not source changes to existing models |

### Handoff limits / evidence still required

**[UNKNOWN]** Owner commercial-license eligibility; complete release NOTICE packet; converter's exact original weight commit for every conversion (cards name base models, not always immutable original-weight revisions); downloaded artifact byte hashes; runtime bundle introspection; Android AAR minSdk/native packaging; successful FindBack compile after migration; device ABI/driver/backend availability; actual memory/cold-load/latency; multi-turn privacy/cancellation/unload; schema/extraction fidelity; full-image spatial accuracy; suitable product roles.

**No model-role, RAM estimate, Recommended-tier, download/import availability or device acceptance is promoted by this report.** Exact sources and conditional legal permissions fix research facts, not product qualification.
