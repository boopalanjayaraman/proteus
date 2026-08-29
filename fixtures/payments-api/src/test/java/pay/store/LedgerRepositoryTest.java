package pay.store;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class LedgerRepositoryTest {

    @Test
    void recordsSettlements() {
        LedgerRepository ledger = new LedgerRepository();
        ledger.append("s1", "NWP-88213", 1000);
        ledger.append("s2", "NWP-88213", 2500);
        assertEquals(2, ledger.count());
    }

    @Test
    void totalsByMerchant() {
        LedgerRepository ledger = new LedgerRepository();
        ledger.append("s1", "NWP-88213", 1000);
        ledger.append("s2", "NWP-41907", 4000);
        ledger.append("s3", "NWP-88213", 2500);
        assertEquals(3500, ledger.totalMinorFor("NWP-88213"));
    }

    @Test
    void returnsTheMostRecentEntries() {
        LedgerRepository ledger = new LedgerRepository();
        for (int i = 0; i < 10; i++) {
            ledger.append("s" + i, "NWP-88213", i);
        }
        assertEquals(3, ledger.recent(3).size());
    }
}
