package pay.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * The advice signature. Distinct from session key transport: this attests to
 * the advice, it does not carry a key.
 */
@SpringBootTest
class SettlementSignerTest {

    @Autowired SettlementSigner signer;

    private static final byte[] ADVICE =
            "NWP-88213|GBP|149900".getBytes(StandardCharsets.UTF_8);

    @Test
    void signsAndVerifiesAnAdvice() throws Exception {
        byte[] signature = signer.sign(ADVICE);
        assertTrue(signer.verify(ADVICE, signature));
    }

    @Test
    void rejectsAnAlteredAdvice() throws Exception {
        byte[] signature = signer.sign(ADVICE);
        byte[] altered = "NWP-88213|GBP|249900".getBytes(StandardCharsets.UTF_8);
        assertFalse(signer.verify(altered, signature));
    }

    @Test
    void usesTheContractedSignatureAlgorithm() {
        assertEquals("SHA256withRSA", signer.signatureAlgorithm());
    }
}
