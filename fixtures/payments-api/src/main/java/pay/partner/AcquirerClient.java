package pay.partner;

import javax.crypto.SecretKey;
import org.springframework.stereotype.Component;
import pay.security.CryptoService;
import pay.security.PartnerKeyProvider;

/**
 * The boundary with the acquiring bank.
 *
 * A settlement exchange establishes a session key with the acquirer, then sends
 * the advice under it. The handshake is where the two sides agree how that key
 * is transported, which makes this the point at which a change to the key
 * establishment mechanism becomes visible to the counterparty.
 */
@Component
public class AcquirerClient {

    private final CryptoService crypto;
    private final PartnerKeyProvider partnerKeys;

    public AcquirerClient(CryptoService crypto, PartnerKeyProvider partnerKeys) {
        this.crypto = crypto;
        this.partnerKeys = partnerKeys;
    }

    /**
     * Performs the key-establishment leg of the settlement exchange.
     *
     * @return the wrapped session key as it is placed on the wire
     */
    public byte[] establishSession(SecretKey sessionKey) throws Exception {
        return crypto.wrapSessionKey(sessionKey, partnerKeys.acquirerPublicKey());
    }

    /** The key type this acquirer presents during the handshake. */
    public String presentedKeyType() {
        return partnerKeys.keyType();
    }
}
