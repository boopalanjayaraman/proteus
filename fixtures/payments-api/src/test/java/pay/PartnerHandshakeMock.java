package pay;

/**
 * Stands in for the acquirer during handshake tests.
 *
 * The simulator asserts the key type the acquirer presents. Today that is an
 * RSA public key, which is what the live sandbox endpoint returns.
 */
public class PartnerHandshakeMock {

    public static final String EXPECTED_KEY_TYPE = "RSA_PUBLIC_KEY";

    private String lastSeenKeyType;

    /** Called by the handshake under test with the key type it presented. */
    public void handshake(String presentedKeyType) {
        if (!EXPECTED_KEY_TYPE.equals(presentedKeyType)) {
            throw new IllegalArgumentException(
                    "Unsupported key exchange " + presentedKeyType
                            + " (expected " + EXPECTED_KEY_TYPE + ")");
        }
        this.lastSeenKeyType = presentedKeyType;
    }

    public String respond() {
        return legacyRsaKey();
    }

    public String lastSeenKeyType() {
        return lastSeenKeyType;
    }

    private String legacyRsaKey() {
        return EXPECTED_KEY_TYPE;
    }
}
