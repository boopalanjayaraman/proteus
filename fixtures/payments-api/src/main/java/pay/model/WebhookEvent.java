package pay.model;

public class WebhookEvent {

    private String eventType;
    private String settlementId;
    private String status;

    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }

    public String getSettlementId() { return settlementId; }
    public void setSettlementId(String settlementId) { this.settlementId = settlementId; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
}
