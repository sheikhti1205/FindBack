package com.findback.app;

import com.findback.app.LocationServicesPlugin;
import com.findback.app.map.FindbackMapPlugin;
import com.findback.app.GoogleAuthPlugin;
import com.findback.app.FindbackNotificationsPlugin;
import com.findback.app.shortlink.ShortLinkResolverPlugin;
import com.findback.app.download.ModelDownloadPlugin;
import com.findback.app.ai.QwenTextPlugin;
import com.findback.app.llama.FindbackLlama;
import com.findback.app.needle.FindbackNeedle;
import com.findback.app.vlm.FindBackDiagPlugin;
import com.findback.app.vlm.SmolVlmPlugin;
import com.findback.app.vlm.EmbeddingPlugin;
import com.findback.app.OpenRouterKeyPlugin;
import com.getcapacitor.BridgeActivity;
import com.findback.app.media.FindbackMediaPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ShortLinkResolverPlugin.class);
        registerPlugin(FindBackDiagPlugin.class);
        registerPlugin(ModelDownloadPlugin.class);
        registerPlugin(FindbackNeedle.class);
        registerPlugin(FindbackLlama.class);
        registerPlugin(SmolVlmPlugin.class);
        registerPlugin(QwenTextPlugin.class);
        registerPlugin(OpenRouterKeyPlugin.class);
        registerPlugin(EmbeddingPlugin.class);
        registerPlugin(LocationServicesPlugin.class);
        registerPlugin(FindbackMapPlugin.class);
        registerPlugin(GoogleAuthPlugin.class);
        registerPlugin(FindbackNotificationsPlugin.class);
        registerPlugin(FindbackMediaPlugin.class);
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null && savedInstanceState.getBundle("findbackMediaRequest") != null) {
            mediaPlugin().restoreMediaRequestState(savedInstanceState.getBundle("findbackMediaRequest"));
        }
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
