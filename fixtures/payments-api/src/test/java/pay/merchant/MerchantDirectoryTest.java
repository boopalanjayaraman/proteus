package pay.merchant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MerchantDirectoryTest {

    private final MerchantDirectory directory = new MerchantDirectory();

    @Test
    void findsAnOnboardedMerchant() {
        assertTrue(directory.lookup("NWP-88213").isPresent());
    }

    @Test
    void doesNotInventMerchants() {
        assertFalse(directory.lookup("NWP-00000").isPresent());
        assertFalse(directory.isKnown("NWP-00000"));
    }

    @Test
    void carriesTheSettlementCurrency() {
        assertEquals("GBP", directory.lookup("NWP-88213").orElseThrow().getSettlementCurrency());
    }
}
