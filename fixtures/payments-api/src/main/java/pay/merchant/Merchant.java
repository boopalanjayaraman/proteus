package pay.merchant;

public class Merchant {

    private final String id;
    private final String name;
    private final String settlementCurrency;

    public Merchant(String id, String name, String settlementCurrency) {
        this.id = id;
        this.name = name;
        this.settlementCurrency = settlementCurrency;
    }

    public String getId() { return id; }
    public String getName() { return name; }
    public String getSettlementCurrency() { return settlementCurrency; }
}
