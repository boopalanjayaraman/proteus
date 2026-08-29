package pay.model;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;

public class SettlementRequest {

    @NotBlank
    private String merchantId;

    @NotBlank
    private String currency;

    @Positive
    private long amountMinor;

    public String getMerchantId() { return merchantId; }
    public void setMerchantId(String merchantId) { this.merchantId = merchantId; }

    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }

    public long getAmountMinor() { return amountMinor; }
    public void setAmountMinor(long amountMinor) { this.amountMinor = amountMinor; }
}
