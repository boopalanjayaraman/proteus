package pay.security;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import org.springframework.stereotype.Component;

/**
 * Supplies the acquirer's key material used for session key transport.
 *
 * The acquirer publishes its public key through the partner directory. The
 * private half exists here only so the sandbox can complete a round trip
 * without a live counterparty.
 */
@Component
public class PartnerKeyProvider {

    private final KeyPair acquirerKeyPair;

    public PartnerKeyProvider() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            this.acquirerKeyPair = generator.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException("cannot initialise acquirer key material", e);
        }
    }

    public PublicKey acquirerPublicKey() {
        return acquirerKeyPair.getPublic();
    }

    public java.security.PrivateKey acquirerPrivateKey() {
        return acquirerKeyPair.getPrivate();
    }

    /** Identifies the key type presented during the handshake. */
    public String keyType() {
        return "RSA_PUBLIC_KEY";
    }
}
