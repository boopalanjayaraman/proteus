package pay.security;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import javax.crypto.SecretKey;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * Session key establishment with the acquirer.
 *
 * These assertions are about the mechanism's behaviour, not its identity: a key
 * is generated, it is transported, and the peer recovers the same key. Nothing
 * here names an algorithm or a byte length, so the contract survives a change of
 * primitive.
 */
@SpringBootTest
class KeyTransportServiceTest {

    @Autowired KeyTransportService keyTransport;
    @Autowired PartnerKeys partnerKeys;

    @Test
    void generatesAnAesSessionKey() throws Exception {
        SecretKey key = keyTransport.newSessionKey();
        assertNotNull(key);
        assertEquals("AES", key.getAlgorithm());
    }

    @Test
    void placesSomethingOnTheWire() throws Exception {
        SecretKey sessionKey = keyTransport.newSessionKey();
        byte[] wrapped = keyTransport.wrapSessionKey(sessionKey, partnerKeys.partnerPublicKey());
        assertNotNull(wrapped);
        assertTrue(wrapped.length > 0);
    }

    @Test
    void theAcquirerRecoversTheSessionKeyThatWasSent() throws Exception {
        SecretKey sessionKey = keyTransport.newSessionKey();

        byte[] wrapped = keyTransport.wrapSessionKey(sessionKey, partnerKeys.partnerPublicKey());
        SecretKey recovered = keyTransport.unwrapSessionKey(wrapped, partnerKeys.partnerPrivateKey());

        // The property the whole exchange rests on: both sides end up holding
        // the same key. Whatever primitive carries it must preserve this.
        assertArrayEquals(sessionKey.getEncoded(), recovered.getEncoded());
    }

    @Test
    void reportsTheNegotiatedMechanism() {
        assertNotNull(keyTransport.negotiatedKeyEstablishment());
        assertTrue(keyTransport.negotiatedKeyEstablishment().length() > 0);
    }
}
