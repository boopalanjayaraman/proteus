package pay.security;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import org.springframework.stereotype.Component;

/**
 * The acquirer's key material for session key transport.
 *
 * The acquirer publishes its public key through the partner directory. The
 * private half exists here only so a sandbox can complete a round trip without
 * a live counterparty.
 */
@Component
public class PartnerKeys {

    private final KeyPair partnerKeyPair;

    public PartnerKeys() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            this.partnerKeyPair = generator.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException("cannot initialise partner key material", e);
        }
    }

    public PublicKey partnerPublicKey() {
        return partnerKeyPair.getPublic();
    }

    public PrivateKey partnerPrivateKey() {
        return partnerKeyPair.getPrivate();
    }
}
