---
name: findback-media-pipeline
description: Use when changing FindBack image/video picking, camera/gallery imports, report attachments, avatars, comments media, thumbnails, upload normalization, EXIF/privacy handling, or AI image preparation.
---

# Media pipeline: accept broadly, process safely

## Product contract

User-selected source images up to 100 MB should be accepted when the platform can read them. Do not reject ordinary photos because of arbitrary pixel dimensions, camera megapixels, HEIC/HEIF/AVIF/JPEG/PNG/WebP format, or because AI/upload needs a smaller derivative.

`Accept source` and `decode/infer/upload derivative` are separate concerns.

## Memory rule

Never decode a 100 MB source at full resolution into JS memory. On Android, keep URI/file handling native and stream/probe metadata first. Decode/downsample toward the target task using platform codecs. Large dimensions are handled by sampling/tiling/downscaling, not by rejecting the user's source.

## Derivatives

Keep the source attachment contract distinct from display thumbnail/preview, upload-normalized asset, and AI inference image. Generate bounded derivatives with correct orientation and required metadata stripping while preserving enough detail for lost-item identification. The user should not see a `too many pixels` error for a normal camera image.

## Formats and privacy

Support Android platform-decodable HEIC/HEIF/AVIF and common JPEG/PNG/WebP. Preserve correct orientation. Strip GPS/private EXIF from uploaded/AI derivatives unless explicitly required and consented. Motion Photo should extract the still intentionally.

## Failure UX

`Preparing…`, retry, remove, and actionable format/read errors are acceptable. Silent dropping, generic `invalid image`, hard 2/8/48 MB user-facing caps for otherwise processable sources, or whole-form rejection are not.

## AI

Report-from-photo preparation must call the same canonical derivative pipeline. AI runtime limits must not become picker limits. If a model accepts a smaller image, downsample for that model and continue; do not reject the source.
