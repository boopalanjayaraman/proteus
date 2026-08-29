package pay;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * The settlement contract with the acquirer. These outcomes are fixed:
 * an accepted advice returns 201, a malformed one returns 400.
 */
@SpringBootTest
@AutoConfigureMockMvc
class SettlementControllerTest {

    @Autowired MockMvc mvc;

    @Test
    void acceptedSettlementReturns201() throws Exception {
        mvc.perform(post("/settlements")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"merchantId":"NWP-88213","currency":"GBP","amountMinor":149900}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("ACCEPTED"))
                .andExpect(jsonPath("$.settlementId").exists());
    }

    @Test
    void malformedAdviceIsRejectedWith400() throws Exception {
        mvc.perform(post("/settlements")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"merchantId":"","currency":"GBP","amountMinor":-5}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void responseEnvelopeCarriesTheAgreedFields() throws Exception {
        mvc.perform(post("/settlements")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"merchantId":"NWP-88213","currency":"GBP","amountMinor":1000}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.settlementId").exists())
                .andExpect(jsonPath("$.status").exists())
                .andExpect(jsonPath("$.keyEstablishment").exists())
                .andExpect(jsonPath("$.signatureAlgorithm").exists());
    }

    @Test
    void emptyAdviceIsRejectedWith400() throws Exception {
        mvc.perform(post("/settlements")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());
    }
}
