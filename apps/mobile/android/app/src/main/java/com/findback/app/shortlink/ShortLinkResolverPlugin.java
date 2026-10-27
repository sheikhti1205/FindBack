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
import java.net.URI;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.Bridge;

@CapacitorPlugin(name = "ShortLinkResolver")
public class ShortLinkResolverPlugin extends Plugin {

    private static final String TAG = "ShortLinkResolver";
    private static final int MAX_REDIRECTS = 5;
    private static final int TIMEOUT_MS = 8000;

    // Hosts that only ever redirect to a Maps destination. A full
    // www.google.com/maps/... URL is already the destination, and resolving it
    // would fetch a page the caller already has.
    private static final Set<String> SHORT_LINK_HOSTS = new HashSet<>(Arrays.asList(
        "maps.app.goo.gl",
        "goo.gl"
    ));

    // Allowlisted hosts for Google Maps links (initial URL and every hop)
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

        // Validate initial URL is on the allowlist
        if (!isAllowedHost(inputUrl)) {
            call.reject("Only Google Maps links can be resolved.");
            return;
        }

        // Nothing to follow: hand the destination straight back, but only when
        // it is the Maps product. A bare www.google.com page is allowlisted and
        // is not a location.
        if (!isShortLink(inputUrl)) {
            if (!isMapsDestination(inputUrl)) {
                call.reject("Only Google Maps links can be resolved.");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("url", inputUrl.trim());
            call.resolve(ret);
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

                    URL next = new URL(new URL(currentUrl), location);
                    String nextHost = hostOf(next);

                    // https on the default port only: the resolved location is
                    // user data, an http hop lets the network rewrite it in
                    // transit, and a non-default port is an escape hatch around
                    // the host rules.
                    if (!isHttpsDefaultPort(next) || !ALLOWED_HOSTS.contains(nextHost)) {
                        throw new IOException("Map link redirected to an untrusted host: " + nextHost);
                    }

                    currentUrl = next.toString();
                    continue;
                }

                // A resolution has to land on a Maps destination. Returning the
                // short link itself, another shortener reached by a redirect, or
                // an allowlisted Google page that is not Maps would report an
                // unresolved link as resolved.
                if (!isMapsDestination(currentUrl)) {
                    throw new IOException("Map link did not redirect to a location.");
                }
                return currentUrl;

            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }

        throw new IOException("Map link redirected too many times.");
    }

    /** Lowercased host: URL.getHost() keeps the case the caller typed, and DNS does not. */
    private static String hostOf(URL url) {
        String host = url.getHost();
        return host == null ? "" : host.toLowerCase(Locale.ROOT);
    }

    /** https on the default port — a share link never needs anything else. */
    private static boolean isHttpsDefaultPort(URL url) {
        return "https".equals(url.getProtocol()) && (url.getPort() == -1 || url.getPort() == 443);
    }

    /**
     * The path with dot segments resolved, or null when it cannot be resolved
     * safely. URL.getPath() keeps "/maps/../search" exactly as written, so a
     * prefix test on the raw path accepts a URL that resolves outside /maps.
     * Percent-encoded dots are rejected outright: a browser decodes them before
     * normalising, and no Maps route needs them.
     */
    private static String normalizedPath(URL url) {
        String raw = url.getPath();
        if (raw == null) return null;
        if (raw.toLowerCase(Locale.ROOT).contains("%2e")) return null;
        try {
            return new URI(url.toString()).normalize().getPath();
        } catch (Exception e) {
            return null;
        }
    }

    private boolean isAllowedHost(String urlString) {
        try {
            URL url = new URL(urlString.trim());
            return isHttpsDefaultPort(url) && ALLOWED_HOSTS.contains(hostOf(url));
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isShortLink(String urlString) {
        try {
            URL url = new URL(urlString.trim());
            return isHttpsDefaultPort(url) && SHORT_LINK_HOSTS.contains(hostOf(url));
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * A Maps destination: a place a reader can be sent to. Not the same as "on
     * an allowlisted host" — goo.gl shortens more than maps links, so a short
     * link can land on https://www.google.com/, which is allowlisted and is not
     * a location. Only a maps.* host, or the /maps path on a bare Google host,
     * counts.
     */
    private boolean isMapsDestination(String urlString) {
        try {
            URL url = new URL(urlString.trim());
            if (!isHttpsDefaultPort(url)) return false;
            String host = hostOf(url);
            if (!ALLOWED_HOSTS.contains(host)) return false;
            if (SHORT_LINK_HOSTS.contains(host)) return false;
            String path = normalizedPath(url);
            if (path == null) return false;
            if (host.startsWith("maps.")) return true;
            return "/maps".equals(path) || path.startsWith("/maps/");
        } catch (Exception e) {
            return false;
        }
    }
}