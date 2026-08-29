package pay.security;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.util.Date;
import org.springframework.stereotype.Service;

/**
 * Issues access tokens for the merchant portal.
 *
 * Tokens are signed so the portal can verify them without calling back here.
 * The algorithm is fixed by the portal's published JWKS.
 */
@Service
public class ApiTokenService {

    private static final JWSAlgorithm TOKEN_ALGORITHM = JWSAlgorithm.RS256;
    private static final long TOKEN_TTL_MS = 15 * 60 * 1000L;

    private final RSAPrivateKey signingKey;
    private final RSAPublicKey verificationKey;

    public ApiTokenService(SigningKeyProvider keys) {
        this.signingKey = (RSAPrivateKey) keys.settlementSigningKeyPair().getPrivate();
        this.verificationKey = (RSAPublicKey) keys.settlementSigningKeyPair().getPublic();
    }

    public String issue(String merchantId) throws Exception {
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .subject(merchantId)
                .issuer("northwind-pay")
                .expirationTime(new Date(System.currentTimeMillis() + TOKEN_TTL_MS))
                .build();

        SignedJWT jwt = new SignedJWT(new JWSHeader(TOKEN_ALGORITHM), claims);
        jwt.sign(new RSASSASigner(signingKey));
        return jwt.serialize();
    }

    public boolean isValid(String token) {
        try {
            SignedJWT jwt = SignedJWT.parse(token);
            if (!jwt.verify(new RSASSAVerifier(verificationKey))) {
                return false;
            }
            Date exp = jwt.getJWTClaimsSet().getExpirationTime();
            return exp != null && exp.after(new Date());
        } catch (Exception e) {
            return false;
        }
    }

    public String tokenAlgorithm() {
        return TOKEN_ALGORITHM.getName();
    }
}
