import { ApiError } from "./session";
import { normalizeImage } from "./image";
import { getSupabase } from "./supabaseClient";
import { diag } from "./diag";
import { MAX_REPORT_PHOTOS, PrepareError } from "./media/prepareImages";
import { displaySizeOrNull } from "./media/displayDimensions";
import { throwIfAborted } from "./timeout";

export interface StoredUpload {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileUrl: string;
  objectKey: string;
  /**
   * Intrinsic dimensions of the stored blob (CF-060 M1), measured after
   * normalization so they describe the bytes actually in Storage. The staging
   * row carries them to the publish RPC, which copies them onto the attachment
   * row the feed lays out from — but only when they are a complete, vouchable
   * pair (`displaySizeOrNull`), because a display hint may never block a publish.
   */
  width: number;
  height: number;
}

export const IMAGES_BUCKET = "findback-images";

/**
 * Hand control back the moment `signal` aborts.
 *
 * The Storage client exposes no abort hook, so the request itself keeps
 * running. What this guarantees is that the caller stops waiting immediately
 * instead of blocking on a stalled upload — and `uploadImage` itself removes
 * the object if the abandoned request later lands, so an abort cannot leave an
 * orphan behind.
 */
function raceAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return (base || "image").slice(0, 120);
}

/**
 * Normalize an image on this device, upload it straight to Supabase Storage under
 * the caller's own folder, then stage an `uploads` row the create-post RPC binds.
 * If staging fails the just-uploaded object is removed so nothing is orphaned.
 */
export async function uploadImage(file: File, traceId?: string, signal?: AbortSignal): Promise<StoredUpload> {
  throwIfAborted(signal);
  const start = Date.now();
  const supabase = getSupabase();
  // Raced when there is a signal: a stalled auth round-trip would otherwise
  // delay a cancel by its full timeout. An abandoned `getUser` has no side
  // effect to clean up, so racing it is free. The `uploads` insert further down
  // is deliberately NOT raced — a staged row that landed after the abort would
  // be a row nobody knows about, which is worse than waiting for a bounded
  // request. That asymmetry is intentional, not an oversight.
  const auth = supabase.auth.getUser();
  const { data: userData, error: userError } = signal ? await raceAbort(auth, signal) : await auth;
  if (userError || !userData.user) {
    diag("posts.upload.auth_error", { message: "Not authenticated" }, { traceId });
    throw new ApiError("Not authenticated", 401);
  }

  // Pass the signal only when there is one, so the no-signal call shape (and its
  // existing assertions) is untouched.
  const normalized = signal
    ? await normalizeImage(file, undefined, { signal })
    : await normalizeImage(file);
  throwIfAborted(signal);
  const id = crypto.randomUUID();
  const objectKey = `${userData.user.id}/${id}.${extensionFor(normalized.mimeType)}`;

  const uploadStart = Date.now();
  const request = supabase.storage
    .from(IMAGES_BUCKET)
    .upload(objectKey, normalized.blob, {
      contentType: normalized.mimeType,
      upsert: false,
    });
  let uploadError: { message: string } | null;
  try {
    const settled = signal ? await raceAbort(request, signal) : await request;
    uploadError = settled.error;
  } catch (err) {
    if (signal?.aborted) {
      // Nobody will stage a row for this object, so if the abandoned request
      // still lands it must be removed rather than left orphaned in Storage.
      // Supabase reports failures in `{ error }` at least as often as by
      // throwing, so both shapes are handled and both are diagnosed: an ignored
      // `{ error }` here would orphan the object silently, which is the exact
      // hazard `removeStagedUpload` documents.
      void request.then((late) => {
        if (late.error) return undefined;
        return supabase.storage.from(IMAGES_BUCKET).remove([objectKey]).then(
          (removed) => {
            if (removed.error) {
              diag("posts.upload.abandoned_cleanup_error", {
                bucket: IMAGES_BUCKET,
                objectKey,
                message: removed.error.message,
              }, { traceId });
            }
          },
          (err: unknown) => {
            diag("posts.upload.abandoned_cleanup_error", {
              bucket: IMAGES_BUCKET,
              objectKey,
              message: err instanceof Error ? err.message : String(err),
            }, { traceId });
          },
        );
      }, () => undefined).catch((err: unknown) => {
        // `storage.from()` can throw synchronously (misconfiguration, a client
        // that is not initialised). Without this the voided chain would reject
        // unhandled — the same hazard the `{ error }` handling above closes.
        diag("posts.upload.abandoned_cleanup_error", {
          bucket: IMAGES_BUCKET,
          objectKey,
          message: err instanceof Error ? err.message : String(err),
        }, { traceId });
      });
    }
    throw err;
  }
  const uploadMs = Date.now() - uploadStart;
  if (uploadError) {
    diag("posts.upload.storage_error", {
      bucket: IMAGES_BUCKET,
      objectKey,
      message: uploadError.message,
      ms: uploadMs,
    }, { traceId });
    throw new ApiError(uploadError.message || "Upload failed", 502);
  }

  const fileUrl = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(objectKey).data.publicUrl;
  const fileName = safeFileName(file.name);
  // The display hint is staged only when it is a complete, vouchable pair. A
  // size outside the hint ceiling (a large animated GIF is passed through
  // untouched) or a half-known size is staged as absent, so the hint can never
  // be the reason a publish fails - the row simply carries no ratio and the feed
  // falls back to a default one.
  const displaySize = displaySizeOrNull(normalized);
  const stageStart = Date.now();
  const { error: stageError } = await supabase.from("uploads").insert({
    id,
    user_id: userData.user.id,
    file_name: fileName,
    mime_type: normalized.mimeType,
    file_size: normalized.blob.size,
    file_url: fileUrl,
    created_at: new Date().toISOString(),
    ...(displaySize ? { width: displaySize.width, height: displaySize.height } : {}),
  });
  const stageMs = Date.now() - stageStart;
  if (stageError) {
    diag("posts.upload.stage_error", {
      table: "uploads",
      message: stageError.message,
      ms: stageMs,
    }, { traceId });
    const { error: rollbackError } = await supabase.storage.from(IMAGES_BUCKET).remove([objectKey]);
    if (rollbackError) {
      diag("posts.upload.rollback_error", {
        bucket: IMAGES_BUCKET,
        objectKey,
        message: rollbackError.message,
      }, { traceId });
      throw new ApiError(
        `Could not stage the upload and could not remove the uploaded object (${rollbackError.message}). ` +
          "It may need manual cleanup.",
        500,
      );
    }
    throw new ApiError(stageError.message || "Could not stage the upload", 500);
  }

  diag("posts.upload.success", {
    id,
    objectKey,
    bytes: normalized.blob.size,
    mimeType: normalized.mimeType,
    width: normalized.width,
    height: normalized.height,
    uploadMs,
    stageMs,
    totalMs: Date.now() - start,
  }, { traceId });

  return {
    id,
    fileName,
    mimeType: normalized.mimeType,
    fileSize: normalized.blob.size,
    fileUrl,
    objectKey,
    width: normalized.width,
    height: normalized.height,
  };
}

export async function removeStagedUpload(stored: StoredUpload, traceId?: string): Promise<void> {
  const supabase = getSupabase();
  // Supabase reports operation failures in { error }, it does not always
  // throw — ignoring it orphans the Storage object while the staging row
  // disappears, so both results are checked.
  const removeStart = Date.now();
  const { error: removeError } = await supabase.storage
    .from(IMAGES_BUCKET)
    .remove([stored.objectKey]);
  const removeMs = Date.now() - removeStart;
  if (removeError) {
    diag("posts.upload.remove_storage_error", {
      bucket: IMAGES_BUCKET,
      objectKey: stored.objectKey,
      message: removeError.message,
      ms: removeMs,
    }, { traceId });
    throw new ApiError(removeError.message || "Could not remove the uploaded photo", 502);
  }
  const deleteStart = Date.now();
  const { error: deleteError } = await supabase.from("uploads").delete().eq("id", stored.id);
  const deleteMs = Date.now() - deleteStart;
  if (deleteError) {
    diag("posts.upload.remove_stage_error", {
      table: "uploads",
      id: stored.id,
      message: deleteError.message,
      ms: deleteMs,
    }, { traceId });
    throw new ApiError(deleteError.message || "Could not remove the staged upload", 500);
  }
  diag("posts.upload.remove_success", {
    id: stored.id,
    objectKey: stored.objectKey,
    removeMs,
    deleteMs,
  }, { traceId });
}

/** Per-upload progress for a batch: completed counts successes so far. */
export interface UploadProgress {
  completed: number;
  total: number;
}

export interface UploadPhotosOptions {
  onProgress?: (progress: UploadProgress) => void;
  traceId?: string;
  /**
   * Cooperative cancel. Checked before each file and threaded into
   * `uploadImage`, so an abort stops the batch at the file in flight instead of
   * waiting for every remaining upload to finish.
   */
  signal?: AbortSignal;
}

/**
 * Remove every staged upload in best-effort order, never throwing: cleanup
 * must not mask the original publish failure. Returns the cleanup errors (if
 * any) so the caller can diag them.
 */
export async function removeStagedUploads(
  staged: readonly StoredUpload[],
  traceId?: string,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const stored of staged) {
    try {
      await removeStagedUpload(stored, traceId);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    diag("posts.upload.batch_cleanup_partial", {
      attempted: staged.length,
      failed: failures.length,
    }, { traceId });
  }
  return failures;
}

/**
 * Stage 0–5 report photos in input order, one independent upload each.
 *
 * The caller must only invoke the create-post RPC after this resolves, which
 * is what makes a failed 3rd-of-5 unable to leave a ghost post: no post row
 * exists until every image is staged. When any upload fails, exactly the
 * objects staged by THIS attempt are removed (best-effort); the caller's
 * local Files are untouched so the draft survives for retry.
 */
export async function uploadPhotos(
  files: readonly File[],
  options: UploadPhotosOptions = {},
): Promise<StoredUpload[]> {
  if (files.length > MAX_REPORT_PHOTOS) {
    throw new PrepareError(
      "REPORT_LIMIT",
      `Reports hold up to ${MAX_REPORT_PHOTOS} photos in a fixed order. ` +
        "The extra photo was not uploaded — remove one first and try again.",
    );
  }
  const staged: StoredUpload[] = [];
  try {
    for (const file of files) {
      throwIfAborted(options.signal);
      const stored = await uploadImage(file, options.traceId, options.signal);
      staged.push(stored);
      options.onProgress?.({ completed: staged.length, total: files.length });
    }
    return staged;
  } catch (err) {
    await removeStagedUploads(staged, options.traceId);
    throw err;
  }
}
