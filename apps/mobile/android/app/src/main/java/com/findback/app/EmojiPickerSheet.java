package com.findback.app;

import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.GridLayout;
import android.widget.ScrollView;
import androidx.fragment.app.DialogFragment;
import java.util.function.Consumer;

/**
 * FBX-016 — native bottom-sheet emoji picker (the Android EmojiPickerView
 * role for the comment composer).
 *
 * <p>A bottom-gravity {@link DialogFragment} hosting a grid of
 * system-font-rendered emoji. Zero new Gradle dependencies: no
 * {@code emojipicker} artifact, no Material bottom-sheet import — the sheet
 * posture comes from window gravity alone, and glyphs render in the device
 * emoji font, which is the source of truth on Android.
 *
 * <p>The device set below is deliberately NOT synced with the web fallback
 * set ({@code EMOJI_WEB_FALLBACK}): each runtime owns its own grid and
 * neither is treated as final. Dismiss without a pick reports cancel; the
 * plugin sanitizes the result again before resolving the bridge.
 */
public final class EmojiPickerSheet extends DialogFragment {

    /**
     * Device-rendered grid (system emoji font): 32 curated glyphs for
     * comments — faces, gestures, hearts, objects — intentionally
     * independent of the web fallback list. This is a compact custom sheet,
     * not the full system emoji catalogue (no categories, skin tones,
     * search, or full Unicode coverage); see FB-AUD-08.
     */
    static final String[] DEVICE_EMOJI = {
        "\uD83D\uDE00", "\uD83D\uDE01", "\uD83D\uDE02", "\uD83E\uDD23",
        "\uD83D\uDE0A", "\uD83D\uDE0D", "\uD83D\uDE18", "\uD83E\uDD73",
        "\uD83D\uDE0E", "\uD83E\uDD14", "\uD83D\uDE05", "\uD83D\uDE2D",
        "\uD83D\uDE21", "\uD83D\uDC4D", "\uD83D\uDC4E", "\uD83D\uDE4F",
        "\uD83D\uDC4F", "\uD83C\uDF89", "❤️", "\uD83D\uDD25",
        "⭐", "\uD83D\uDC40", "\uD83C\uDF81", "\uD83C\uDF08",
        "⚽", "☕", "\uD83C\uDF55", "\uD83C\uDF82",
        "\uD83C\uDF40", "\uD83D\uDC36", "\uD83D\uDC31", "\uD83C\uDF38",
    };

    private Consumer<String> onPick;
    private Runnable onCancel;
    private boolean picked;

    /** Caller-supplied callbacks; both run on the UI thread. */
    public static EmojiPickerSheet create(Consumer<String> onPick, Runnable onCancel) {
        EmojiPickerSheet sheet = new EmojiPickerSheet();
        sheet.onPick = onPick;
        sheet.onCancel = onCancel;
        return sheet;
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container, android.os.Bundle savedInstanceState) {
        ScrollView scroll = new ScrollView(requireContext());
        GridLayout grid = new GridLayout(requireContext());
        grid.setColumnCount(8);
        int padding = (int) (8 * requireContext().getResources().getDisplayMetrics().density);
        grid.setPadding(padding, padding, padding, padding);
        for (String emoji : DEVICE_EMOJI) {
            Button cell = new Button(requireContext(), null, android.R.attr.borderlessButtonStyle);
            cell.setText(emoji);
            cell.setTextSize(24);
            cell.setMinHeight((int) (48 * requireContext().getResources().getDisplayMetrics().density));
            cell.setContentDescription("Insert " + emoji);
            cell.setOnClickListener(v -> {
                picked = true;
                if (onPick != null) onPick.accept(emoji);
                dismissAllowingStateLoss();
            });
            grid.addView(cell);
        }
        scroll.addView(grid);
        return scroll;
    }

    @Override
    public void onStart() {
        super.onStart();
        // Bottom-sheet posture without a Material dependency.
        if (getDialog() != null) {
            Window window = getDialog().getWindow();
            if (window != null) {
                window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                window.setGravity(Gravity.BOTTOM);
            }
        }
    }

    @Override
    public void onCancel(android.content.DialogInterface dialog) {
        super.onCancel(dialog);
        if (!picked && onCancel != null) onCancel.run();
    }
}
