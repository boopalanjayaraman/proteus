package pay.security;

import java.security.KeyPair;
import java.security.Signature;
import org.springframework.stereotype.Service;

/**
 * Signs settlement advices so the acquirer can attest their origin, and
 * verifies advices received from the acquirer.
 *
 * This is a DIGITAL SIGNATURE usage. It is deliberately not the same concern as
 * key transport in {@link CryptoService}: a signature scheme and a key
 * encapsulation mechanism are not interchangeable, and the settlement contract
 * with the acquirer fixes the signature algorithm.
 */
@Service
public class SettlementSigner {

    private static final String SIGNATURE_ALGORITHM = "SHA256withRSA";

    private final KeyPair signingKeyPair;

    public SettlementSigner(SigningKeyProvider keys) {
        this.signingKeyPair = keys.settlementSigningKeyPair();
    }

    /** Signs the canonical form of a settlement advice. */
    public byte[] sign(byte[] canonicalAdvice) throws Exception {
        Signature signature = Signature.getInstance(SIGNATURE_ALGORITHM);
        signature.initSign(signingKeyPair.getPrivate());
        signature.update(canonicalAdvice);
        return signature.sign();
    }

    /** Verifies an advice signed by this service. */
    public boolean verify(byte[] canonicalAdvice, byte[] sig) throws Exception {
        Signature signature = Signature.getInstance(SIGNATURE_ALGORITHM);
        signature.initVerify(signingKeyPair.getPublic());
        signature.update(canonicalAdvice);
        return signature.verify(sig);
    }

    public String signatureAlgorithm() {
        return SIGNATURE_ALGORITHM;
    }
}
