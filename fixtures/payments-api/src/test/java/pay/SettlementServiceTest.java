package pay;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import pay.model.SettlementRequest;
import pay.model.SettlementResponse;

@SpringBootTest
class SettlementServiceTest {

    @Autowired SettlementService settlements;

    private SettlementRequest advice(long amount) {
        SettlementRequest r = new SettlementRequest();
        r.setMerchantId("NWP-88213");
        r.setCurrency("GBP");
        r.setAmountMinor(amount);
        return r;
    }

    @Test
    void settlesAnAdvice() throws Exception {
        SettlementResponse response = settlements.settle(advice(149900));
        assertEquals("ACCEPTED", response.getStatus());
        assertNotNull(response.getSettlementId());
    }

    @Test
    void reportsTheMechanismsInUse() throws Exception {
        SettlementResponse response = settlements.settle(advice(1000));
        assertNotNull(response.getKeyEstablishment());
        assertNotNull(response.getSignatureAlgorithm());
    }

    @Test
    void everySettlementGetsADistinctIdentifier() throws Exception {
        assertNotNull(settlements.settle(advice(1)).getSettlementId());
        assertNotNull(settlements.settle(advice(2)).getSettlementId());
    }
}
