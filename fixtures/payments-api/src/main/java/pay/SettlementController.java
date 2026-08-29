package pay;

import jakarta.validation.Valid;
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
import pay.security.CryptoService;
import pay.security.SettlementSigner;

@Controller
public class SettlementController {

    private final SettlementService settlements;
    private final CryptoService crypto;
    private final SettlementSigner signer;

    public SettlementController(SettlementService settlements, CryptoService crypto,
                                SettlementSigner signer) {
        this.settlements = settlements;
        this.crypto = crypto;
        this.signer = signer;
    }

    /** Operator console. Shows the mechanisms currently in use. */
    @GetMapping("/")
    public String console(Model model) {
        model.addAttribute("keyEstablishment", crypto.negotiatedKeyEstablishment());
        model.addAttribute("signatureAlgorithm", signer.signatureAlgorithm());
        return "index";
    }

    /**
     * Settles an advice.
     *
     * Returns 201 on acceptance. A malformed request is rejected with 400 —
     * both are part of the acquirer contract and neither may change.
     */
    @PostMapping("/settlements")
    @ResponseBody
    public ResponseEntity<SettlementResponse> settle(@Valid @RequestBody SettlementRequest request)
            throws Exception {
        SettlementResponse response = settlements.settle(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /** Liveness, used by the platform health check. */
    @GetMapping("/healthz")
    @ResponseBody
    public ResponseEntity<String> healthz() {
        return ResponseEntity.ok("ok");
    }
}
