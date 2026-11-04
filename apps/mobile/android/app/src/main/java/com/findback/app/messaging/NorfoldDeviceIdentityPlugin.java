package com.findback.app.messaging;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** App-private persistent AndroidKeyStore signer. No export/rotation/network
 * methods; no raw exception logging. Hardware level is not assumed. */
@CapacitorPlugin(name = "NorfoldDeviceIdentity")
public final class NorfoldDeviceIdentityPlugin extends Plugin {
    private static final Object KEY_ELECTION = new Object();
    private final Map<String, Identity> handles = new ConcurrentHashMap<>();
    private final ExecutorService lane = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;
    private static final class Identity {
        final String backend, account, device;
        final KeyStore.PrivateKeyEntry keys;
        volatile boolean closed;
        Identity(String b, String a, String d, KeyStore.PrivateKeyEntry k) { backend = b; account = a; device = d; keys = k; }
    }
    private interface Work { JSObject run() throws Exception; }
    private void run(PluginCall call, Work work) {
        if (destroyed) { call.reject("Device signing is unavailable"); return; }
        try { lane.execute(() -> {
            try {
                if (destroyed) throw new IllegalStateException();
                JSObject result = work.run();
                if (destroyed) throw new IllegalStateException(); call.resolve(result);
            } catch (Exception ignored) { call.reject("Device signing is unavailable"); }
        }); } catch (Exception ignored) { call.reject("Device signing is unavailable"); }
    }
    @PluginMethod public void open(PluginCall call) {
        String backend = call.getString("backendUrl"), account = call.getString("accountId"), device = call.getString("deviceId");
        run(call, () -> {
            DeviceProofPolicy.scope(backend, account, device);
            // Reuse the canonical installation; never mint an alias on signing failure.
            if (!device.equals(getContext().getSharedPreferences(FindbackMessagingSqlitePlugin.PREFERENCES, Context.MODE_PRIVATE)
                .getString(FindbackMessagingSqlitePlugin.INSTALLATION_KEY, null))) throw new IllegalArgumentException();
            String alias = "norfold-device-v1-" + DeviceSignatureCodec.hex(MessageDigest.getInstance("SHA-256")
                .digest((backend + "\n" + account + "\n" + device).getBytes(StandardCharsets.UTF_8)));
            KeyStore.PrivateKeyEntry keys;
            synchronized (KEY_ELECTION) {
                KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
                if (!store.containsAlias(alias)) {
                    KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
                    generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build());
                    generator.generateKeyPair();
                }
                keys = (KeyStore.PrivateKeyEntry) store.getEntry(alias, null);
            }
            if (keys == null || keys.getPrivateKey().getEncoded() != null || !(keys.getCertificate().getPublicKey() instanceof ECPublicKey)) throw new IllegalStateException();
            byte[] publicKey = DeviceSignatureCodec.publicPoint((ECPublicKey) keys.getCertificate().getPublicKey());
            byte[] nonce = new byte[32]; new SecureRandom().nextBytes(nonce);
            Signature probe = Signature.getInstance("SHA256withECDSA"); probe.initSign(keys.getPrivateKey()); probe.update(nonce); byte[] signed = probe.sign();
            probe.initVerify(keys.getCertificate().getPublicKey()); probe.update(nonce); if (!probe.verify(signed)) throw new IllegalStateException();
            String handle = Base64.encodeToString(nonce, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
            Identity identity = new Identity(backend, account, device, keys);
            handles.put(handle, identity);
            if (destroyed) { identity.closed = true; handles.remove(handle); throw new IllegalStateException(); }
            JSObject out = new JSObject(); out.put("handle", handle); out.put("publicKey", DeviceSignatureCodec.hex(publicKey)); return out;
        });
    }
    @PluginMethod public void sign(PluginCall call) {
        String handle = call.getString("handle"), payload = call.getString("payload");
        run(call, () -> {
            Identity identity = handle == null ? null : handles.get(handle);
            if (identity == null || identity.closed || payload == null || !payload.matches("[0-9a-f]{2,2048}") || payload.length() % 2 != 0) throw new IllegalArgumentException();
            byte[] bytes = new byte[payload.length() / 2];
            for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(payload.substring(i * 2, i * 2 + 2), 16);
            String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
            JSONArray array = new JSONArray(text); List<Object> wire = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) wire.add(array.get(i));
            DeviceProofPolicy.validate(identity.backend, identity.account, identity.device, wire, System.currentTimeMillis());
            if (identity.closed) throw new IllegalStateException();
            Signature signer = Signature.getInstance("SHA256withECDSA"); signer.initSign(identity.keys.getPrivateKey()); signer.update(bytes);
            byte[] signed = DeviceSignatureCodec.derToRaw(signer.sign());
            DeviceProofPolicy.validate(identity.backend, identity.account, identity.device, wire, System.currentTimeMillis());
            if (identity.closed) throw new IllegalStateException();
            JSObject out = new JSObject(); out.put("signature", DeviceSignatureCodec.hex(signed)); return out;
        });
    }
    @PluginMethod public void close(PluginCall call) {
        String handle = call.getString("handle"); Identity identity = handle == null ? null : handles.remove(handle);
        if (identity != null) identity.closed = true; call.resolve();
    }
    @Override protected void handleOnDestroy() {
        destroyed = true; for (Identity identity : handles.values()) identity.closed = true; handles.clear(); lane.shutdown();
    }
}
