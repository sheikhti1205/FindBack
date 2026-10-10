package com.findback.app;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.maps.model.LatLng;
import com.google.android.libraries.places.api.Places;
import com.google.android.libraries.places.api.model.AutocompletePrediction;
import com.google.android.libraries.places.api.model.AutocompleteSessionToken;
import com.google.android.libraries.places.api.model.Place;
import com.google.android.libraries.places.api.net.FetchPlaceRequest;
import com.google.android.libraries.places.api.net.FindAutocompletePredictionsRequest;
import com.google.android.libraries.places.api.net.FindAutocompletePredictionsResponse;
import com.google.android.libraries.places.api.net.PlacesClient;

import java.util.Arrays;
import java.util.List;

/**
 * Google Places autocomplete search bridge for the map picker (A3).
 *
 * <p>The web layer cannot call the Places HTTP API with our key: the key is
 * Android-app-restricted (Maps SDK for Android + Places SDK for Android), so
 * only native SDK calls succeed. This plugin runs autocomplete + fetchPlace
 * natively and returns displayName + coordinates in the shared
 * {@code PlaceResult} shape.
 *
 * <p>Key handling: the API key is read at runtime from the
 * {@code com.google.android.geo.API_KEY} manifest entry (injected by Gradle
 * from {@code GOOGLE_MAPS_API_KEY}). It is NEVER logged, NEVER echoed in
 * errors, and NEVER returned to JS. A missing key fails closed:
 * {@code isAvailable} reports {@code available:false} and {@code searchPlaces}
 * rejects with {@code MAPS_KEY_MISSING}; the web layer falls back to
 * Nominatim.
 *
 * <p>Privacy/consent model: search runs ONLY on explicit user submission
 * (one call per Search tap — no keystroke streaming). One
 * {@link AutocompleteSessionToken} per call scopes billing to the session.
 * No query, result, or coordinate is logged.
 */
@CapacitorPlugin(name = "FindbackPlaces")
public final class FindbackPlacesPlugin extends Plugin {

    private static final String META_API_KEY = "com.google.android.geo.API_KEY";
    private static final int MAX_RESULTS = 5;

    private String readManifestApiKey() {
        try {
            ApplicationInfo info = getContext().getPackageManager().getApplicationInfo(
                    getContext().getPackageName(), PackageManager.GET_META_DATA);
            if (info.metaData == null) return "";
            String key = info.metaData.getString(META_API_KEY);
            return key == null ? "" : key.trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    private PlacesClient clientOrNull() {
        String apiKey = readManifestApiKey();
        if (apiKey.isEmpty()) return null;
        try {
            if (!Places.isInitialized()) {
                Places.initialize(getContext().getApplicationContext(), apiKey);
            }
            return Places.createClient(getContext());
        } catch (Exception ignored) {
            return null;
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", clientOrNull() != null);
        call.resolve(result);
    }

    @PluginMethod
    public void searchPlaces(PluginCall call) {
        String query = call.getString("query", "");
        if (query == null || query.trim().isEmpty()) {
            call.reject("EMPTY_QUERY");
            return;
        }
        PlacesClient client = clientOrNull();
        if (client == null) {
            // Consumer-safe code only — never the key or platform detail.
            call.reject("MAPS_KEY_MISSING");
            return;
        }
        AutocompleteSessionToken token = AutocompleteSessionToken.newInstance();
        FindAutocompletePredictionsRequest predictionsRequest =
                FindAutocompletePredictionsRequest.builder()
                        .setSessionToken(token)
                        .setQuery(query.trim())
                        .build();
        client.findAutocompletePredictions(predictionsRequest)
                .addOnSuccessListener(predictions -> fetchTopPlaces(client, token, predictions, call))
                .addOnFailureListener(error -> call.reject("PLACES_SEARCH_FAILED"));
    }

    private void fetchTopPlaces(
            PlacesClient client,
            AutocompleteSessionToken token,
            FindAutocompletePredictionsResponse predictions,
            PluginCall call) {
        List<AutocompletePrediction> items = predictions.getAutocompletePredictions();
        if (items == null || items.isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("results", new JSArray());
            call.resolve(empty);
            return;
        }
        List<AutocompletePrediction> top =
                items.subList(0, Math.min(MAX_RESULTS, items.size()));
        // Verified against places:3.5.0 (javap on the resolved AAR): the
        // current model is ID/NAME/ADDRESS/LAT_LNG with getName()/getLatLng().
        // (The DISPLAY_NAME rename belongs to newer majors — unvetted here.)
        List<Place.Field> fields = Arrays.asList(
                Place.Field.ID, Place.Field.NAME, Place.Field.ADDRESS, Place.Field.LAT_LNG);
        JSArray results = new JSArray();
        fetchNext(client, token, top, 0, fields, results, call);
    }

    /** Sequential fetchPlace chain (bounded by MAX_RESULTS); one bad place never fails the batch. */
    private void fetchNext(
            PlacesClient client,
            AutocompleteSessionToken token,
            List<AutocompletePrediction> items,
            int index,
            List<Place.Field> fields,
            JSArray results,
            PluginCall call) {
        if (index >= items.size()) {
            JSObject done = new JSObject();
            done.put("results", results);
            call.resolve(done);
            return;
        }
        AutocompletePrediction prediction = items.get(index);
        if (prediction == null || prediction.getPlaceId() == null) {
            fetchNext(client, token, items, index + 1, fields, results, call);
            return;
        }
        FetchPlaceRequest request = FetchPlaceRequest.builder(prediction.getPlaceId(), fields)
                .setSessionToken(token)
                .build();
        client.fetchPlace(request)
                .addOnSuccessListener(response -> {
                    appendPlace(results, response.getPlace(), prediction);
                    fetchNext(client, token, items, index + 1, fields, results, call);
                })
                .addOnFailureListener(error -> {
                    // A single unresolvable prediction (e.g. removed place)
                    // skips; the rest still resolve.
                    fetchNext(client, token, items, index + 1, fields, results, call);
                });
    }

    private void appendPlace(JSArray results, Place place, AutocompletePrediction prediction) {
        if (place == null) return;
        LatLng location = place.getLatLng();
        if (location == null) return;
        String displayName = place.getName();
        if (displayName == null || displayName.trim().isEmpty()) {
            displayName = place.getAddress();
        }
        if (displayName == null || displayName.trim().isEmpty()) {
            CharSequence primary = prediction.getPrimaryText(null);
            CharSequence secondary = prediction.getSecondaryText(null);
            StringBuilder fallback = new StringBuilder();
            if (primary != null) fallback.append(primary);
            if (secondary != null && secondary.length() > 0) {
                if (fallback.length() > 0) fallback.append(", ");
                fallback.append(secondary);
            }
            displayName = fallback.toString().trim();
        }
        if (displayName == null || displayName.trim().isEmpty()) return;
        displayName = displayName.trim();
        // Keep the shared PlaceResult shape: displayName/latitude/longitude.
        JSObject item = new JSObject();
        item.put("displayName", displayName);
        item.put("latitude", location.latitude);
        item.put("longitude", location.longitude);
        results.put(item);
    }
}
