package pay.security;

import java.security.PublicKey;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.springframework.stereotype.Service;

/**
 * Establishes the symmetric session key used to protect a settlement exchange
 * with an acquirer.
 *
 * The session key is generated locally and transported to the peer under the
 * peer's public key. This is key transport, not signing: the primitive here
 * carries a key, it does not attest to anything.
 */
@Service
public class CryptoService {

    private static final String KEY_TRANSPORT_TRANSFORM =
            "RSA/ECB/OAEPWithSHA-256AndMGF1Padding";

    private static final String SESSION_CIPHER = "AES";
    private static final int SESSION_KEY_BITS = 256;

    private final SecureRandom random = new SecureRandom();

    /** Fresh symmetric key for one settlement exchange. */
    public SecretKey newSessionKey() throws Exception {
        KeyGenerator kg = KeyGenerator.getInstance(SESSION_CIPHER);
        kg.init(SESSION_KEY_BITS, random);
        return kg.generateKey();
    }

    /**
     * Wraps the session key for transport to the acquirer.
     *
     * @param sessionKey the key to transport
     * @param peer       the acquirer's public key
     * @return the wrapped key, as sent on the wire
     */
    public byte[] wrapSessionKey(SecretKey sessionKey, PublicKey peer) throws Exception {
        Cipher cipher = Cipher.getInstance(KEY_TRANSPORT_TRANSFORM);
        cipher.init(Cipher.WRAP_MODE, peer, random);
        return cipher.wrap(sessionKey);
    }

    /** Unwraps a session key received from the acquirer. */
    public SecretKey unwrapSessionKey(byte[] wrapped, java.security.PrivateKey ours)
            throws Exception {
        Cipher cipher = Cipher.getInstance(KEY_TRANSPORT_TRANSFORM);
        cipher.init(Cipher.UNWRAP_MODE, ours);
        return (SecretKey) cipher.unwrap(wrapped, SESSION_CIPHER, Cipher.SECRET_KEY);
    }

    /**
     * The key-establishment mechanism this service negotiated, as reported to
     * the operator console and returned on every settlement response.
     */
    public String negotiatedKeyEstablishment() {
        return "RSA-2048";
    }
}
