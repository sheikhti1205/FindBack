package com.findback.app;

import com.findback.app.shortlink.ShortLinkResolverPlugin;
import com.findback.app.vlm.LocalVlmPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(LocalVlmPlugin.class);
        registerPlugin(ShortLinkResolverPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
