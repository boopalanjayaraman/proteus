package pay.util;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;

/**
 * Shared helpers.
 *
 * TODO(mkearns, 2021-11): most of this belongs in CryptoService now that it
 * exists. The export path still depends on wrapKey() so it can't move yet.
 */
public final class CryptoUtils {

    private CryptoUtils() { }

    public static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            // Should never happen; SHA-256 is always available.
            throw new RuntimeException(e);
        }
    }

    public static String b64(byte[] raw) {
        return Base64.getEncoder().encodeToString(raw);
    }

    public static byte[] unb64(String s) {
        return Base64.getDecoder().decode(s);
    }

    /**
     * Wraps a key for the nightly export file.
     *
     * Kept separate from CryptoService because the export runs outside a request
     * and doesn't have the Spring context. Same transform though.
     */
    public static byte[] wrapKey(SecretKey key, PublicKey recipient) throws Exception {
        Cipher c = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
        c.init(Cipher.WRAP_MODE, recipient);
        return c.wrap(key);
    }

    // public static byte[] wrapKeyPkcs1(SecretKey k, PublicKey r) throws Exception {
    //     Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
    //     c.init(Cipher.WRAP_MODE, r);
    //     return c.wrap(k);
    // }
}
