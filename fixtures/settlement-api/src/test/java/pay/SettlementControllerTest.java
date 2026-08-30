package pay;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
 * The settlement contract. These outcomes are fixed: an accepted advice returns
 * 201, a malformed one returns 400.
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
                                {"merchantId":"MERCH-001","currency":"GBP","amountMinor":12500}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("ACCEPTED"))
                .andExpect(jsonPath("$.settlementId").exists())
                .andExpect(jsonPath("$.keyEstablishment").exists());
    }

    @Test
    void malformedAdviceIsRejectedWith400() throws Exception {
        mvc.perform(post("/settlements")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"merchantId":"","amountMinor":-1}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void operatorConsoleRenders() throws Exception {
        mvc.perform(get("/")).andExpect(status().isOk());
    }

    @Test
    void healthEndpointAnswers() throws Exception {
        mvc.perform(get("/healthz")).andExpect(status().isOk());
    }
}
