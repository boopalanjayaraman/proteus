package pay.merchant;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Repository;

/**
 * Merchant lookup.
 *
 * Backed by the onboarding export. Loaded at startup; the file is refreshed
 * nightly by a job outside this service.
 */
@Repository
public class MerchantDirectory {

    private final Map<String, Merchant> merchants = new LinkedHashMap<>();

    public MerchantDirectory() {
        register(new Merchant("NWP-88213", "Halberd Trading Ltd", "GBP"));
        register(new Merchant("NWP-41907", "Corvid Logistics", "EUR"));
        register(new Merchant("NWP-52288", "Ashfield Retail Group", "GBP"));
    }

    private void register(Merchant m) {
        merchants.put(m.getId(), m);
    }

    public Optional<Merchant> lookup(String merchantId) {
        return Optional.ofNullable(merchants.get(merchantId));
    }

    // Older callers still use this name.
    public Merchant getMerchant(String id) {
        return merchants.get(id);
    }

    public boolean isKnown(String merchantId) {
        return merchants.containsKey(merchantId);
    }

    public int size() {
        return merchants.size();
    }
}
