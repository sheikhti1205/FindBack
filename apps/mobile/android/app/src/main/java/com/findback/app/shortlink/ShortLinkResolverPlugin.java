package com.findback.app.shortlink;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.Bridge;

@CapacitorPlugin(name = "ShortLinkResolver")
public class ShortLinkResolverPlugin extends Plugin {

    private static final String TAG = "ShortLinkResolver";
    private static final int MAX_REDIRECTS = 5;
    private static final int TIMEOUT_MS = 8000;

    // Allowlisted hosts for Google Maps short links
    private static final Set<String> ALLOWED_HOSTS = new HashSet<>(Arrays.asList(
        "maps.app.goo.gl",
        "goo.gl",
        "maps.google.com",
        "www.google.com",
        "google.com",
        "maps.google.co.uk",
        "maps.google.co.jp",
        "maps.google.de",
        "maps.google.fr",
        "maps.google.it",
        "maps.google.es",
        "maps.google.ca",
        "maps.google.com.au",
        "maps.google.co.in"
    ));

    @PluginMethod
    public void resolve(PluginCall call) {
        String inputUrl = call.getString("url");
        if (inputUrl == null || inputUrl.isEmpty()) {
            call.reject("Must provide a URL to resolve");
            return;
        }

        // Validate initial URL is on allowlist
        if (!isAllowedHost(inputUrl)) {
            call.reject("Only Google Maps short links can be resolved.");
            return;
        }

        // Run resolution on background thread
        getBridge().execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String finalUrl = resolveShortLink(inputUrl);
                    JSObject ret = new JSObject();
                    ret.put("url", finalUrl);
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Failed to resolve short link", e);
                    call.reject(e.getMessage());
                }
            }
        });
    }

    private String resolveShortLink(String inputUrl) throws IOException {
        String currentUrl = inputUrl.trim();

        for (int hop = 0; hop < MAX_REDIRECTS; hop++) {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(currentUrl);
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false); // Manual redirect handling
                connection.setConnectTimeout(TIMEOUT_MS);
                connection.setReadTimeout(TIMEOUT_MS);
                connection.setRequestMethod("HEAD");
                connection.setRequestProperty("Accept", "text/html,application/xhtml+xml");
                connection.setUseCaches(false);
                // No cookies, no auth

                int responseCode = connection.getResponseCode();

                if (responseCode >= 300 && responseCode < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || location.isEmpty()) {
                        throw new IOException("Map link did not redirect.");
                    }

                    String nextUrl = new URL(new URL(currentUrl), location).toString();
                    String nextHost = new URL(nextUrl).getHost();

                    if (!ALLOWED_HOSTS.contains(nextHost)) {
                        throw new IOException("Map link redirected to an untrusted host: " + nextHost);
                    }

                    currentUrl = nextUrl;
                    continue;
                }

                // Not a redirect, return current URL
                return currentUrl;

            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }

        throw new IOException("Map link redirected too many times.");
    }

    private boolean isAllowedHost(String urlString) {
        try {
            URL url = new URL(urlString.trim());
            return ALLOWED_HOSTS.contains(url.getHost());
        } catch (Exception e) {
            return false;
        }
    }
}