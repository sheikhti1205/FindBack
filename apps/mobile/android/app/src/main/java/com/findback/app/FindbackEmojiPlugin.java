package com.findback.app;

import android.app.Activity;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * FBX-016 — Capacitor bridge for the native comment-composer emoji picker.
 *
 * <p>{@code pickEmoji} presents {@link EmojiPickerSheet} (bottom-sheet grid,
 * device emoji font) and resolves {@code {emoji}} on pick or
 * {@code {cancelled:true}} on dismiss. One outstanding pick at a time
 * ({@code EMOJI_BUSY} otherwise); epoch counters make late sheet callbacks
 * inert after cancel/dispose, so a dismissed sheet can never resolve into a
 * newer pick. Results are sanitized via {@link EmojiPickerPolicy} before
 * crossing the bridge, and nothing is ever logged.
 */
@CapacitorPlugin(name = "FindbackEmoji")
public final class FindbackEmojiPlugin extends Plugin {

    /** UI-thread only: the outstanding bridge call, if any. */
    private PluginCall pendingCall;
    /** UI-thread only: bumped on every pick/cancel so stale callbacks go inert. */
    private int epoch;

    @PluginMethod
    public void pickEmoji(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || !(activity instanceof FragmentActivity)) {
            call.reject("The emoji picker is not available right now.", "EMOJI_UNAVAILABLE");
            return;
        }
        if (pendingCall != null) {
            call.reject("An emoji pick is already open.", "EMOJI_BUSY");
            return;
        }
        pendingCall = call;
        final int myEpoch = ++epoch;
        FragmentActivity fragmentActivity = (FragmentActivity) activity;
        fragmentActivity.runOnUiThread(() -> {
            if (pendingCall == null || epoch != myEpoch) return;
            try {
                EmojiPickerSheet sheet = EmojiPickerSheet.create(
                    emoji -> resolvePick(myEpoch, emoji),
                    () -> resolveCancel(myEpoch));
                sheet.show(fragmentActivity.getSupportFragmentManager(), "findback-emoji");
            } catch (RuntimeException e) {
                resolveUnavailable(myEpoch);
            }
        });
    }

    private PluginCall takeCall(int myEpoch) {
        if (epoch != myEpoch) return null;
        PluginCall call = pendingCall;
        pendingCall = null;
        return call;
    }

    private void resolvePick(int myEpoch, String emoji) {
        PluginCall call = takeCall(myEpoch);
        if (call == null) return;
        String clean = EmojiPickerPolicy.sanitizePickedEmoji(emoji);
        JSObject out = new JSObject();
        if (clean == null) {
            out.put(EmojiPickerPolicy.KEY_CANCELLED, true);
        } else {
            out.put(EmojiPickerPolicy.KEY_EMOJI, clean);
        }
        call.resolve(out);
    }

    private void resolveCancel(int myEpoch) {
        PluginCall call = takeCall(myEpoch);
        if (call == null) return;
        JSObject out = new JSObject();
        out.put(EmojiPickerPolicy.KEY_CANCELLED, true);
        call.resolve(out);
    }

    private void resolveUnavailable(int myEpoch) {
        PluginCall call = takeCall(myEpoch);
        if (call == null) return;
        call.reject("The emoji picker is not available right now.", "EMOJI_UNAVAILABLE");
    }

    @Override
    protected void handleOnDestroy() {
        pendingCall = null;
        epoch++;
    }
}
