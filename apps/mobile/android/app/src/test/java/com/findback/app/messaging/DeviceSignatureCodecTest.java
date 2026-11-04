package com.findback.app.messaging;

import org.junit.Test;
import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class DeviceSignatureCodecTest {
    @Test public void realP256SignaturePreservesItsTwoUnsignedScalars() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair keys = generator.generateKeyPair();
        byte[] publicKey = DeviceSignatureCodec.publicPoint((ECPublicKey) keys.getPublic());
        assertEquals(65, publicKey.length); assertEquals(4, publicKey[0]);
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(keys.getPrivate()); signer.update(new byte[] {1, 2, 3});
        byte[] der = signer.sign(), raw = DeviceSignatureCodec.derToRaw(der);
        assertEquals(64, raw.length);
        byte[] r = new BigInteger(1, Arrays.copyOfRange(raw, 0, 32)).toByteArray();
        byte[] s = new BigInteger(1, Arrays.copyOfRange(raw, 32, 64)).toByteArray();
        byte[] rebuilt = new byte[6 + r.length + s.length];
        rebuilt[0] = 0x30; rebuilt[1] = (byte) (rebuilt.length - 2); rebuilt[2] = 2; rebuilt[3] = (byte) r.length;
        System.arraycopy(r, 0, rebuilt, 4, r.length);
        rebuilt[4 + r.length] = 2; rebuilt[5 + r.length] = (byte) s.length;
        System.arraycopy(s, 0, rebuilt, 6 + r.length, s.length);
        assertArrayEquals(der, rebuilt);
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(keys.getPublic()); verifier.update(new byte[] {1, 2, 3}); assertTrue(verifier.verify(rebuilt));
    }
    @Test public void rejectsWrongCurve() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC"); generator.initialize(new ECGenParameterSpec("secp384r1"));
        assertThrows(IllegalArgumentException.class, () -> DeviceSignatureCodec.publicPoint((ECPublicKey) generator.generateKeyPair().getPublic()));
    }
    @Test public void rejectsMalformedDerAndInvalidScalars() {
        for (byte[] der : new byte[][] {
            {}, {0x30, 6, 2, 1, 1, 2, 1, 0}, {0x30, 6, 2, 1, (byte) 0x80, 2, 1, 1},
            {0x30, 7, 2, 2, 0, 1, 2, 1, 1}, {0x30, 6, 2, 1, 1, 2, 1, 1, 0},
            {0x30, 5, 2, 1, 1, 2, 1, 1}, {0x30, (byte) 0x81, 6, 2, 1, 1, 2, 1, 1}
        }) assertThrows(IllegalArgumentException.class, () -> DeviceSignatureCodec.derToRaw(der));
    }
    private static final String BACKEND = "https://native.example.test", ACCOUNT = "00000000-0000-4000-8000-000000000001", DEVICE = "00000000-0000-4000-8000-000000000002";
    private List<Object> proof() {
        return new ArrayList<>(Arrays.asList("norfold-device-proof", 1, BACKEND, "REGISTER", ACCOUNT, DEVICE, DEVICE,
            "00000000-0000-4000-8000-000000000003", "a".repeat(64), "0".repeat(64), 1_000L, 61_000L));
    }
    @Test public void nativeProofBoundaryRejectsScopeTypePurposeAndExpirySubstitution() throws Exception {
        DeviceProofPolicy.scope(BACKEND, ACCOUNT, DEVICE);
        DeviceProofPolicy.validate(BACKEND, ACCOUNT, DEVICE, proof(), 2_000);
        for (int field : new int[] {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}) {
            List<Object> wire = proof(); wire.set(field, "invalid");
            assertThrows(IllegalArgumentException.class, () -> DeviceProofPolicy.validate(BACKEND, ACCOUNT, DEVICE, wire, 2_000));
        }
        assertThrows(IllegalArgumentException.class, () -> DeviceProofPolicy.validate(BACKEND, ACCOUNT, DEVICE, proof(), 61_000));
        List<Object> numericString = proof(); numericString.set(10, "1000");
        assertThrows(IllegalArgumentException.class, () -> DeviceProofPolicy.validate(BACKEND, ACCOUNT, DEVICE, numericString, 2_000));
        List<Object> peer = proof(); peer.set(3, "PEER"); peer.set(6, "00000000-0000-4000-8000-000000000004"); peer.set(9, "b".repeat(64));
        DeviceProofPolicy.validate(BACKEND, ACCOUNT, DEVICE, peer, 2_000);
        peer.set(9, "0".repeat(64));
        assertThrows(IllegalArgumentException.class, () -> DeviceProofPolicy.validate(BACKEND, ACCOUNT, DEVICE, peer, 2_000));
        for (String backend : new String[] {"http://remote.example.test", "https://u:p@native.example.test", BACKEND + "/wrong", BACKEND + "?x=1", BACKEND + "#x"})
            assertThrows(Exception.class, () -> DeviceProofPolicy.scope(backend, ACCOUNT, DEVICE));
    }
}
