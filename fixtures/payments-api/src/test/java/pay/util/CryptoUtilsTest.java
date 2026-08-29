package pay.util;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import org.junit.jupiter.api.Test;

class CryptoUtilsTest {

    @Test
    void hashesConsistently() {
        assertEquals(CryptoUtils.sha256Hex("NWP-88213|GBP|149900"),
                CryptoUtils.sha256Hex("NWP-88213|GBP|149900"));
    }

    @Test
    void differentInputsHashDifferently() {
        assertNotEquals(CryptoUtils.sha256Hex("a"), CryptoUtils.sha256Hex("b"));
    }

    @Test
    void base64RoundTrips() {
        byte[] raw = "settlement".getBytes();
        assertArrayEquals(raw, CryptoUtils.unb64(CryptoUtils.b64(raw)));
    }
}
