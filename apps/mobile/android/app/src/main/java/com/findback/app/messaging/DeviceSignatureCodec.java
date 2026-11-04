package com.findback.app.messaging;

import java.math.BigInteger;
import java.security.interfaces.ECPublicKey;
import java.util.Arrays;

/** P-256 SEC1 point and strict DER -> IEEE-P1363 conversion. Android JCA emits
 * DER; WebCrypto/our one canonical verifier expects the two 32-byte scalars. */
public final class DeviceSignatureCodec {
    private static final BigInteger ORDER = new BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);
    private DeviceSignatureCodec() {}
    public static byte[] publicPoint(ECPublicKey key) {
        if (key.getParams().getCurve().getField().getFieldSize() != 256 || !ORDER.equals(key.getParams().getOrder())) throw new IllegalArgumentException();
        byte[] raw = new byte[65]; raw[0] = 4;
        coordinate(key.getW().getAffineX(), raw, 1); coordinate(key.getW().getAffineY(), raw, 33); return raw;
    }
    private static void coordinate(BigInteger value, byte[] out, int offset) {
        byte[] raw = value.toByteArray();
        int first = raw.length == 33 && raw[0] == 0 ? 1 : 0;
        if (value.signum() < 0 || raw.length - first > 32) throw new IllegalArgumentException();
        System.arraycopy(raw, first, out, offset + 32 - (raw.length - first), raw.length - first);
    }
    public static byte[] derToRaw(byte[] der) {
        if (der == null || der.length < 8 || der.length > 72 || der[0] != 0x30 || (der[1] & 255) != der.length - 2) throw new IllegalArgumentException();
        byte[] raw = new byte[64]; int cursor = scalar(der, 2, raw, 0);
        if (scalar(der, cursor, raw, 32) != der.length) throw new IllegalArgumentException(); return raw;
    }
    private static int scalar(byte[] der, int start, byte[] out, int offset) {
        if (start + 2 >= der.length || der[start] != 2) throw new IllegalArgumentException();
        int length = der[start + 1] & 255, first = start + 2, end = first + length;
        if (length < 1 || length > 33 || end > der.length || der[first] < 0) throw new IllegalArgumentException();
        if (length > 1 && der[first] == 0) {
            if (der[first + 1] >= 0) throw new IllegalArgumentException(); first++;
        }
        if (end - first > 32) throw new IllegalArgumentException();
        BigInteger value = new BigInteger(1, Arrays.copyOfRange(der, first, end));
        if (value.signum() == 0 || value.compareTo(ORDER) >= 0) throw new IllegalArgumentException();
        System.arraycopy(der, first, out, offset + 32 - (end - first), end - first); return end;
    }
    public static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) { out.append(Character.forDigit((value >>> 4) & 15, 16)); out.append(Character.forDigit(value & 15, 16)); }
        return out.toString();
    }
}
