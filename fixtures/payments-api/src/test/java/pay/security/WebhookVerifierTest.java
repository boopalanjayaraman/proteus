package pay.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class WebhookVerifierTest {

    @Autowired WebhookVerifier verifier;

    private static final String BODY =
            "{\"eventType\":\"settlement.completed\",\"settlementId\":\"abc\"}";

    @Test
    void acceptsACallbackItSigned() throws Exception {
        assertTrue(verifier.isAuthentic(BODY, verifier.sign(BODY)));
    }

    @Test
    void rejectsATamperedBody() throws Exception {
        String signature = verifier.sign(BODY);
        assertFalse(verifier.isAuthentic(BODY.replace("abc", "xyz"), signature));
    }

    @Test
    void rejectsAGarbageSignature() {
        assertFalse(verifier.isAuthentic(BODY, "bm90LWEtc2lnbmF0dXJl"));
    }

    @Test
    void usesHmacSha256() {
        assertEquals("HmacSHA256", verifier.macAlgorithm());
    }
}
