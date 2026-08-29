package pay;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import javax.crypto.SecretKey;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import pay.partner.AcquirerClient;
import pay.security.CryptoService;

/**
 * Exercises the key-establishment leg against the partner simulator.
 *
 * The simulator reflects what the acquirer sandbox presents today. If the key
 * type on the wire changes, this test is the first thing that notices.
 */
@SpringBootTest
class PartnerHandshakeIntegrationTest {

    @Autowired CryptoService crypto;
    @Autowired AcquirerClient acquirer;

    @Test
    void completesTheHandshakeWithTheAcquirer() throws Exception {
        PartnerHandshakeMock partner = new PartnerHandshakeMock();

        partner.handshake(acquirer.presentedKeyType());
        assertEquals("RSA_PUBLIC_KEY", partner.lastSeenKeyType());
    }

    @Test
    void transportsASessionKeyToTheAcquirer() throws Exception {
        SecretKey sessionKey = crypto.newSessionKey();
        byte[] wrapped = acquirer.establishSession(sessionKey);

        assertNotNull(wrapped);
        assertEquals(256, wrapped.length, "wrapped session key length on the wire");
    }
}
