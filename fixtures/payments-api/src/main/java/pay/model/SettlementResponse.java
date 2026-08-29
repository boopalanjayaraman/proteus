package pay.model;

/**
 * The settlement envelope. Its shape is fixed by the acquirer contract.
 *
 * `keyEstablishment` reports the mechanism that protected this exchange. It is
 * informational — the operator console displays it — and is not part of the
 * signed advice.
 */
public class SettlementResponse {

    private final String settlementId;
    private final String status;
    private final String keyEstablishment;
    private final String signatureAlgorithm;
    private final int wrappedKeyBytes;

    public SettlementResponse(String settlementId, String status, String keyEstablishment,
                              String signatureAlgorithm, int wrappedKeyBytes) {
        this.settlementId = settlementId;
        this.status = status;
        this.keyEstablishment = keyEstablishment;
        this.signatureAlgorithm = signatureAlgorithm;
        this.wrappedKeyBytes = wrappedKeyBytes;
    }

    public String getSettlementId() { return settlementId; }
    public String getStatus() { return status; }
    public String getKeyEstablishment() { return keyEstablishment; }
    public String getSignatureAlgorithm() { return signatureAlgorithm; }
    public int getWrappedKeyBytes() { return wrappedKeyBytes; }
}
