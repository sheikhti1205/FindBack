package com.findback.app.messaging;

import java.net.URI;
import java.util.List;

/** Defensive native-boundary validation of the canonical shared JS proof wire.
 * Never signs arbitrary bytes, another backend/account/install or expired proof. */
public final class DeviceProofPolicy {
    private DeviceProofPolicy() {}
    public static boolean uuid(Object value) { return value instanceof String && ((String) value).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"); }
    public static void scope(String backend, String account, String device) throws Exception {
        URI uri = new URI(backend);
        String host = uri.getHost();
        boolean loopback = "localhost".equals(host) || "127.0.0.1".equals(host) || "[::1]".equals(host);
        if (host == null || !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && loopback))
            || uri.getRawUserInfo() != null || !uri.getRawPath().isEmpty() || uri.getRawQuery() != null || uri.getRawFragment() != null
            || !uuid(account) || !uuid(device)) throw new IllegalArgumentException();
    }
    private static long integer(Object value) {
        if (!(value instanceof Integer || value instanceof Long)) throw new IllegalArgumentException();
        long n = ((Number) value).longValue();
        if (n < 0 || n > 9_007_199_254_740_991L) throw new IllegalArgumentException(); return n;
    }
    public static void validate(String backend, String account, String device, List<Object> wire, long now) {
        if (wire.size() != 12 || !"norfold-device-proof".equals(wire.get(0)) || integer(wire.get(1)) != 1
            || !backend.equals(wire.get(2)) || !account.equals(wire.get(4)) || !device.equals(wire.get(5))
            || !uuid(wire.get(6)) || !uuid(wire.get(7)) || !(wire.get(8) instanceof String) || !((String) wire.get(8)).matches("[0-9a-f]{64}")
            || !(wire.get(9) instanceof String) || !((String) wire.get(9)).matches("[0-9a-f]{64}")) throw new IllegalArgumentException();
        boolean registration = "REGISTER".equals(wire.get(3)), peer = "PEER".equals(wire.get(3));
        if ((!registration && !peer) || registration != device.equals(wire.get(6))
            || registration != ((String) wire.get(9)).matches("0{64}")) throw new IllegalArgumentException();
        long issued = integer(wire.get(10)), expires = integer(wire.get(11));
        if (expires <= issued || expires - issued > 120_000 || issued > now + 5_000 || expires <= now) throw new IllegalArgumentException();
    }
}
