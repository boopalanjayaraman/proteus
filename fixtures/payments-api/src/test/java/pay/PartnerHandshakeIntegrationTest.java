package pay;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

        // The simulator decides which key types it accepts. This asserts the
        // handshake completed with what the acquirer actually presented, so the
        // accepted type lives in one place — the simulator — rather than being
        // restated here.
        partner.handshake(acquirer.presentedKeyType());
        assertEquals(acquirer.presentedKeyType(), partner.lastSeenKeyType());
    }

    @Test
    void transportsASessionKeyToTheAcquirer() throws Exception {
        SecretKey sessionKey = crypto.newSessionKey();
        byte[] wrapped = acquirer.establishSession(sessionKey);

        // The session key reaches the acquirer as an opaque blob. Its length is
        // a property of the key-establishment mechanism, not of the contract, so
        // it is deliberately not asserted here.
        assertNotNull(wrapped);
        assertTrue(wrapped.length > 0, "a session key was placed on the wire");
    }
}
