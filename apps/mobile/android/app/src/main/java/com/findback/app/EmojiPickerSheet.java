package com.findback.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.GridLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.fragment.app.DialogFragment;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * Native bottom-sheet emoji picker (the Android EmojiPickerView role for the
 * comment composer), modernized 2026-10-14 (owner directive: no more 32-item
 * stub).
 *
 * <p>A bottom-gravity {@link DialogFragment} hosting an indexed Unicode-data
 * catalogue rendered in the device emoji font: category sections with
 * jump-tab navigation (fast scroll equivalent), a Recents section persisted
 * in {@link SharedPreferences}, keyword search, and a Fitzpatrick tone strip
 * applied to toneable bases via {@link EmojiPickerPolicy}.
 *
 * <p>Zero new Gradle dependencies — stock widgets only
 * ({@link ScrollView}/{@link GridLayout}/{@link EditText}), no
 * {@code emojipicker} artifact — so no dependency-pin or release-gate
 * changes are needed. Glyphs render in the device emoji font, which is the
 * source of truth on Android.
 *
 * <p>Lifecycle safety: a fragment recreated by the system (rotation) without
 * callbacks dismisses itself immediately instead of touching null handlers;
 * dismiss without a pick reports cancel exactly once (the plugin's epoch
 * makes any late duplicate inert). One outstanding bridge request at a time
 * is enforced by {@link FindbackEmojiPlugin}. Nothing is ever logged —
 * neither queries nor picks.
 */
public final class EmojiPickerSheet extends DialogFragment {

    private static final int COLUMNS = 8;
    private static final int RECENTS_MAX = 24;
    private static final int SEARCH_RESULT_CAP = 120;
    private static final String PREFS = "findback_emoji";
    private static final String KEY_RECENTS = "recents_v1";
    /** Unit separator — can never appear in a sanitized single pick. */
    private static final String RECENT_SEP = "\u001F";

    /** One catalogue row: the visible pick plus its search index. */
    private static final class Entry {
        final String ch;
        final String name;
        final String keywords;
        Entry(String ch, String name, String keywords) {
            this.ch = ch;
            this.name = name;
            this.keywords = keywords;
        }
    }

    /** One catalogue section: label plus entries in display order. */
    private static final class Category {
        final String label;
        final List<Entry> items = new ArrayList<>();
        Category(String label) {
            this.label = label;
        }
    }

    private static void add(Category cat, String ch, String name, String keywords) {
        cat.items.add(new Entry(ch, name, keywords));
    }

    /** The indexed catalogue: categories × keyword-indexed entries. */
    static List<Category> catalogue() {
        List<Category> cats = new ArrayList<>();

        Category smileys = new Category("Smileys");
        add(smileys, "\uD83D\uDE00", "grinning face", "happy smile grin");
        add(smileys, "\uD83D\uDE01", "beaming face", "happy smile grin teeth");
        add(smileys, "\uD83D\uDE02", "face with tears of joy", "laugh lol funny crying");
        add(smileys, "\uD83E\uDD23", "rolling on the floor laughing", "laugh lol rofl funny");
        add(smileys, "\uD83D\uDE0A", "smiling face with smiling eyes", "happy warm blush");
        add(smileys, "\uD83D\uDE0D", "smiling face with heart-eyes", "love crush heart eyes");
        add(smileys, "\uD83D\uDE18", "face blowing a kiss", "love kiss heart");
        add(smileys, "\uD83E\uDD73", "partying face", "celebrate birthday party hat");
        add(smileys, "\uD83D\uDE0E", "smiling face with sunglasses", "cool confident");
        add(smileys, "\uD83E\uDD14", "thinking face", "hmm wonder consider");
        add(smileys, "\uD83D\uDE05", "grinning face with sweat", "nervous relief phew");
        add(smileys, "\uD83D\uDE2D", "loudly crying face", "cry tears sad sob");
        add(smileys, "\uD83D\uDE21", "enraged face", "angry mad furious red");
        add(smileys, "\uD83E\uDD7A", "pleading face", "puppy eyes beg please");
        add(smileys, "\uD83D\uDE34", "sleeping face", "sleep tired snore zzz");
        add(smileys, "\uD83E\uDD2F", "exploding head", "mind blown shock wow");
        add(smileys, "\uD83D\uDE43", "upside-down face", "silly sarcasm");
        add(smileys, "\uD83D\uDE09", "winking face", "wink flirt joke");
        add(smileys, "\uD83E\uDD17", "face savoring food", "yum tasty delicious tongue");
        add(smileys, "\uD83E\uDD17", "hugging face", "hug embrace thanks");
        add(smileys, "\uD83E\uDD2D", "face with hand over mouth", "giggle oops secret");
        add(smileys, "\uD83E\uDEE3", "face with peeking eye", "shy peek embarrassed");
        add(smileys, "\uD83D\uDE2C", "grimacing face", "awkward yikes oops");
        add(smileys, "\uD83E\uDD72", "smiling face with tear", "touched grateful bittersweet");
        add(smileys, "\uD83D\uDE24", "face with steam from nose", "frustrated huff determined");
        add(smileys, "\uD83E\uDD20", "cowboy hat face", "cowboy yeehaw");
        add(smileys, "\uD83D\uDE07", "smiling face with halo", "angel innocent blessed");
        add(smileys, "\uD83E\uDD29", "star-struck", "excited star eyes wow");
        add(smileys, "\uD83E\uDD12", "money-mouth face", "rich money dollar");
        add(smileys, "\uD83E\uDD12", "face with thermometer", "sick ill fever");
        add(smileys, "\uD83E\uDD15", "face with head-bandage", "hurt injured ouch");
        add(smileys, "\uD83E\uDD74", "woozy face", "dizzy drunk tired");
        add(smileys, "\uD83D\uDE35", "face with crossed-out eyes", "dizzy dead overwhelmed");
        add(smileys, "\uD83E\uDD76", "cold face", "freezing cold ice winter");
        add(smileys, "\uD83E\uDD75", "hot face", "heat sweating summer");
        add(smileys, "\uD83D\uDC7B", "ghost", "spooky halloween boo");
        add(smileys, "\uD83D\uDC80", "skull", "dead skeleton danger");
        add(smileys, "\uD83E\uDD16", "robot", "bot ai machine");
        add(smileys, "\uD83C\uDF83", "jack-o-lantern", "halloween pumpkin spooky");
        add(smileys, "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67", "family", "family parents child together");
        add(smileys, "\uD83E\uDEE1", "saluting face", "salute respect yes sir");
        cats.add(smileys);

        Category gestures = new Category("Gestures");
        add(gestures, "\uD83D\uDC4D", "thumbs up", "yes approve like good agree");
        add(gestures, "\uD83D\uDC4D\uD83C\uDFFB", "thumbs up light skin tone", "yes approve light");
        add(gestures, "\uD83D\uDC4D\uD83C\uDFFC", "thumbs up medium-light skin tone", "yes approve");
        add(gestures, "\uD83D\uDC4D\uD83C\uDFFD", "thumbs up medium skin tone", "yes approve");
        add(gestures, "\uD83D\uDC4D\uD83C\uDFFE", "thumbs up medium-dark skin tone", "yes approve");
        add(gestures, "\uD83D\uDC4D\uD83C\uDFFF", "thumbs up dark skin tone", "yes approve dark");
        add(gestures, "\uD83D\uDC4E", "thumbs down", "no dislike bad disagree");
        add(gestures, "\uD83D\uDE4F", "folded hands", "please thanks pray grateful hope");
        add(gestures, "\uD83D\uDE4F\uD83C\uDFFB", "folded hands light skin tone", "please thanks light");
        add(gestures, "\uD83D\uDE4F\uD83C\uDFFD", "folded hands medium skin tone", "please thanks");
        add(gestures, "\uD83D\uDE4F\uD83C\uDFFF", "folded hands dark skin tone", "please thanks dark");
        add(gestures, "\uD83D\uDC4F", "clapping hands", "applause congratulations well done");
        add(gestures, "\uD83D\uDC4F\uD83C\uDFFB", "clapping hands light skin tone", "applause light");
        add(gestures, "\uD83D\uDC4F\uD83C\uDFFD", "clapping hands medium skin tone", "applause");
        add(gestures, "\uD83D\uDC4F\uD83C\uDFFF", "clapping hands dark skin tone", "applause dark");
        add(gestures, "\uD83D\uDC4B", "waving hand", "hello hi bye wave");
        add(gestures, "\uD83D\uDC4B\uD83C\uDFFB", "waving hand light skin tone", "hello hi light");
        add(gestures, "\uD83D\uDC4B\uD83C\uDFFD", "waving hand medium skin tone", "hello hi");
        add(gestures, "\uD83D\uDC4B\uD83C\uDFFF", "waving hand dark skin tone", "hello hi dark");
        add(gestures, "\uD83E\uDD1D", "handshake", "deal agree support partner");
        add(gestures, "\u270A", "raised fist", "solidarity power protest");
        add(gestures, "\u270C\uFE0F", "victory hand", "peace victory two");
        add(gestures, "\uD83E\uDD1E", "crossed fingers", "luck hope wish");
        add(gestures, "\uD83D\uDE4C", "raising hands", "celebrate hooray praise");
        add(gestures, "\uD83D\uDC4C", "OK hand", "ok perfect fine");
        add(gestures, "\uD83E\uDD32", "palms up together", "pray hope dua humble");
        add(gestures, "\uD83E\uDDB6", "heart hands", "love heart hands thanks");
        add(gestures, "\uD83D\uDCAA", "flexed biceps", "strong muscle power");
        add(gestures, "\uD83D\uDC40", "eyes", "look see watch notice");
        add(gestures, "\uD83D\uDE48", "see-no-evil monkey", "shy embarrassed ignore");
        add(gestures, "\uD83D\uDE49", "hear-no-evil monkey", "ignore listen");
        add(gestures, "\uD83D\uDE4A", "speak-no-evil monkey", "silent secret oops");
        cats.add(gestures);

        Category hearts = new Category("Hearts");
        add(hearts, "❤️", "red heart", "love like heart red");
        add(hearts, "\uD83E\uDDE1", "orange heart", "love heart orange");
        add(hearts, "\uD83D\uDC9B", "yellow heart", "love heart yellow");
        add(hearts, "\uD83D\uDC9A", "green heart", "love heart green");
        add(hearts, "\uD83D\uDC99", "blue heart", "love heart blue");
        add(hearts, "\uD83D\uDC9C", "purple heart", "love heart purple");
        add(hearts, "\uD83D\uDDA4", "black heart", "love heart black");
        add(hearts, "\uD83E\uDD0D", "white heart", "love heart white");
        add(hearts, "\uD83D\uDC94", "broken heart", "heartbreak sad split");
        add(hearts, "\uD83D\uDC95", "two hearts", "love hearts affection");
        add(hearts, "\uD83D\uDC96", "sparkling heart", "love sparkle heart");
        add(hearts, "\uD83D\uDC97", "growing heart", "love heart growing");
        add(hearts, "\uD83D\uDC98", "heart with arrow", "love cupid crush");
        add(hearts, "\uD83D\uDC9D", "heart with ribbon", "love gift heart");
        add(hearts, "❣️", "heart exclamation", "love heart emphasis");
        cats.add(hearts);

        Category nature = new Category("Nature");
        add(nature, "\uD83D\uDC36", "dog face", "dog puppy pet");
        add(nature, "\uD83D\uDC31", "cat face", "cat kitten pet");
        add(nature, "\uD83E\uDD8A", "fox", "fox clever");
        add(nature, "\uD83D\uDC3C", "panda", "panda bear cute");
        add(nature, "\uD83E\uDD81", "lion", "lion king brave");
        add(nature, "\uD83D\uDC38", "frog", "frog toad");
        add(nature, "\uD83D\uDC35", "monkey face", "monkey playful");
        add(nature, "\uD83E\uDD8B", "butterfly", "butterfly transform pretty");
        add(nature, "\uD83D\uDC1D", "honeybee", "bee honey busy");
        add(nature, "\uD83C\uDF38", "cherry blossom", "flower spring blossom pink");
        add(nature, "\uD83C\uDF39", "rose", "flower rose love red");
        add(nature, "\uD83C\uDF3B", "sunflower", "flower sunflower sunny");
        add(nature, "\uD83C\uDF08", "rainbow", "rainbow pride hope colorful");
        add(nature, "☀️", "sun", "sunny day bright weather");
        add(nature, "\uD83C\uDF19", "crescent moon", "night moon sleep");
        add(nature, "⭐", "star", "star favorite night");
        add(nature, "\uD83D\uDD25", "fire", "hot lit flame trending");
        add(nature, "\uD83D\uDCA7", "droplet", "water drop tear");
        add(nature, "\uD83C\uDF0A", "water wave", "ocean sea wave");
        add(nature, "\uD83C\uDF40", "four leaf clover", "lucky clover fortune");
        cats.add(nature);

        Category food = new Category("Food");
        add(food, "☕", "hot beverage", "coffee tea hot drink");
        add(food, "\uD83C\uDF55", "pizza", "pizza slice cheese");
        add(food, "\uD83C\uDF82", "birthday cake", "birthday cake celebrate sweet");
        add(food, "\uD83C\uDF54", "hamburger", "burger fast food");
        add(food, "\uD83C\uDF69", "doughnut", "donut sweet");
        add(food, "\uD83C\uDF4E", "red apple", "apple fruit healthy");
        add(food, "\uD83C\uDF47", "grapes", "grapes fruit");
        add(food, "\uD83C\uDF53", "strawberry", "strawberry fruit berry");
        add(food, "\uD83E\uDD51", "avocado", "avocado healthy toast");
        add(food, "\uD83C\uDF5C", "steaming bowl", "noodles ramen soup");
        add(food, "\uD83C\uDF70", "shortcake", "cake dessert sweet");
        add(food, "\uD83E\uDDC1", "cupcake", "cupcake dessert sweet");
        add(food, "\uD83C\uDF6A", "cookie", "cookie biscuit sweet");
        add(food, "\uD83C\uDF49", "watermelon", "watermelon fruit summer");
        add(food, "\uD83E\uDD6D", "mango", "mango fruit tropical");
        add(food, "\uD83C\uDF4D", "pineapple", "pineapple tropical fruit");
        add(food, "\uD83E\uDD64", "cup with straw", "drink soda juice");
        add(food, "\uD83C\uDF7A", "beer mug", "beer drink cheers");
        cats.add(food);

        Category play = new Category("Play");
        add(play, "⚽", "soccer ball", "football soccer sport");
        add(play, "\uD83C\uDFC0", "basketball", "basketball sport");
        add(play, "\uD83C\uDFCF", "cricket game", "cricket bat ball sport");
        add(play, "\uD83C\uDFF8", "badminton", "badminton shuttle sport");
        add(play, "\uD83C\uDFBE", "tennis", "tennis sport ball");
        add(play, "\uD83C\uDFCA", "person swimming", "swim pool sport");
        add(play, "\uD83D\uDEB4", "person biking", "cycling bike sport");
        add(play, "\uD83C\uDFAE", "video game", "gaming controller play");
        add(play, "\uD83C\uDFB2", "game die", "dice game random luck");
        add(play, "\uD83C\uDFAF", "bullseye", "target direct hit goal");
        add(play, "\uD83C\uDFA8", "artist palette", "art paint creative");
        add(play, "\uD83C\uDFAD", "performing arts", "theater drama masks");
        add(play, "\uD83C\uDFA4", "microphone", "sing karaoke mic");
        add(play, "\uD83C\uDFA7", "headphone", "music listen audio");
        add(play, "⚾", "baseball", "baseball sport");
        add(play, "\uD83C\uDFAA", "circus tent", "circus carnival fun");
        cats.add(play);

        Category travel = new Category("Travel");
        add(travel, "\uD83D\uDE97", "automobile", "car drive road");
        add(travel, "\uD83D\uDEB2", "bicycle", "bike cycling");
        add(travel, "✈️", "airplane", "flight travel plane trip");
        add(travel, "\uD83D\uDE80", "rocket", "launch space fast ship");
        add(travel, "\uD83D\uDE82", "locomotive", "train railway");
        add(travel, "\uD83C\uDFDD️", "desert island", "island beach vacation");
        add(travel, "\uD83D\uDDFA️", "world map", "map travel directions");
        add(travel, "\uD83E\uDDF3", "luggage", "travel bag suitcase trip");
        add(travel, "⛺", "tent", "camping tent outdoors");
        add(travel, "\uD83C\uDFD6️", "beach with umbrella", "beach vacation sea");
        add(travel, "\uD83D\uDEF5", "motor scooter", "scooter bike");
        add(travel, "\uD83D\uDE81", "helicopter", "helicopter rescue fly");
        add(travel, "⛵", "sailboat", "sail boat sea");
        add(travel, "\uD83D\uDEA6", "traffic light", "traffic signal stop");
        cats.add(travel);

        Category objects = new Category("Objects");
        add(objects, "\uD83C\uDF81", "wrapped gift", "gift present surprise birthday");
        add(objects, "\uD83D\uDCA1", "light bulb", "idea helpful bright tip");
        add(objects, "\uD83D\uDCF1", "mobile phone", "phone mobile smartphone");
        add(objects, "\uD83D\uDCBB", "laptop", "computer laptop work");
        add(objects, "\uD83D\uDCF7", "camera", "photo camera picture");
        add(objects, "\uD83C\uDFA5", "movie camera", "video film record");
        add(objects, "\uD83D\uDD11", "key", "key lock access found");
        add(objects, "\uD83D\uDD12", "locked", "lock secure private safe");
        add(objects, "\uD83D\uDCB0", "money bag", "money cash rich reward");
        add(objects, "\uD83C\uDF92", "backpack", "bag school travel lost");
        add(objects, "\uD83D\uDCDA", "books", "books study read");
        add(objects, "✏️", "pencil", "write edit pencil");
        add(objects, "\uD83E\uDDF8", "teddy bear", "teddy cute toy child");
        add(objects, "\uD83E\uDEB4", "potted plant", "plant green home");
        add(objects, "⏰", "alarm clock", "alarm time reminder");
        add(objects, "\uD83D\uDD14", "bell", "notification alert ring");
        add(objects, "\uD83C\uDF88", "balloon", "party celebrate birthday");
        add(objects, "\uD83E\uDDC3", "beverage box", "juice drink box");
        add(objects, "\uD83D\uDCE6", "package", "box parcel delivery");
        add(objects, "\uD83D\uDED2", "shopping cart", "shop buy market");
        cats.add(objects);

        Category symbols = new Category("Symbols");
        add(symbols, "✅", "check mark button", "done correct yes verified");
        add(symbols, "❌", "cross mark", "no wrong delete error");
        add(symbols, "➕", "plus", "add more plus");
        add(symbols, "➖", "minus", "remove less minus");
        add(symbols, "➡️", "right arrow", "next right forward");
        add(symbols, "⬅️", "left arrow", "back left previous");
        add(symbols, "⬆️", "up arrow", "up upload top");
        add(symbols, "⬇️", "down arrow", "down download bottom");
        add(symbols, "ℹ️", "information", "info help details");
        add(symbols, "⚠️", "warning", "caution alert careful");
        add(symbols, "♻️", "recycling symbol", "recycle reuse green");
        add(symbols, "\uD83D\uDCAF", "hundred points", "perfect 100 score");
        add(symbols, "✳️", "eight-spoked asterisk", "star sparkle");
        add(symbols, "❇️", "sparkle", "sparkle shine new");
        add(symbols, "\uD83D\uDD23", "input symbols", "symbols input");
        add(symbols, "©️", "copyright", "copyright rights");
        add(symbols, "\uD83C\uDF89", "party popper", "celebrate congrats party tada");
        add(symbols, "\uD83E\uDD47", "1st place medal", "gold winner first champion");
        cats.add(symbols);

        Category flags = new Category("Flags");
        add(flags, "\uD83C\uDDE7\uD83C\uDDE9", "flag Bangladesh", "bangladesh flag bd dhaka");
        add(flags, "\uD83C\uDDFA\uD83C\uDDF8", "flag United States", "usa america flag us");
        add(flags, "\uD83C\uDDEC\uD83C\uDDE7", "flag United Kingdom", "uk britain england flag");
        add(flags, "\uD83C\uDDEE\uD83C\uDDF3", "flag India", "india flag");
        add(flags, "\uD83C\uDDF5\uD83C\uDDF0", "flag Pakistan", "pakistan flag");
        add(flags, "\uD83C\uDDE8\uD83C\uDDE6", "flag Canada", "canada flag");
        add(flags, "\uD83C\uDDE6\uD83C\uDDFA", "flag Australia", "australia flag");
        add(flags, "\uD83C\uDDEF\uD83C\uDDF5", "flag Japan", "japan flag");
        add(flags, "\uD83C\uDDE9\uD83C\uDDEA", "flag Germany", "germany flag");
        add(flags, "\uD83C\uDDEB\uD83C\uDDF7", "flag France", "france flag");
        add(flags, "\uD83C\uDDF8\uD83C\uDDE6", "flag Saudi Arabia", "saudi arabia flag");
        add(flags, "\uD83C\uDDE6\uD83C\uDDEA", "flag United Arab Emirates", "uae dubai emirates flag");
        add(flags, "\uD83C\uDFF3️\u200D\uD83C\uDF08", "rainbow flag", "pride rainbow flag");
        cats.add(flags);

        return cats;
    }

    /** Case-insensitive keyword/name search across the catalogue, capped. */
    static List<Entry> search(List<Category> cats, String query) {
        List<Entry> out = new ArrayList<>();
        String q = query == null ? "" : query.trim().toLowerCase(java.util.Locale.ROOT);
        if (q.isEmpty()) return out;
        for (Category cat : cats) {
            for (Entry item : cat.items) {
                if (out.size() >= SEARCH_RESULT_CAP) return out;
                if (item.name.contains(q) || item.keywords.contains(q) || item.ch.contains(q)) {
                    out.add(item);
                }
            }
        }
        return out;
    }

    private Consumer<String> onPick;
    private Runnable onCancel;
    private boolean picked;
    private String toneModifier = "";
    private final List<Category> cats = catalogue();

    /** Caller-supplied callbacks; both run on the UI thread. */
    public static EmojiPickerSheet create(Consumer<String> onPick, Runnable onCancel) {
        EmojiPickerSheet sheet = new EmojiPickerSheet();
        sheet.onPick = onPick;
        sheet.onCancel = onCancel;
        return sheet;
    }

    private int dp(float value) {
        return (int) (value * requireContext().getResources().getDisplayMetrics().density);
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container, android.os.Bundle savedInstanceState) {
        // Rotation recreates the fragment without our callbacks: dismiss
        // instead of touching null handlers (the bridge epoch is already
        // stale, so the outstanding pick resolves as unavailable/cancel).
        if (onPick == null || onCancel == null) {
            dismissAllowingStateLoss();
            return new View(requireContext());
        }
        Context context = requireContext();
        int cellPx = Math.max(dp(48), context.getResources().getDisplayMetrics().widthPixels / COLUMNS);

        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);

        EditText search = new EditText(context);
        search.setHint("Search emoji");
        search.setSingleLine(true);
        search.setInputType(InputType.TYPE_CLASS_TEXT);
        search.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        search.setMinHeight(dp(48));
        search.setContentDescription("Search emoji");
        root.addView(search, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        HorizontalScrollView toneScroll = new HorizontalScrollView(context);
        toneScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout toneRow = new LinearLayout(context);
        toneRow.setOrientation(LinearLayout.HORIZONTAL);
        toneScroll.addView(toneRow);
        root.addView(toneScroll, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        HorizontalScrollView tabScroll = new HorizontalScrollView(context);
        tabScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout tabRow = new LinearLayout(context);
        tabRow.setOrientation(LinearLayout.HORIZONTAL);
        tabScroll.addView(tabRow);
        root.addView(tabScroll, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ScrollView mainScroll = new ScrollView(context);
        LinearLayout sections = new LinearLayout(context);
        sections.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(8);
        sections.setPadding(padding, padding, padding, padding * 3);
        mainScroll.addView(sections);
        root.addView(mainScroll, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(360)));

        GridLayout results = new GridLayout(context);
        results.setColumnCount(COLUMNS);
        results.setVisibility(View.GONE);
        ScrollView resultsScroll = new ScrollView(context);
        resultsScroll.addView(results);
        resultsScroll.setVisibility(View.GONE);
        root.addView(resultsScroll, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(360)));

        // Tone strip: Default + five Fitzpatrick modifiers.
        Button defaultTone = toneButton(context, "Default", "Skin tone: default");
        defaultTone.setAlpha(1f);
        List<Button> toneButtons = new ArrayList<>();
        toneButtons.add(defaultTone);
        final String[] toneNames = {"light", "medium-light", "medium", "medium-dark", "dark"};
        for (int i = 0; i < EmojiPickerPolicy.TONE_MODIFIERS.length; i++) {
            final String modifier = EmojiPickerPolicy.TONE_MODIFIERS[i];
            Button tone = toneButton(context, "\uD83D\uDC4D" + modifier, "Skin tone: " + toneNames[i]);
            tone.setAlpha(0.5f);
            toneButtons.add(tone);
            final Button self = tone;
            tone.setOnClickListener(v -> {
                toneModifier = modifier;
                for (Button b : toneButtons) b.setAlpha(b == self ? 1f : 0.5f);
            });
        }
        defaultTone.setOnClickListener(v -> {
            toneModifier = "";
            for (Button b : toneButtons) b.setAlpha(b == defaultTone ? 1f : 0.5f);
        });
        for (Button b : toneButtons) toneRow.addView(b);

        // Recents section (persisted MRU, sanitized on read).
        List<String> recents = loadRecents(context);
        LinearLayout recentsBlock = new LinearLayout(context);
        recentsBlock.setOrientation(LinearLayout.VERTICAL);
        if (!recents.isEmpty()) {
            recentsBlock.addView(sectionHeader(context, "Recents"));
            GridLayout recentsGrid = new GridLayout(context);
            recentsGrid.setColumnCount(COLUMNS);
            for (String ch : recents) {
                recentsGrid.addView(emojiCell(context, cellPx, ch, "Recent emoji " + ch));
            }
            recentsBlock.addView(recentsGrid);
        }
        sections.addView(recentsBlock);

        // Category sections + jump tabs (fast navigation without a new dep).
        final List<View> anchors = new ArrayList<>();
        for (Category cat : cats) {
            TextView header = sectionHeader(context, cat.label);
            sections.addView(header);
            anchors.add(header);
            GridLayout grid = new GridLayout(context);
            grid.setColumnCount(COLUMNS);
            for (Entry item : cat.items) {
                grid.addView(emojiCell(context, cellPx, item.ch, item.name));
            }
            sections.addView(grid);
        }
        for (int i = 0; i < cats.size(); i++) {
            final int index = i;
            Button tab = new Button(context, null, android.R.attr.borderlessButtonStyle);
            tab.setText(cats.get(i).label);
            tab.setTextSize(12);
            tab.setMinHeight(dp(48));
            tab.setMinWidth(dp(48));
            tab.setContentDescription("Go to " + cats.get(i).label);
            tab.setOnClickListener(v -> mainScroll.post(() -> {
                View anchor = anchors.get(index);
                mainScroll.smoothScrollTo(0, Math.max(0, anchor.getTop() - dp(4)));
            }));
            tabRow.addView(tab);
        }

        // Keyword search: sections hide, capped result grid shows.
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                String q = s == null ? "" : s.toString().trim();
                boolean searching = !q.isEmpty();
                mainScroll.setVisibility(searching ? View.GONE : View.VISIBLE);
                tabScroll.setVisibility(searching ? View.GONE : View.VISIBLE);
                resultsScroll.setVisibility(searching ? View.VISIBLE : View.GONE);
                if (!searching) return;
                results.removeAllViews();
                for (Entry item : search(cats, q)) {
                    results.addView(emojiCell(context, cellPx, item.ch, item.name));
                }
                if (results.getChildCount() == 0) {
                    TextView empty = new TextView(context);
                    empty.setText("No emoji match that search.");
                    empty.setPadding(dp(16), dp(16), dp(16), dp(16));
                    results.addView(empty);
                }
            }
        });

        return root;
    }

    private Button toneButton(Context context, String text, String description) {
        Button button = new Button(context, null, android.R.attr.borderlessButtonStyle);
        button.setText(text);
        button.setTextSize(14);
        button.setMinHeight(dp(48));
        button.setMinWidth(dp(48));
        button.setContentDescription(description);
        return button;
    }

    private TextView sectionHeader(Context context, String label) {
        TextView header = new TextView(context);
        header.setText(label);
        header.setTextSize(12);
        header.setAllCaps(true);
        header.setPadding(dp(4), dp(12), dp(4), dp(4));
        header.setContentDescription(label + " emoji");
        return header;
    }

    private Button emojiCell(Context context, int cellPx, String emoji, String name) {
        Button cell = new Button(context, null, android.R.attr.borderlessButtonStyle);
        cell.setText(emoji);
        cell.setTextSize(24);
        cell.setMinimumWidth(cellPx);
        cell.setMinimumHeight(cellPx);
        cell.setMinHeight(dp(48));
        GridLayout.LayoutParams params = new GridLayout.LayoutParams();
        params.width = cellPx;
        params.height = cellPx;
        cell.setLayoutParams(params);
        cell.setContentDescription("Insert " + name);
        cell.setOnClickListener(v -> {
            if (!isAdded()) return;
            String clean = EmojiPickerPolicy.sanitizePickedEmoji(
                EmojiPickerPolicy.applyTone(emoji, toneModifier));
            if (clean == null) return;
            picked = true;
            recordRecent(requireContext(), clean);
            if (onPick != null) onPick.accept(clean);
            dismissAllowingStateLoss();
        });
        return cell;
    }

    static List<String> loadRecents(Context context) {
        List<String> out = new ArrayList<>();
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = prefs.getString(KEY_RECENTS, "");
            if (raw == null || raw.isEmpty()) return out;
            for (String part : raw.split(RECENT_SEP, -1)) {
                String clean = EmojiPickerPolicy.sanitizePickedEmoji(part);
                if (clean != null && !out.contains(clean) && out.size() < RECENTS_MAX) {
                    out.add(clean);
                }
            }
        } catch (RuntimeException ignored) {
            // Corrupt prefs must never break the picker.
        }
        return out;
    }

    static void recordRecent(Context context, String emoji) {
        try {
            List<String> next = new ArrayList<>();
            next.add(emoji);
            for (String existing : loadRecents(context)) {
                if (!existing.equals(emoji) && next.size() < RECENTS_MAX) next.add(existing);
            }
            StringBuilder joined = new StringBuilder();
            for (int i = 0; i < next.size(); i++) {
                if (i > 0) joined.append(RECENT_SEP);
                joined.append(next.get(i));
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_RECENTS, joined.toString()).apply();
        } catch (RuntimeException ignored) {
            // Best-effort: recents never block picking.
        }
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

    @Override
    public void onDismiss(android.content.DialogInterface dialog) {
        super.onDismiss(dialog);
        // Back-gesture/system dismissals that bypass onCancel still resolve.
        if (!picked && onCancel != null) onCancel.run();
    }
}
