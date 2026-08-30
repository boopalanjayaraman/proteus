package pay;

import jakarta.validation.Valid;
import java.util.UUID;
import javax.crypto.SecretKey;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseBody;
import pay.model.SettlementRequest;
import pay.model.SettlementResponse;
import pay.security.KeyTransportService;
import pay.security.PartnerKeys;

@Controller
public class SettlementController {

    private final KeyTransportService keyTransport;
    private final PartnerKeys partnerKeys;

    public SettlementController(KeyTransportService keyTransport, PartnerKeys partnerKeys) {
        this.keyTransport = keyTransport;
        this.partnerKeys = partnerKeys;
    }

    /** Operator console. Shows the mechanism currently in use. */
    @GetMapping("/")
    public String console(Model model) {
        model.addAttribute("keyEstablishment", keyTransport.negotiatedKeyEstablishment());
        return "index";
    }

    /**
     * Settles an advice.
     *
     * Returns 201 on acceptance and 400 on a malformed request. Both are part of
     * the acquirer contract and neither may change.
     */
    @PostMapping("/settlements")
    @ResponseBody
    public ResponseEntity<SettlementResponse> settle(@Valid @RequestBody SettlementRequest request)
            throws Exception {
        SecretKey sessionKey = keyTransport.newSessionKey();
        byte[] wrapped = keyTransport.wrapSessionKey(sessionKey, partnerKeys.partnerPublicKey());

        SettlementResponse response = new SettlementResponse(
                UUID.randomUUID().toString(),
                "ACCEPTED",
                keyTransport.negotiatedKeyEstablishment(),
                wrapped.length);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /** Liveness, used by the platform health check. */
    @GetMapping("/healthz")
    @ResponseBody
    public ResponseEntity<String> healthz() {
        return ResponseEntity.ok("ok");
    }
}
