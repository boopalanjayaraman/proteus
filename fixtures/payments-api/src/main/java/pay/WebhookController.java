package pay;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import pay.security.WebhookVerifier;

/**
 * Receives acquirer callbacks.
 *
 * The acquirer signs the body; anything that does not verify is dropped without
 * being parsed.
 */
@RestController
public class WebhookController {

    private final WebhookVerifier verifier;

    public WebhookController(WebhookVerifier verifier) {
        this.verifier = verifier;
    }

    @PostMapping("/webhooks/acquirer")
    public ResponseEntity<String> receive(
            @RequestBody String body,
            @RequestHeader(value = "X-Acquirer-Signature", required = false) String signature) {

        if (signature == null || !verifier.isAuthentic(body, signature)) {
            return ResponseEntity.status(401).body("signature rejected");
        }
        return ResponseEntity.accepted().body("ok");
    }
}
