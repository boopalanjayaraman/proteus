package pay.model;

public class SettlementResponse {

    private final String settlementId;
    private final String status;
    private final String keyEstablishment;
    private final int wrappedKeyBytes;

    public SettlementResponse(String settlementId, String status,
                              String keyEstablishment, int wrappedKeyBytes) {
        this.settlementId = settlementId;
        this.status = status;
        this.keyEstablishment = keyEstablishment;
        this.wrappedKeyBytes = wrappedKeyBytes;
    }

    public String getSettlementId() { return settlementId; }
    public String getStatus() { return status; }
    public String getKeyEstablishment() { return keyEstablishment; }
    public int getWrappedKeyBytes() { return wrappedKeyBytes; }
}
