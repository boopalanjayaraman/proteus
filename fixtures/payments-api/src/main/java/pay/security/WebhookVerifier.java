package pay.security;

import java.nio.charset.StandardCharsets;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Verifies callbacks from the acquirer.
 *
 * The acquirer signs each callback body with a shared secret agreed during
 * onboarding.
 */
@Service
public class WebhookVerifier {

    private static final String MAC_ALGORITHM = "HmacSHA256";

    private final byte[] sharedSecret;

    public WebhookVerifier(@Value("${acquirer.webhook.secret:onboarding-shared-secret}") String secret) {
        this.sharedSecret = secret.getBytes(StandardCharsets.UTF_8);
    }

    public boolean isAuthentic(String body, String presentedSignature) {
        try {
            Mac mac = Mac.getInstance(MAC_ALGORITHM);
            mac.init(new SecretKeySpec(sharedSecret, MAC_ALGORITHM));
            byte[] computed = mac.doFinal(body.getBytes(StandardCharsets.UTF_8));
            return constantTimeEquals(computed, pay.util.CryptoUtils.unb64(presentedSignature));
        } catch (Exception e) {
            return false;
        }
    }

    public String sign(String body) throws Exception {
        Mac mac = Mac.getInstance(MAC_ALGORITHM);
        mac.init(new SecretKeySpec(sharedSecret, MAC_ALGORITHM));
        return pay.util.CryptoUtils.b64(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
    }

    private boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a.length != b.length) {
            return false;
        }
        int diff = 0;
        for (int i = 0; i < a.length; i++) {
            diff |= a[i] ^ b[i];
        }
        return diff == 0;
    }

    public String macAlgorithm() {
        return MAC_ALGORITHM;
    }
}
