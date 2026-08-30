package pay.model;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;

public class SettlementRequest {

    @NotBlank
    private String merchantId;

    @Positive
    private long amountMinor;

    private String currency;
    private String reference;

    public String getMerchantId() { return merchantId; }
    public void setMerchantId(String merchantId) { this.merchantId = merchantId; }

    public long getAmountMinor() { return amountMinor; }
    public void setAmountMinor(long amountMinor) { this.amountMinor = amountMinor; }

    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }

    public String getReference() { return reference; }
    public void setReference(String reference) { this.reference = reference; }
}
