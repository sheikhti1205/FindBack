package com.findback.app.media;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;

/** Native permissionless photo picker/document picker and delegated camera capture. */
@CapacitorPlugin(name = "FindbackMedia")
public final class FindbackMediaPlugin extends Plugin {
    private static final MediaRequestState.Registry REGISTRY = new MediaRequestState.Registry();
    private final MediaRequestState requests = new MediaRequestState(REGISTRY);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @PluginMethod public void chooseImage(PluginCall call) {
        String source = call.getString("source", "photos");
        MediaRequestState.Request request = begin(call, source, MediaRequestState.Phase.PICKING);
        if (request == null) return;
        try {
            call.getData().put("mediaRequestId", request.id);
            Intent intent;
            if ("camera".equals(source)) {
                File capture = new File(directory(request.id), "capture.jpg");
                if (!capture.createNewFile()) throw new IllegalStateException("Capture already exists");
                Uri captureUri = captureUri(request.id);
                intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                intent.putExtra(MediaStore.EXTRA_OUTPUT, captureUri);
                intent.setClipData(ClipData.newRawUri("Photo", captureUri));
                intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else if ("photos".equals(source) || "files".equals(source)) {
                if ("photos".equals(source) && Build.VERSION.SDK_INT >= 33) {
                    intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
                    intent.setType("image/*");
                } else {
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("image/*");
                }
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else { throw new IllegalArgumentException("Choose Camera, Photos or Files."); }
            getActivity().runOnUiThread(() -> {
                try { startActivityForResult(call, intent, "imageChosen"); }
                catch (RuntimeException e) { finish(request); call.reject("Couldn't open the device photo picker or camera.", "MEDIA_PICKER_UNAVAILABLE"); }
            });
        } catch (Exception e) {
            finish(request);
            call.reject("Couldn't open the device photo picker or camera.", "MEDIA_PICKER_UNAVAILABLE");
        }
    }
    /**
     * FBX-001: multi-select Photos/Files. Returns the ordered granted content
     * URIs only — no derivative bytes, no original bytes — so the caller imports
     * each one through {@link #importUri} (the same canonical processor the
     * single picker uses). Per-item preparation stays independent: one bad URI
     * never discards its siblings, and selection order is preserved.
     */
    @PluginMethod public void chooseImages(PluginCall call) {
        String source = call.getString("source", "photos");
        if (!"photos".equals(source) && !"files".equals(source)) {
            call.reject("Choose Photos or Files.", "MEDIA_INVALID_SOURCE"); return;
        }
        int limit = call.getInt("limit", 5);
        if (limit < 1) limit = 1;
        MediaRequestState.Request request = begin(call, source, MediaRequestState.Phase.PICKING);
        if (request == null) return;
        try {
            call.getData().put("mediaRequestId", request.id);
            Intent intent;
            if ("photos".equals(source) && Build.VERSION.SDK_INT >= 33) {
                intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
                intent.setType("image/*");
                intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, Math.min(limit, MediaStore.getPickImagesMaxLimit()));
            } else {
                intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "image/*" });
                // A persistable grant lets the caller re-open the URI later (draft
                // recovery); photo-picker grants above are session-scoped instead.
                intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
            getActivity().runOnUiThread(() -> {
                try { startActivityForResult(call, intent, "imagesChosen"); }
                catch (RuntimeException e) { finish(request); call.reject("Couldn't open the device photo picker.", "MEDIA_PICKER_UNAVAILABLE"); }
            });
        } catch (Exception e) {
            finish(request);
            call.reject("Couldn't open the device photo picker.", "MEDIA_PICKER_UNAVAILABLE");
        }
    }
    @ActivityCallback private void imagesChosen(PluginCall call, ActivityResult result) {
        MediaRequestState.Request request = requests.current();
        // Without the saved call's request id this may be a stale callback. It owns no cleanup.
        if (call == null) return;
        if (request == null || !requests.owns(call.getString("mediaRequestId", ""), MediaRequestState.Phase.PICKING)) {
            call.reject("Photo preparation was interrupted. Please choose the photos again.", "MEDIA_INTERRUPTED"); return;
        }
        if (result.getResultCode() != Activity.RESULT_OK) {
            finish(request);
            JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return;
        }
        List<Uri> uris = collectUris(result);
        if (uris.isEmpty()) {
            finish(request);
            call.reject("Couldn't read these photos. Choose them again.", "MEDIA_INVALID_URI"); return;
        }
        if (Build.VERSION.SDK_INT < 33 || "files".equals(request.source)) {
            for (Uri uri : uris) {
                try { getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                catch (RuntimeException ignored) { /* Some providers refuse persistence; the session grant still applies. */ }
            }
        }
        finish(request);
        JSONArray array = new JSONArray();
        for (Uri uri : uris) array.put(uri.toString());
        JSObject out = new JSObject(); out.put("uris", array); call.resolve(out);
    }
    /** Selection order first (ClipData), else a single data URI. Non-content URIs are dropped. */
    private static List<Uri> collectUris(ActivityResult result) {
        List<Uri> out = new ArrayList<>();
        Intent data = result.getData();
        if (data == null) return out;
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null && "content".equals(uri.getScheme())) out.add(uri);
            }
        }
        if (out.isEmpty()) {
            Uri single = data.getData();
            if (single != null && "content".equals(single.getScheme())) out.add(single);
        }
        return out;
    }
    @ActivityCallback private void imageChosen(PluginCall call, ActivityResult result) {
        MediaRequestState.Request request = requests.current();
        // Without the saved call's request id this may be a stale callback. It owns no cleanup.
        if (call == null) return;
        if (request == null || !requests.owns(call.getString("mediaRequestId", ""), MediaRequestState.Phase.PICKING)) {
            call.reject("Photo preparation was interrupted. Please choose the photo again.", "MEDIA_INTERRUPTED"); return;
        }
        if (result.getResultCode() != Activity.RESULT_OK) {
            finish(request);
            JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return;
        }
        Uri uri = "camera".equals(request.source) ? captureUri(request.id) : result.getData() == null ? null : result.getData().getData();
        if (uri == null || !"content".equals(uri.getScheme())) {
            finish(request); call.reject("Couldn't read this photo. Choose it again.", "MEDIA_INVALID_URI"); return;
        }
        requests.processing(request);
        prepare(call, uri, request);
    }
    @PluginMethod public void importUri(PluginCall call) {
        String raw = call.getString("uri");
        Uri uri = raw == null ? null : Uri.parse(raw);
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null) { call.reject("Please choose a photo through the device picker.", "MEDIA_INVALID_URI"); return; }
        MediaRequestState.Request request = begin(call, "uri", MediaRequestState.Phase.PROCESSING);
        if (request != null) prepare(call, uri, request);
    }
    private MediaRequestState.Request begin(PluginCall call, String source, MediaRequestState.Phase phase) {
        try { return requests.begin(source, phase); }
        catch (IllegalStateException e) { call.reject("A photo is already being prepared. Please wait.", "MEDIA_BUSY"); return null; }
    }
    private void prepare(PluginCall call, Uri uri, MediaRequestState.Request request) {
        try { worker.execute(() -> {
            try {
                if (request.cancelled) return;
                JSObject derivative = new NativeImageProcessor(getContext().getContentResolver(), directory(request.id)).prepare(uri, call.getBoolean("highQuality", false));
                if (!request.cancelled) call.resolve(derivative);
            } catch (OutOfMemoryError e) {
                if (!request.cancelled) call.reject("Not enough device memory to prepare this photo. Try a smaller JPEG.", "MEDIA_MEMORY_LIMIT");
            } catch (Exception e) {
                // No URI, file paths, source bytes or internal decoder error strings escape.
                String message = e instanceof MediaPolicy.Failure ? e.getMessage() : "Couldn't prepare this photo. Try re-saving it as JPEG or PNG.";
                if (!request.cancelled) call.reject(message, "MEDIA_PREPARATION_FAILED");
            } finally { finish(request); }
        }); } catch (RuntimeException e) { finish(request); call.reject("Photo preparation was interrupted. Please choose the photo again.", "MEDIA_INTERRUPTED"); }
    }
    private File directory(String id) throws java.io.IOException {
        File directory = new File(getContext().getCacheDir(), "findback-media-" + id);
        if (!directory.isDirectory() && !directory.mkdir()) throw new java.io.IOException("Couldn't prepare temporary photo storage");
        return directory;
    }
    private Uri captureUri(String id) {
        File capture = new File(new File(getContext().getCacheDir(), "findback-media-" + id), "capture.jpg");
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", capture);
    }
    private void finish(MediaRequestState.Request request) { if (requests.finish(request)) cleanup(request.id); }
    private void cleanup(String id) {
        // This path is request-specific. Never sweep cache or delete another live worker's file.
        File directory = new File(getContext().getCacheDir(), "findback-media-" + id);
        try { getContext().revokeUriPermission(captureUri(id), Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION); }
        catch (RuntimeException ignored) { /* No grant may exist for Photos/Files. */ }
        File[] files = directory.listFiles();
        if (files != null) for (File file : files) {
            if (file.getName().equals("capture.jpg") || file.getName().matches("findback-media-still-[A-Za-z0-9_-]+\\.jpg")) file.delete();
        }
        directory.delete();
    }
    @Override protected Bundle saveInstanceState() {
        Bundle state = super.saveInstanceState();
        if (state == null) state = new Bundle();
        Bundle media = saveMediaRequestState();
        if (media != null) state.putAll(media);
        return state;
    }
    /** Also called by the host: Capacitor doesn't save non-activity importUri work itself. */
    public Bundle saveMediaRequestState() {
        MediaRequestState.Snapshot saved = requests.snapshot();
        if (saved == null) return null;
        Bundle state = new Bundle();
        state.putString("mediaRequestId", saved.id);
        state.putString("mediaSource", saved.source);
        state.putString("mediaPhase", saved.phase.name());
        return state;
    }
    @Override protected void restoreState(Bundle state) { restoreMediaRequestState(state); }
    public void restoreMediaRequestState(Bundle state) {
        String phase = state.getString("mediaPhase");
        if (phase == null) return;
        try {
            String abandoned = requests.restore(new MediaRequestState.Snapshot(state.getString("mediaRequestId"), state.getString("mediaSource"), MediaRequestState.Phase.valueOf(phase)));
            if (abandoned != null) cleanup(abandoned);
        } catch (IllegalArgumentException ignored) { /* Ignore invalid saved state, never invent a busy operation. */ }
    }
    @Override protected void handleOnDestroy() {
        // Processing always finishes its own cleanup, even when its result is cancelled on restore.
        MediaRequestState.Request request = requests.current();
        if (!getActivity().isChangingConfigurations() && request != null && requests.owns(request.id, MediaRequestState.Phase.PICKING)) finish(request);
        worker.shutdown();
    }
}
