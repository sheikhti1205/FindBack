package com.findback.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Per-account, per-provider AI credential ciphertext; master key never leaves
 * Android Keystore. The plugin name stays {@code OpenRouterKey} so existing
 * installs and the registered bridge keep working; the {@code provider}
 * option (default {@code openrouter}) selects one of the five isolated
 * vault slots defined by {@link AiCredentialSlots}.
 */
@CapacitorPlugin(name = "OpenRouterKey")
public final class OpenRouterKeyPlugin extends Plugin {
    private static final String STORE = "findback.openrouter.credentials";
    private static final String ALIAS = "findback.openrouter.key.v1";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(STORE, Context.MODE_PRIVATE);
    }

    private static String userId(PluginCall call) {
        String value = call.getString("userId");
        return AiCredentialSlots.isValidUserId(value) ? value : null;
    }

    private static String provider(PluginCall call) {
        return AiCredentialSlots.normalizeProvider(call.getString("provider"));
    }

    private static String slot(String userId, String provider) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
            .digest(AiCredentialSlots.slotInput(userId, provider).getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(digest, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
    }

    private static byte[] aad(String userId, String provider) {
        return AiCredentialSlots.slotInput(userId, provider).getBytes(StandardCharsets.UTF_8);
    }

    private static SecretKey masterKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build());
        return generator.generateKey();
    }

    @PluginMethod
    public void set(PluginCall call) {
        String owner = userId(call);
        String provider = provider(call);
        String value = call.getString("key");
        if (owner == null || provider == null || value == null || value.isEmpty()) {
            call.reject("Invalid credential request");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, masterKey());
            cipher.updateAAD(aad(owner, provider));
            byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
            byte[] encrypted = cipher.doFinal(plaintext);
            Arrays.fill(plaintext, (byte) 0);
            String record = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
                Base64.encodeToString(encrypted, Base64.NO_WRAP);
            if (!prefs().edit().putString(slot(owner, provider), record).commit()) throw new IllegalStateException();
            call.resolve();
        } catch (Exception ignored) {
            call.reject("Could not save the key securely");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String owner = userId(call);
        String provider = provider(call);
        if (owner == null || provider == null) {
            call.reject("Invalid credential request");
            return;
        }
        try {
            String record = prefs().getString(slot(owner, provider), null);
            JSObject out = new JSObject();
            if (record == null) {
                out.put("key", JSObject.NULL);
            } else {
                String[] parts = record.split(":", 2);
                if (parts.length != 2) throw new IllegalStateException();
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, masterKey(),
                    new GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT)));
                cipher.updateAAD(aad(owner, provider));
                byte[] plaintext = cipher.doFinal(Base64.decode(parts[1], Base64.DEFAULT));
                out.put("key", new String(plaintext, StandardCharsets.UTF_8));
                Arrays.fill(plaintext, (byte) 0);
            }
            call.resolve(out);
        } catch (Exception ignored) {
            call.reject("Could not unlock the saved key");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String owner = userId(call);
        String provider = provider(call);
        if (owner == null || provider == null) {
            call.reject("Invalid credential request");
            return;
        }
        try {
            if (!prefs().edit().remove(slot(owner, provider)).commit()) throw new IllegalStateException();
            call.resolve();
        } catch (Exception ignored) {
            call.reject("Could not remove the saved key");
        }
    }
}
