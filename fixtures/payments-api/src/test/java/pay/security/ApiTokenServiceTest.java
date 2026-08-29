package pay.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class ApiTokenServiceTest {

    @Autowired ApiTokenService tokens;

    @Test
    void issuesAVerifiableToken() throws Exception {
        assertTrue(tokens.isValid(tokens.issue("NWP-88213")));
    }

    @Test
    void rejectsAnAlteredToken() throws Exception {
        String token = tokens.issue("NWP-88213");
        String altered = token.substring(0, token.length() - 4) + "AAAA";
        assertFalse(tokens.isValid(altered));
    }

    @Test
    void rejectsRubbish() {
        assertFalse(tokens.isValid("not.a.token"));
    }

    @Test
    void signsWithTheAlgorithmThePortalExpects() {
        assertEquals("RS256", tokens.tokenAlgorithm());
    }
}
