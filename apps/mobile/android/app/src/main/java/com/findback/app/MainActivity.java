package com.findback.app;

import com.findback.app.shortlink.ShortLinkResolverPlugin;
import com.findback.app.vlm.FindBackDiagPlugin;
import com.findback.app.vlm.EmbeddingPlugin;
import com.findback.app.OpenRouterKeyPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ShortLinkResolverPlugin.class);
        registerPlugin(FindBackDiagPlugin.class);
        registerPlugin(OpenRouterKeyPlugin.class);
        registerPlugin(EmbeddingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
