package pay.security;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import org.springframework.stereotype.Component;

/**
 * Supplies the settlement signing key pair.
 *
 * In production this material is held in the payment HSM and never leaves it.
 * For local and sandbox running the key pair is generated at startup, which is
 * why this class exists at all.
 */
@Component
public class SigningKeyProvider {

    private final KeyPair settlementKeyPair;

    public SigningKeyProvider() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(4096);
            this.settlementKeyPair = generator.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException("cannot initialise settlement signing key", e);
        }
    }

    public KeyPair settlementSigningKeyPair() {
        return settlementKeyPair;
    }
}
