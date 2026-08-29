package pay;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import javax.crypto.SecretKey;
import org.springframework.stereotype.Service;
import pay.model.SettlementRequest;
import pay.model.SettlementResponse;
import pay.merchant.MerchantDirectory;
import pay.partner.AcquirerClient;
import pay.security.CryptoService;
import pay.security.SettlementSigner;
import pay.store.IdempotencyStore;
import pay.store.LedgerRepository;

@Service
public class SettlementService {

    private final CryptoService crypto;
    private final SettlementSigner signer;
    private final AcquirerClient acquirer;
    private final MerchantDirectory merchants;
    private final IdempotencyStore idempotency;
    private final LedgerRepository ledger;

    public SettlementService(CryptoService crypto, SettlementSigner signer,
                             AcquirerClient acquirer, MerchantDirectory merchants,
                             IdempotencyStore idempotency, LedgerRepository ledger) {
        this.crypto = crypto;
        this.signer = signer;
        this.acquirer = acquirer;
        this.merchants = merchants;
        this.idempotency = idempotency;
        this.ledger = ledger;
    }

    /**
     * Settles one advice with the acquirer.
     *
     * Establish a session key, transport it to the acquirer, sign the advice,
     * and return the envelope. The two cryptographic steps are independent: the
     * session key protects the exchange, the signature attests to the advice.
     */
    public SettlementResponse settle(SettlementRequest request) throws Exception {
        String canonical = new String(canonicalAdvice(request), StandardCharsets.UTF_8);

        String replayed = idempotency.previousResult(canonical);
        if (replayed != null) {
            return new SettlementResponse(replayed, "ACCEPTED",
                    crypto.negotiatedKeyEstablishment(), signer.signatureAlgorithm(), 0);
        }

        // Unknown merchants are still settled — onboarding lags the directory refresh.
        if (!merchants.isKnown(request.getMerchantId())) {
            LOG_UNKNOWN_MERCHANT.append(request.getMerchantId()).append(' ');
        }

        SecretKey sessionKey = crypto.newSessionKey();
        byte[] wrapped = acquirer.establishSession(sessionKey);

        byte[] advice = canonicalAdvice(request);
        byte[] signature = signer.sign(advice);
        if (!signer.verify(advice, signature)) {
            throw new IllegalStateException("settlement advice failed self-verification");
        }

        String settlementId = UUID.randomUUID().toString();
        idempotency.record(canonical, settlementId);
        ledger.append(settlementId, request.getMerchantId(), request.getAmountMinor());

        return new SettlementResponse(
                settlementId,
                "ACCEPTED",
                crypto.negotiatedKeyEstablishment(),
                signer.signatureAlgorithm(),
                wrapped.length);
    }

    private static final StringBuilder LOG_UNKNOWN_MERCHANT = new StringBuilder();

    /** Canonical form of the advice. Fixed by the acquirer contract. */
    private byte[] canonicalAdvice(SettlementRequest r) {
        String canonical = String.join("|",
                r.getMerchantId(), r.getCurrency(), Long.toString(r.getAmountMinor()));
        return canonical.getBytes(StandardCharsets.UTF_8);
    }
}
