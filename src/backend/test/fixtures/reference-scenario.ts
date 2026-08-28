/**
 * The reference scenario, as UX design canvas v1.1 renders it.
 *
 * These are the FACTS a detection pass would produce for northwind-pay/payments-api,
 * and the expectations are what Screen 3 actually shows. If the rulesets stop
 * reproducing this, either the rules regressed or the product changed — either way
 * someone has to look.
 */
import type { Facts } from '../../src/core/rules/predicates';

export interface ScenarioCase {
  id: string;
  label: string;
  facts: Facts;
  expect: {
    quantumVulnerable?: boolean;
    disposition: string;
    dispositionRuleId: string;
    target?: string;
    parameterSet?: string;
    recommendation?: { disposition: string; subtype?: string };
  };
}

export const REFERENCE_FINDINGS: ScenarioCase[] = [
  {
    id: 'f1',
    label: 'RSA-2048 used for key establishment (CryptoService)',
    facts: {
      algorithm: 'RSA-2048', keySize: 2048, usage: 'KEY_TRANSPORT',
      usageStrength: 'STRONG', quantumVulnerable: true,
      location: 'SOURCE', fileKind: 'SOURCE', language: 'Java',
      approvedTargetExists: true,
    },
    expect: {
      quantumVulnerable: true,
      disposition: 'AUTONOMOUS_MIGRATION', dispositionRuleId: 'EXEC-DISP-009',
      target: 'ML-KEM', parameterSet: 'ML-KEM-768',
    },
  },
  {
    id: 'f2',
    label: 'Crypto library predates the ML-KEM provider (bouncycastle 1.72)',
    facts: {
      algorithm: 'RSA-2048', usage: 'KEY_TRANSPORT', usageStrength: 'STRONG',
      quantumVulnerable: true, location: 'MANIFEST', fileKind: 'MANIFEST',
      buildSystem: 'Maven', dependencyName: 'bcprov-jdk18on',
      dependencyVersion: '1.72', approvedTargetExists: true,
    },
    expect: { disposition: 'AUTONOMOUS_MIGRATION', dispositionRuleId: 'EXEC-DISP-009' },
  },
  {
    id: 'f3',
    label: 'Partner handshake mock encodes the obsolete RSA protocol',
    facts: {
      algorithm: 'RSA-2048', usage: 'KEY_TRANSPORT', quantumVulnerable: true,
      nodeType: 'TEST_MOCK', fileKind: 'TEST', language: 'Java',
    },
    expect: { disposition: 'ASSISTED_MIGRATION', dispositionRuleId: 'EXEC-DISP-007' },
  },
  {
    id: 'f4',
    label: 'Settlement signing keys held in the HSM (signature usage)',
    facts: {
      algorithm: 'RSA-4096', usage: 'DIGITAL_SIGNATURE', quantumVulnerable: true,
      nodeType: 'HSM', keyStorageLocation: 'HSM',
    },
    expect: {
      // Signature usage is excluded from a KEM migration before hardware rules apply.
      disposition: 'NO_CHANGE_REQUIRED', dispositionRuleId: 'EXEC-DISP-002',
    },
  },
  {
    id: 'f4b',
    label: 'HSM PQC capability not established from the supplied specification',
    facts: {
      nodeType: 'HSM', quantumVulnerable: true,
      documentDeclares: ['RSA-2048', 'RSA-3072', 'RSA-4096', 'ECDSA-P256', 'ECDSA-P384'],
    },
    expect: {
      disposition: 'HUMAN_DECISION_REQUIRED', dispositionRuleId: 'EXEC-DISP-004',
      recommendation: { disposition: 'HUMAN_DECISION', subtype: 'CAPABILITY_NOT_DECLARED' },
    },
  },
  {
    id: 'f5',
    label: 'Industrial gateway supports RSA certificates only (firmware-fixed)',
    facts: {
      nodeType: 'OT_DEVICE', vendor: 'Gateway-X200', firmwareVersion: '4.2.1',
      algorithmSetFixedInFirmware: true, quantumVulnerable: true,
    },
    expect: {
      disposition: 'HARDWARE_REPLACEMENT', dispositionRuleId: 'EXEC-DISP-003',
      recommendation: {
        disposition: 'HARDWARE_REPLACEMENT', subtype: 'FIRMWARE_FIXED_ALGORITHM_SET',
      },
    },
  },
  {
    id: 'f6',
    label: 'Acquirer PSP hybrid support unconfirmed',
    facts: {
      nodeType: 'EXTERNAL_SERVICE', peerCapabilityConfirmed: false,
      quantumVulnerable: true, usage: 'KEY_ESTABLISHMENT',
    },
    expect: { disposition: 'NEEDS_FURTHER_INVESTIGATION', dispositionRuleId: 'EXEC-DISP-006' },
  },
  {
    id: 'tls',
    label: 'TLS 1.3 already hybrid-ready — protocol-managed',
    facts: {
      nodeType: 'PROTOCOL', protocolManaged: true,
      quantumVulnerable: true, usage: 'KEY_ESTABLISHMENT',
    },
    expect: { disposition: 'NEEDS_FURTHER_INVESTIGATION', dispositionRuleId: 'EXEC-DISP-006' },
  },
  {
    id: 'db',
    label: 'Ledger data at rest uses AES-256-GCM',
    facts: {
      algorithm: 'AES-256-GCM', usage: 'SYMMETRIC_ENCRYPTION',
      quantumVulnerable: false, nodeType: 'DATABASE',
    },
    expect: {
      quantumVulnerable: false,
      disposition: 'NO_CHANGE_REQUIRED', dispositionRuleId: 'EXEC-DISP-001',
    },
  },
  {
    id: 'cert',
    label: 'pay-api leaf certificate is RSA-signed — PKI out of scope',
    facts: {
      nodeType: 'CERTIFICATE', usage: 'CERTIFICATE_VALIDATION',
      signatureAlgorithm: 'SHA256withRSA', keyLength: 2048, quantumVulnerable: true,
    },
    expect: { disposition: 'NO_CHANGE_REQUIRED', dispositionRuleId: 'EXEC-DISP-002' },
  },
];

/** Failures the migration loop must classify without asking a model. */
export const REFERENCE_FAILURES = [
  {
    label: 'partner mock asserts the legacy RSA handshake',
    facts: {
      phase: 'INTEGRATION_TEST', failingAssertionReferences: 'LEGACY_ALGORITHM',
      referencingFiles: ['TEST', 'MOCK'], failingAssertionIsBaselineInvariant: false,
    },
    expect: {
      classification: 'MOCK_INCOMPATIBILITY', ruleId: 'EXEC-DIAG-004',
      permitAutonomousRepair: true, countsTowardRetryBudget: true,
    },
  },
  {
    label: 'a baseline invariant fails — never a test defect, though it looks like one',
    facts: {
      phase: 'INTEGRATION_TEST', failingAssertionIsBaselineInvariant: true,
      failingAssertionReferences: 'LEGACY_ALGORITHM', referencingFiles: ['TEST', 'MOCK'],
    },
    expect: {
      classification: 'EXPECTED_BEHAVIOR_CHANGE', ruleId: 'EXEC-DIAG-005',
      permitAutonomousRepair: false, countsTowardRetryBudget: true,
    },
  },
  {
    label: 'provider lacks the ML-KEM algorithm',
    facts: { phase: 'BUILD', error: 'NoSuchAlgorithmException: ML-KEM-768' },
    expect: {
      classification: 'DEPENDENCY_INCOMPATIBILITY', ruleId: 'EXEC-DIAG-003',
      permitAutonomousRepair: true, countsTowardRetryBudget: true,
    },
  },
  {
    label: 'Cloud Build flake must not consume the retry budget',
    facts: { phase: 'BUILD', error: 'connection refused while fetching dependencies' },
    expect: {
      classification: 'ENVIRONMENT_FAILURE', ruleId: 'EXEC-DIAG-007',
      permitAutonomousRepair: true, countsTowardRetryBudget: false,
    },
  },
  {
    label: 'failure originating at the partner endpoint is not the agent to fix',
    facts: { phase: 'E2E', failureOriginates: 'EXTERNAL_SERVICE' },
    expect: {
      classification: 'EXTERNAL_DEPENDENCY_BLOCKER', ruleId: 'EXEC-DIAG-012',
      permitAutonomousRepair: false, countsTowardRetryBudget: false,
    },
  },
];
