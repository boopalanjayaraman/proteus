package pay.store;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.springframework.stereotype.Repository;

/**
 * Settlement ledger.
 *
 * In-memory for now — the ledger-db migration was descoped in the 1.3 release
 * and has not been picked up since.
 */
@Repository
public class LedgerRepository {

    public record Entry(String settlementId, String merchantId, long amountMinor, Instant at) { }

    private final List<Entry> entries = Collections.synchronizedList(new ArrayList<>());

    public void append(String settlementId, String merchantId, long amountMinor) {
        entries.add(new Entry(settlementId, merchantId, amountMinor, Instant.now()));
    }

    public List<Entry> recent(int limit) {
        synchronized (entries) {
            int from = Math.max(0, entries.size() - limit);
            return List.copyOf(entries.subList(from, entries.size()));
        }
    }

    public long totalMinorFor(String merchantId) {
        synchronized (entries) {
            return entries.stream()
                    .filter(e -> e.merchantId().equals(merchantId))
                    .mapToLong(Entry::amountMinor)
                    .sum();
        }
    }

    public int count() {
        return entries.size();
    }
}
