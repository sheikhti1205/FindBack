package com.findback.app;

import com.findback.app.LocationServicesPlugin;
import com.findback.app.FindbackNotificationsPlugin;
import com.findback.app.shortlink.ShortLinkResolverPlugin;
import com.findback.app.download.ModelDownloadPlugin;
import com.findback.app.needle.FindbackNeedle;
import com.findback.app.vlm.FindBackDiagPlugin;
import com.findback.app.vlm.SmolVlmPlugin;
import com.findback.app.vlm.EmbeddingPlugin;
import com.findback.app.OpenRouterKeyPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ShortLinkResolverPlugin.class);
        registerPlugin(FindBackDiagPlugin.class);
        registerPlugin(ModelDownloadPlugin.class);
        registerPlugin(FindbackNeedle.class);
        registerPlugin(SmolVlmPlugin.class);
        registerPlugin(OpenRouterKeyPlugin.class);
        registerPlugin(EmbeddingPlugin.class);
        registerPlugin(LocationServicesPlugin.class);
        registerPlugin(FindbackNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
