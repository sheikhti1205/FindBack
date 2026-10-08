package com.findback.app.media;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class MotionPhotoMetadataTest {
    private static final String PRIMARY = "<Container:Item Item:Mime='image/jpeg' Item:Semantic='Primary' Item:Length='0' Item:Padding='8'/>";
    private static final String VIDEO = "<Container:Item Item:Mime='video/mp4' Item:Semantic='MotionPhoto' Item:Length='24'/>";
    private byte[] photo(String directory, int trailing) {
        String xml = "<rdf:Description xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#' xmlns:Camera='http://ns.google.com/photos/1.0/camera/' xmlns:GCamera='http://ns.google.com/photos/1.0/camera/' xmlns:Container='http://ns.google.com/photos/1.0/container/' xmlns:Item='http://ns.google.com/photos/1.0/container/item/' Camera:MotionPhoto='1' GCamera:MicroVideo='1' GCamera:MicroVideoOffset='24'>" + directory + "</rdf:Description>";
        byte[] header = xml.getBytes(StandardCharsets.ISO_8859_1);
        byte[] bytes = new byte[header.length + 4 + 8 + 24 + trailing];
        bytes[0] = (byte) 255; bytes[1] = (byte) 216;
        System.arraycopy(header, 0, bytes, 2, header.length);
        int end = header.length + 4;
        bytes[end - 2] = (byte) 255; bytes[end - 1] = (byte) 217;
        bytes[end + 8 + 3] = 24;
        System.arraycopy("ftyp".getBytes(StandardCharsets.US_ASCII), 0, bytes, end + 12, 4);
        return bytes;
    }
    private String directory(String items) { return "<Container:Directory><rdf:Seq>" + items.replaceAll("(<Container:Item[^>]*/>)", "<rdf:li>$1</rdf:li>") + "</rdf:Seq></Container:Directory>"; }
    private MotionPhotoMetadata.Layout detect(byte[] bytes) throws Exception {
        return MotionPhotoMetadata.detect(bytes, bytes.length, (start, length) -> java.util.Arrays.copyOfRange(bytes, (int) start, (int) start + length));
    }
    @Test public void modernLengthsAndPaddingAreAuthoritative() throws Exception {
        byte[] bytes = photo(directory(PRIMARY + VIDEO), 0);
        assertEquals(bytes.length - 32, detect(bytes).stillEnd);
    }
    @Test public void rejectsNoncompliantItemsAfterVideo() throws Exception {
        String other = "<Container:Item Item:Semantic='Other' Item:Length='12' Item:Padding='4'/>";
        byte[] bytes = photo(directory(PRIMARY + VIDEO + other), 16);
        assertThrows(IllegalArgumentException.class, () -> detect(bytes));
    }
    @Test public void malformedModernNeverFallsBackToValidLegacy() {
        for (String xml : new String[] {"", "<Container:Directory>truncated", directory(PRIMARY + VIDEO.replace("'24'", "'-1'")), directory(PRIMARY + VIDEO.replace("'24'", "'999999'")), directory(PRIMARY + VIDEO.replace("MotionPhoto", "Other"))}) {
            byte[] bytes = photo(xml, 0);
            assertThrows(IllegalArgumentException.class, () -> detect(bytes));
        }
    }
    @Test public void legacyStillBoundaryAndPaddingMustAgree() throws Exception {
        byte[] bytes = photo("", 0);
        byte[] marker = "Camera:MotionPhoto='1'".getBytes(StandardCharsets.ISO_8859_1);
        // Remove only the modern declaration so the legacy branch is genuinely exercised.
        String header = new String(bytes, StandardCharsets.ISO_8859_1);
        int start = header.indexOf(" Camera:MotionPhoto='1'") + 1;
        java.util.Arrays.fill(bytes, start, start + marker.length, (byte) ' ');
        assertEquals(bytes.length - 32, detect(bytes).stillEnd);
        bytes[bytes.length - 25] = 1;
        assertThrows(IllegalArgumentException.class, () -> detect(bytes));
    }
    @Test public void ordinaryJpegDoesNotGetMotionDisclosure() throws Exception {
        assertNull(detect(new byte[] {(byte) 255, (byte) 216, (byte) 255, (byte) 217}));
    }
    @Test public void impossibleMp4BoxLengthIsRefused() {
        byte[] bytes = photo(directory(PRIMARY + VIDEO), 0);
        bytes[bytes.length - 24 + 2] = 4;
        assertThrows(IllegalArgumentException.class, () -> detect(bytes));
    }
    @Test public void namespaceAliasesHaveTheSameMeaning() throws Exception {
        byte[] bytes = photo(directory(PRIMARY + VIDEO), 0);
        String header = new String(bytes, StandardCharsets.ISO_8859_1).replace("xmlns:Camera=", "xmlns:CamAli=").replace(" Camera:", " CamAli:").replace("xmlns:Container=", "xmlns:ContAlias=").replace("Container:", "ContAlias:").replace("xmlns:Item=", "xmlns:Flds=").replace(" Item:", " Flds:");
        byte[] alias = header.getBytes(StandardCharsets.ISO_8859_1);
        assertEquals(alias.length - 32, detect(alias).stillEnd);
    }
    @Test public void explicitModernDisabledOverridesLegacy() throws Exception {
        for (String flag : new String[] {"0", "-1", "2"}) {
            byte[] bytes = photo(directory(PRIMARY + VIDEO), 0);
            String header = new String(bytes, StandardCharsets.ISO_8859_1).replace("Camera:MotionPhoto='1'", "Camera:MotionPhoto='" + flag + "'");
            assertNull(detect(header.getBytes(StandardCharsets.ISO_8859_1)));
        }
    }
    @Test public void sharedZeroLengthSecondaryIsAllowed() throws Exception {
        String shared = "<Container:Item Item:Mime='image/jpeg' Item:Semantic='GainMap' Item:Length='0'/>";
        byte[] bytes = photo(directory(PRIMARY + shared + VIDEO), 0);
        assertEquals(bytes.length - 32, detect(bytes).stillEnd);
    }
    @Test public void disabledModernOverridesDuplicateDeprecatedFlags() throws Exception {
        byte[] bytes = photo(directory(PRIMARY + VIDEO) + "<Meta GCamera:MicroVideo='1'/>", 0);
        String header = new String(bytes, StandardCharsets.ISO_8859_1).replace("Camera:MotionPhoto='1'", "Camera:MotionPhoto='0'");
        assertNull(detect(header.getBytes(StandardCharsets.ISO_8859_1)));
    }
    @Test public void requiredFieldsUniquePrimaryAndPrimaryOnlyPaddingAreEnforced() {
        String duplicate = "<Container:Item Item:Mime='image/jpeg' Item:Semantic='Primary' Item:Length='0'/>";
        String noSemantic = "<Container:Item Item:Mime='image/jpeg' Item:Length='0'/>";
        for (String items : new String[] {PRIMARY + duplicate + VIDEO, PRIMARY + noSemantic + VIDEO, PRIMARY + VIDEO.replace(" Item:Mime='video/mp4'", ""), PRIMARY + VIDEO.replace("/>", " Item:Padding='0'/>")}) {
            assertThrows(IllegalArgumentException.class, () -> detect(photo(directory(items), 0)));
        }
    }
}
