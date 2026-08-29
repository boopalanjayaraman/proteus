package pay.legacy;

import java.nio.charset.StandardCharsets;
import java.util.List;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.springframework.stereotype.Component;
import pay.security.PartnerKeyProvider;
import pay.util.CryptoUtils;

/**
 * Nightly settlement export for the acquirer's batch reconciliation.
 *
 * Predates the API integration. Still runs — reconciliation has not been
 * migrated to the API yet, so this cannot be removed.
 */
@Deprecated
@Component
public class LegacySettlementExporter {

    private static final String EXPORT_CIPHER = "AES";

    private final PartnerKeyProvider partnerKeys;

    public LegacySettlementExporter(PartnerKeyProvider partnerKeys) {
        this.partnerKeys = partnerKeys;
    }

    /**
     * Builds the encrypted export envelope.
     *
     * The file key is wrapped for the acquirer so they can open the batch.
     */
    public String buildExport(List<String> settlementIds) throws Exception {
        KeyGenerator kg = KeyGenerator.getInstance(EXPORT_CIPHER);
        kg.init(256);
        SecretKey fileKey = kg.generateKey();

        byte[] wrappedFileKey = CryptoUtils.wrapKey(fileKey, partnerKeys.acquirerPublicKey());

        String body = String.join("\n", settlementIds);
        String checksum = CryptoUtils.sha256Hex(body);

        return String.join("\n",
                "NWPEXPORT/1",
                "key=" + CryptoUtils.b64(wrappedFileKey),
                "checksum=" + checksum,
                "count=" + settlementIds.size(),
                body);
    }

    public int estimateSize(List<String> ids) {
        return String.join("\n", ids).getBytes(StandardCharsets.UTF_8).length;
    }
}
