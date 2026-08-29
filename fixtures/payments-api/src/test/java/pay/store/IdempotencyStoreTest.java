package pay.store;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class IdempotencyStoreTest {

    private final IdempotencyStore store = new IdempotencyStore();

    @BeforeEach
    void reset() {
        store.clear();
    }

    @Test
    void returnsNothingForAnUnseenAdvice() {
        assertNull(store.previousResult("NWP-88213|GBP|100"));
    }

    @Test
    void returnsTheOriginalSettlementIdOnReplay() {
        store.record("NWP-88213|GBP|100", "settlement-1");
        assertEquals("settlement-1", store.previousResult("NWP-88213|GBP|100"));
    }

    @Test
    void treatsDifferentAdvicesSeparately() {
        store.record("NWP-88213|GBP|100", "settlement-1");
        assertNull(store.previousResult("NWP-88213|GBP|200"));
    }
}
