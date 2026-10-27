package com.findback.app;

import com.findback.app.LocationServicesPlugin;
import com.findback.app.map.FindbackMapPlugin;
import com.findback.app.GoogleAuthPlugin;
import com.findback.app.FindbackNotificationsPlugin;
import com.findback.app.shortlink.ShortLinkResolverPlugin;
import com.findback.app.download.ModelDownloadPlugin;
import com.findback.app.needle.FindbackNeedle;
import com.findback.app.vlm.FindBackDiagPlugin;
import com.findback.app.vlm.EmbeddingPlugin;
import com.findback.app.OpenRouterKeyPlugin;
import com.getcapacitor.BridgeActivity;
import com.findback.app.media.FindbackMediaPlugin;
import com.findback.app.messaging.FindbackMessagingSqlitePlugin;
import com.findback.app.push.ChatPushState;
import android.content.Intent;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Capture before BridgeActivity forwards launch data to plugins. Cold
        // taps stay in private storage until the JS session actually rehydrates.
        captureChatIntent(getIntent());
        registerPlugin(ShortLinkResolverPlugin.class);
        registerPlugin(FindBackDiagPlugin.class);
        registerPlugin(ModelDownloadPlugin.class);
        registerPlugin(FindbackNeedle.class);
        registerPlugin(OpenRouterKeyPlugin.class);
        registerPlugin(EmbeddingPlugin.class);
        registerPlugin(LocationServicesPlugin.class);
        registerPlugin(FindbackMapPlugin.class);
        registerPlugin(GoogleAuthPlugin.class);
        registerPlugin(FindbackNotificationsPlugin.class);
        registerPlugin(FindbackMediaPlugin.class);
        registerPlugin(FindbackMessagingSqlitePlugin.class);
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null && savedInstanceState.getBundle("findbackMediaRequest") != null) {
            mediaPlugin().restoreMediaRequestState(savedInstanceState.getBundle("findbackMediaRequest"));
        }
    }
    @Override public void onNewIntent(Intent intent) {
        boolean chat = ChatPushState.ACTION_TAP.equals(intent.getAction());
        boolean captured = captureChatIntent(intent);
        Intent safe = chat ? new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN) : intent;
        setIntent(safe);
        super.onNewIntent(safe);
        if (captured && getBridge() != null && getBridge().getPlugin("FindbackNotifications") != null) {
            ((FindbackNotificationsPlugin) getBridge().getPlugin("FindbackNotifications").getInstance()).chatTapAvailable();
        }
    }
    private boolean captureChatIntent(Intent intent) {
        if (intent == null || !ChatPushState.ACTION_TAP.equals(intent.getAction())) return false;
        boolean captured = false;
        try { captured = ChatPushState.capture(this, intent); } catch (Exception ignored) { /* fail closed */ }
        // Never allow even a forged chat Intent to enter the public-link or
        // Capacitor push-action paths. Only our private pending record is used.
        setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
        return captured;
    }
    @Override public void onSaveInstanceState(android.os.Bundle outState) {
        android.os.Bundle media = mediaPlugin().saveMediaRequestState();
        if (media != null) outState.putBundle("findbackMediaRequest", media);
        super.onSaveInstanceState(outState);
    }
    private FindbackMediaPlugin mediaPlugin() {
        return (FindbackMediaPlugin) getBridge().getPlugin("FindbackMedia").getInstance();
    }
}
