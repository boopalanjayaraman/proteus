package pay.store;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;
import pay.util.CryptoUtils;

/**
 * Stops a replayed advice from settling twice.
 *
 * Keyed on a digest of the advice rather than the raw body so the map does not
 * hold merchant data.
 */
@Component
public class IdempotencyStore {

    private final Map<String, String> seen = new ConcurrentHashMap<>();

    /** @return the settlement id if this advice was already processed. */
    public String previousResult(String canonicalAdvice) {
        return seen.get(CryptoUtils.sha256Hex(canonicalAdvice));
    }

    public void record(String canonicalAdvice, String settlementId) {
        seen.put(CryptoUtils.sha256Hex(canonicalAdvice), settlementId);
    }

    public int size() {
        return seen.size();
    }

    public void clear() {
        seen.clear();
    }
}
