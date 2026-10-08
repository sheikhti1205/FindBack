# Pre-U6 media handoff — 2026-10-08

## Status and ownership

Media-lane implementation, review corrections, and host verification are ready for the main agent to integrate. **This is not physical-device acceptance or U6 completion.** Work stayed on `main` in `/home/sheikh/GitHub/FindBack`. No commits, branches, APK/web builds, installs, or device mutations were performed. No `Help.tsx`, `ChatComposer.tsx`, model metadata, or streaming implementation was edited by this builder. Other agents' shared-workspace changes were left intact.

The requested master plan §§12–16 was read, along with its media acceptance matrix. No output filename was supplied in the delegation, so this owned media-path file is the durable handoff.

## Integration seams (main agent must wire)

From `services/media/nativeMedia.ts`:

```ts
type NativeMediaSource = "photos" | "camera" | "files";
interface NativeMediaOptions {
  highQuality?: boolean;
  text?: string;
  fileName?: string;
}
chooseNativeImage(options: NativeMediaOptions & { source: NativeMediaSource }): Promise<ImportedImage | null>;
importNativeImageUri(uri: string, options?: NativeMediaOptions): Promise<ImportedImage>;
isNativeMediaIntakeAvailable(): boolean;
```

- **Android Camera/Photos/Files must call `chooseNativeImage` instead of opening the HTML File input.** Do not fall back to `File.arrayBuffer()` on Android if the plugin is unavailable or fails. Surface a preparation failure instead.
- `null` means the picker/camera was cancelled; do not add a failed attachment for cancellation.
- The picker currently selects one image per invocation. Repeated selections can use the existing tray limits. Native work/picking is serialized; simultaneous requests get a consumer-safe busy error.
- Native `importNativeImageUri` accepts a granted `content://` URI from another native picker, not a file path or remote URL.
- Both functions return an ordinary `ImportedImage` whose `derivative.bytes` are already bounded/normalized. Add it to the existing tray/storage/upload flow without running the original-byte importer again. Native source bytes or source URI are never returned.
- Create a preview Blob/object URL from `item.derivative.bytes` and `item.derivative.mimeType`, and revoke the object URL on removal/unmount. Preserve the existing explicit-send, approved-image-id, consent, and local/cloud routing gates.
- Main owns Preparing/Ready/Failed UI, Retry/Remove, and the add-menu callbacks. Mark Preparing before awaiting preparation and keep a failed row for non-cancellation failures as planned.
- Continue using `frameDisclosureFor(item)`. Motion returns `Motion photo · still frame used.` Sampled animations now truthfully say the animation is **not attached**, rather than claiming it was kept.

For web intake, replace the existing full-size canvas decode helper with:

```ts
import { transcodeImageForWeb } from "../services/media/webTranscode";
// ImportDeps.transcode = transcodeImageForWeb
```

`transcodeImageForWeb(request: TranscodeRequest): Promise<Uint8Array>` requests `createImageBitmap` with target width/height, `imageOrientation: "from-image"`, and high resize quality. It always closes the bitmap; it has no unbounded `<img>` fallback. Unsupported environments get an honest format/preparation error.

## Implemented contracts/invariants

- API 28+: ordinary media is decoded with `ImageDecoder.createSource(ContentResolver, Uri)` and **`setTargetSize` in the header callback**, with software allocation and partial-decode rejection. The native decoder applies orientation.
- API 24–27: header-only BitmapFactory probe, validated dimensions, bounded power-of-two `inSampleSize`, then EXIF rotation/mirroring. HEIC/HEIF/AVIF are refused honestly on these older versions.
- HEIC/HEIF/AVIF still-image platform normalization on supported Android produces JPEG (PNG for alpha preservation). Codec availability remains device-dependent; failures are surfaced without exposing raw platform/provider diagnostics.
- Source probe streams through a 16 KiB buffer and retains at most 64 KiB. Still size ceiling remains 48,000,000 bytes. Native total motion-container scan has an additional 256,000,000-byte ceiling; large video tails do not enter JS.
- 120 MP / 32,768 source-edge sanity limits remain. Standard and HQ both decode to at most **1920 px per edge**, never full resolution just because HQ is enabled. HQ changes only the compression ladder.
- Derivative encoded output is bounded to 2,000,000 bytes while writing. New pixel encoding does not copy EXIF/GPS metadata. Native original capture/still cache files are deleted after processing/cancellation; capture grants are revoked.
- JPEG Motion Photos: namespace URIs, not literal writer prefixes, identify Camera/Container/Item/RDF fields. Explicit modern disabled/invalid enabled values override deprecated legacy flags, even duplicate legacy flags. Directory-based Xiaomi media with only the legacy enabled flag is supported. Required item fields, exactly one Primary, exactly one final MotionPhoto, Primary-only padding, and shared zero-length secondary resources are enforced. Primary EOI, video ftyp type, and box length must agree. Malformed modern data never uses a valid legacy offset to bypass validation.
- HEIC/AVIF ftyp sniffing checks major and compatible brands. A bounded top-level BMFF box walk detects `mpvd` before native or web decode and returns safe still-frame/export-JPEG guidance. It never string-matches image payload. HEIC/AVIF Motion Photo extraction is deliberately **not implemented**; these containers are refused rather than silently treated as ordinary stills.
- Only the identified JPEG still prefix is streamed to a native temporary decode source. Video/other trailing items never enter the decoder, derivative, or bridge response. The native/web pure parsers reject uncertain declared motion media with consumer-safe still-frame guidance.
- A non-motion Ultra HDR directory is not falsely refused as a malformed Motion Photo.
- Big-endian JPEG EXIF orientation now calculates the correct oriented web target; existing little-endian behavior remains.
- Native facade validates byte cap, metadata-stripping assertion, format magic, actual derivative header dimensions versus returned dimensions, and target bounds before admitting an `ImportedImage`.
- Native picker: system photo picker on API 33+, scoped document picker on older versions or Files, delegated camera with private cache FileProvider URI. No broad media permission added. Plugin is registered before `super.onCreate`.
- Lifecycle state explicitly records PICKING versus PROCESSING and request identity/source for Camera, Photos, Files, and URI import. MainActivity additionally saves/restores the snapshot because Capacitor only saves the last activity-launched call itself. Restored picker ownership transfers; stale callbacks cannot clean its files. Interrupted live processing is cancelled for delivery while its original worker retains final cleanup ownership. Process-death processing reclaims only that abandoned request's directory. Fresh requests are not cleared by old-worker completion. Every capture/still file lives in a UUID request-owned cache directory; cleanup never sweeps unrelated cache.

## Files changed

Existing files:

- `apps/mobile/android/app/src/main/java/com/findback/app/MainActivity.java`
- `apps/mobile/src/services/media/importImage.ts`
- `apps/mobile/src/services/media/importImage.test.ts`
- `apps/mobile/src/services/media/motionPhoto.ts`
- `apps/mobile/src/services/media/motionPhoto.edge.test.ts`
- `apps/mobile/src/services/media/prepareImages.ts`
- `apps/mobile/src/services/media/prepareImages.test.ts`

New files:

- `apps/mobile/android/app/src/main/java/com/findback/app/media/FindbackMediaPlugin.java`
- `apps/mobile/android/app/src/main/java/com/findback/app/media/NativeImageProcessor.java`
- `apps/mobile/android/app/src/main/java/com/findback/app/media/MediaPolicy.java`
- `apps/mobile/android/app/src/main/java/com/findback/app/media/MediaStreams.java`
- `apps/mobile/android/app/src/main/java/com/findback/app/media/MotionPhotoMetadata.java`
- `apps/mobile/android/app/src/main/java/com/findback/app/media/XmpMotion.java`
- `apps/mobile/android/app/src/main/java/com/findback/app/media/MediaContainerProbe.java`
- `apps/mobile/android/app/src/main/java/com/findback/app/media/MediaRequestState.java`
- `apps/mobile/android/app/src/test/java/com/findback/app/media/MediaPolicyTest.java`
- `apps/mobile/android/app/src/test/java/com/findback/app/media/MediaStreamsTest.java`
- `apps/mobile/android/app/src/test/java/com/findback/app/media/MotionPhotoMetadataTest.java`
- `apps/mobile/android/app/src/test/java/com/findback/app/media/MediaContainerProbeTest.java`
- `apps/mobile/android/app/src/test/java/com/findback/app/media/MediaRequestStateTest.java`
- `apps/mobile/src/services/media/nativeMedia.ts`
- `apps/mobile/src/services/media/nativeMedia.test.ts`
- `apps/mobile/src/services/media/webTranscode.ts`
- `apps/mobile/src/services/media/webTranscode.test.ts`
- `apps/mobile/src/services/media/motionPhoto.modern.test.ts`
- `apps/mobile/src/services/media/motionPhoto.bmff.test.ts`
- `apps/mobile/src/services/media/xmpMotion.ts`
- This handoff file.

Unified diff summary: MainActivity plugin registration and explicit media lifecycle snapshot hook; namespace-aware modern-first parser and uncertain-motion rejection; compatible-brand/top-level BMFF probing; request-phase/ownership model and isolated cache cleanup; bounded native URI picker/processor/policy/stream helpers; compatible imported-image facade; browser target-decode helper; truthful sampled-still disclosure; endian-aware EXIF target calculation; accompanying synthetic/JVM tests. No existing public `importImage`, `prepareImages`, or native-intake signature was removed. The tracked owned diff currently contains 176 additions / 43 deletions across seven files; new Java/TS files are also present as untracked files and are not included in that tracked-only count.

## Verification evidence

The initial implementation pass used this exact external coordination wrapper:

```bash
LOCK='/mnt/c/Users/sheik/My Drive/FindBack-internal/Communication/heavy.lock'; until mkdir "$LOCK" 2>/dev/null; do sleep 3; done; trap 'rm -f "$LOCK/desktop.ini"; rmdir "$LOCK"' EXIT;
```

Review-follow-up commands instead used a workspace-local `flock .git/findback-media-verification.lock` so this builder did not write outside its owned worktree. This serializes only callers using that same local lock, not the external orchestration lock above. The local lock is git-internal, not a source artifact.

Latest full verification after review fixes, workspace-root working directory, **exit 0**:

```bash
flock .git/findback-media-verification.lock sh -c 'npm run test -w apps/mobile -- src/services/media src/services/__tests__/motionPhotoParser.test.ts src/screens/CreateReport.mediaMotion.test.tsx && npm run typecheck -w apps/mobile && npx eslint apps/mobile/src/services/media && apps/mobile/android/gradlew -p apps/mobile/android :app:compileDebugJavaWithJavac :app:testDebugUnitTest --tests "com.findback.app.media.*" -x fetchUseModel -x fetchNeedleEngine -x fetchLlamaCpp --console=plain --quiet && git diff --check'
```

- Latest Vitest run: **156 passed, 1 skipped**, 13 passing files and one intentionally skipped private-photo file. Includes existing generated Motion Photo and CreateReport media regression tests.
- Mobile TypeScript typecheck: **exit 0**.
- Media-directory ESLint: **exit 0**, no diagnostics.
- Native app Java/Kotlin compilation and targeted media JVM tests: **exit 0**. Fresh XML results (2026-10-08T17:15:03Z): MediaPolicy **3/3**, MotionPhotoMetadata **11/11**, MediaStreams **4/4**, MediaContainerProbe **3/3**, MediaRequestState **9/9**, total **30/30**, no errors/failures. Reports live under `apps/mobile/android/app/build/test-results/testDebugUnitTest/TEST-com.findback.app.media.*.xml`.
- `git diff --check`: **exit 0**. This also checked other agents' current tracked diff, without changing it.
- Fetch/model/C++ preparation tasks were explicitly excluded. No APK packaging/native-engine linking or web build was requested or performed.
- Non-quiet native runs reported pre-existing flatDir/deprecated Gradle/Kotlin compatibility warnings; these were not modified in this lane.

### Test-first / red evidence and exact preceding commands

The historical initial-pass commands below used the external wrapper. Commands without another directory stated ran at the workspace root. This records failures honestly rather than relabeling missing-module/fixture errors as behavior proof.

| Command | Observed result |
| --- | --- |
| `npm run test -w apps/mobile -- src/services/media/motionPhoto.modern.test.ts src/services/media/webTranscode.test.ts` | Modern parser 7 failed / 1 passed against old behavior; web helper absent (new-module red). |
| `npm run test -w apps/mobile -- src/services/media/motionPhoto.modern.test.ts src/services/media/webTranscode.test.ts src/services/media/nativeMedia.test.ts src/services/media/importImage.test.ts` | Modern/web green; native facade absent; uncertain-motion test initially exposed a malformed test fixture. |
| `npm run test -w apps/mobile -- src/services/media/importImage.test.ts` | After correcting that fixture: genuine uncertain-motion behavioral red, 1 failed / 30 passed because importer decoded an uncertain container. Later BE fixture initially failed, and its TIFF offset was corrected. |
| `npm run test -w apps/mobile -- src/services/media/nativeMedia.test.ts src/services/media/prepareImages.test.ts && java -version` | Facade 9 passing; sampled-still disclosure genuine red, total 1 failed / 25 passed. Java command did not execute because of `&&`. |
| `java -version &&` lock wrapper + `./gradlew :app:compileDebugUnitTestJavaWithJavac -x fetchUseModel -x fetchNeedleEngine -x fetchLlamaCpp --console=plain` (Android directory) | Java 21.0.12.1; native tests first compiled red for absent policy/parser symbols. |
| `npm run test -w apps/mobile -- src/services/media && npm run typecheck -w apps/mobile && npx eslint apps/mobile/src/services/media` | Initial green: 128 passing / 1 skipped, typecheck and lint exit 0. |
| `./gradlew :app:compileDebugJavaWithJavac :app:testDebugUnitTest --tests 'com.findback.app.media.*' -x fetchUseModel -x fetchNeedleEngine -x fetchLlamaCpp --console=plain` (Android directory) | Initial native green: compiled successfully, initial 8 policy/parser tests passed. |
| `npm run test -w apps/mobile -- src/services/media/motionPhoto.modern.test.ts src/services/media/importImage.test.ts` | Additional genuine red: directory-only legacy-enabled Xiaomi, impossible ftyp length, and non-motion Ultra HDR case; 3 failed / 39 passed. |
| `./gradlew :app:testDebugUnitTest --tests 'com.findback.app.media.*' -x fetchUseModel -x fetchNeedleEngine -x fetchLlamaCpp --console=plain` (Android directory) | Genuine native ftyp-length red: 1 failed / 8 passed. |
| `./gradlew :app:testDebugUnitTest --tests 'com.findback.app.media.*' -x fetchUseModel -x fetchNeedleEngine -x fetchLlamaCpp --console=plain --quiet` (Android directory) | Streaming tests first compiled red for absent streaming helper. |
| Final verification chain above, before final rerun | First failed only on the BE fixture's mistaken TIFF offset, so subsequent `&&` commands did not run; corrected fixture then produced 141 passing / 1 skipped and native 13/13. |
| `npm run test -w apps/mobile -- src/services/media/importImage.test.ts -t 'big-endian EXIF'` | Restored the old little-endian-only implementation solely to verify the corrected regression: genuine BE red (expected 6, got 1). Then restored the endian-aware implementation and reran the full final green chain above. |

Non-heavy terminal inspection commands: `git status --short && git branch --show-current` (main, pre-existing unrelated changes); `ls "/mnt/c/Users/sheik/My Drive/FindBack-internal/Communication" && ls apps/mobile && ls apps/mobile/android` (verified lock parent/work directories); `git diff --stat -- apps/mobile/src/services/media apps/mobile/android/app/src/main/java/com/findback/app/MainActivity.java && git status --short` (ownership audit); `git diff --check && git diff --numstat -- apps/mobile/src/services/media apps/mobile/android/app/src/main/java/com/findback/app/MainActivity.java` (clean whitespace). No git staging/commit/reset/push was done.

### Review-follow-up command evidence

In the current continuation, commands ran at the workspace root. Unless noted, each verification command had the local `flock .git/findback-media-verification.lock` prefix.

- Prior review red: `npm run test -w apps/mobile -- src/services/media/motionPhoto.modern.test.ts src/services/media/motionPhoto.bmff.test.ts src/services/media/importImage.test.ts`: 11 failures (7 modern behavior, 3 missing BMFF export, 1 compatible-brand behavior). Alias fixture replacements were then corrected to rename prefixes/declarations only, not the local `Container:Item` element name.
- `ls .git && flock .git/findback-media-verification.lock sh -c 'npm run test -w apps/mobile -- src/services/media/motionPhoto.modern.test.ts src/services/media/motionPhoto.bmff.test.ts src/services/media/importImage.test.ts && apps/mobile/android/gradlew -p apps/mobile/android :app:compileDebugJavaWithJavac :app:testDebugUnitTest --tests "com.findback.app.media.*" -x fetchUseModel -x fetchNeedleEngine -x fetchLlamaCpp --console=plain --quiet'`: TS 56/56 passed; native lifecycle test compile red for missing `MediaRequestState` (45 missing-symbol diagnostics, not behavioral proof).
- Full local-lock chain shown above after first lifecycle implementation: TS 154 passed / 1 skipped, typecheck/lint/native/whitespace exit 0; native then 26/26.
- `npm run test -w apps/mobile -- src/services/media/motionPhoto.modern.test.ts`: genuine additional precedence red, 1 failed / 19 passed; disabled modern metadata was incorrectly rejected because duplicate deprecated flags were evaluated first.
- `apps/mobile/android/gradlew -p apps/mobile/android :app:testDebugUnitTest --tests 'com.findback.app.media.*' -x fetchUseModel -x fetchNeedleEngine -x fetchLlamaCpp --console=plain --quiet`: first exposed MainActivity override access mismatch (installed Capacitor requires public, not protected). After correcting visibility, the same command produced native precedence behavioral red, 1 failed / 28 passed. XML located failure in `XmpMotion.property` reading duplicate legacy flags. Both parsers now short-circuit modern disabled metadata and do not consult legacy properties when modern metadata exists.
- Full chain after precedence correction: TS 156 passed / 1 skipped; typecheck, lint, Java/Kotlin compile, native 29/29, whitespace all exit 0.
- Final ownership audit also removed cleanup from unidentified (`call == null`) picker callbacks: without a request id they cannot own any current request. A pure-model regression verifies null-request finish cannot release a live picker. Final full chain rerun: TS 156 passed / 1 skipped; typecheck, lint, Java/Kotlin compile, native **30/30**, whitespace all exit 0. Real callback dispatch remains uninstrumented.
- Final read-only audit: `git diff --stat -- apps/mobile/src/services/media apps/mobile/android/app/src/main/java/com/findback/app/MainActivity.java && git diff -- apps/mobile/android/app/src/main/java/com/findback/app/MainActivity.java apps/mobile/src/services/media/importImage.ts apps/mobile/src/services/media/motionPhoto.ts && git status --short`: owned diff inspected, unrelated existing changes left intact. Native XML counts read separately.

Source references: official Motion Photo spec `https://developer.android.google.cn/media/platform/motion-photo-format?hl=en`; installed Capacitor `Bridge.java`, `Plugin.java`, `BridgeActivity.java`; Context7 `/ionic-team/capacitor` lifecycle docs. Compiler evidence overrides documentation's outdated protected-access example.

## Honest remaining rows / limitations

**None of these are claimed device-passed:** physical ARM64 Xiaomi 4928×6560 photo, real 48 MP JPEG, real >16 MB photo, modern/legacy Motion Photo pixel decode, EXIF rotation/mirroring, GPS-bearing source byte audit after real native encode, HEIC/HEIF pixel normalization, PNG/WebP/GIF animated first-frame decode, corrupt/bomb rejection in the actual platform codec, capture/picker cancellation, process-death restoration, memory/thermal cost, upload/AI privacy isolation, TalkBack preparation announcements, and Retry/Remove UI.

The optional private Xiaomi test remains skipped because no private fixture path was supplied. Host tests use synthetic headers/fake encoded pixels or generated streams; they prove parsing, policy, bridge contracts, and stream bounds, not Android codec behavior. Browser decode-option tests use a fake bitmap/canvas; no real browser pixels were decoded in this session.

The bounded XMP readers now have synthetic namespace-alias/disabled/required-field/shared-resource regressions, within the first 64 KiB, maximum 16 items, 512 XML nodes and bounded nesting. They reject DTD/entity declarations; native XML external entity resolution is disabled. Extended XMP packets and HEIF motion-container **extraction** remain unsupported. Top-level BMFF probing is bounded to 512 box headers; it does not decode the video or search payload strings. HEIC/HEIF/AVIF **still-image** normalization uses the Android platform codec and requires device acceptance. Lifecycle tests exercise the pure ownership/phase model, not real Android saved-state callbacks or camera/picker grants. MainActivity/plugin host wiring has compiler proof only, not instrumentation acceptance. On older Android, scoped document picking is used rather than depending on the optional backported photo-picker module. On API 33+ a missing picker activity is a visible failure (Files remains a native document-picker alternative).

Next action: main integrates the Android add-menu callbacks and web transcode seam, preserves the authoritative consent/send gates and generation/account ownership checks, then performs the explicit physical-device media/U6 matrix. Re-run the combined host chain after integration. No implementation blocker remains inside this owned lane; overall media UX/U6 completion remains blocked on main integration and physical acceptance evidence.
