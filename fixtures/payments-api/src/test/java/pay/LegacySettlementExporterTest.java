package pay;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import pay.legacy.LegacySettlementExporter;

/**
 * The nightly export still runs for batch reconciliation.
 */
@SpringBootTest
@SuppressWarnings("deprecation")
class LegacySettlementExporterTest {

    @Autowired LegacySettlementExporter exporter;

    @Test
    void buildsAnExportEnvelope() throws Exception {
        String export = exporter.buildExport(List.of("s1", "s2", "s3"));
        assertTrue(export.startsWith("NWPEXPORT/1"));
        assertTrue(export.contains("key="));
        assertTrue(export.contains("checksum="));
        assertTrue(export.contains("count=3"));
    }

    @Test
    void estimatesPayloadSize() {
        assertTrue(exporter.estimateSize(List.of("s1", "s2")) > 0);
    }
}
