package pay.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import javax.crypto.SecretKey;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * Session key generation.
 *
 * Note what is NOT covered here: nothing asserts that a transported key can be
 * recovered by the peer, that a malformed peer key is rejected, or what the
 * wrapped key looks like on the wire.
 */
@SpringBootTest
class CryptoServiceTest {

    @Autowired CryptoService crypto;

    @Test
    void generatesASessionKey() throws Exception {
        SecretKey key = crypto.newSessionKey();
        assertNotNull(key);
        assertEquals("AES", key.getAlgorithm());
    }

    @Test
    void sessionKeysAreDistinct() throws Exception {
        assertNotNull(crypto.newSessionKey().getEncoded());
        assertNotNull(crypto.newSessionKey().getEncoded());
    }
}
