import type {
  CryptoAssertion, CryptoUsage, Finding, MigrationPolicy, VerificationCheckResult,
  VerificationResult,
} from '@proteus/schema';
import type { Candidate } from '../../core/discovery/detect';

/**
 * Cryptographic verification (`EXEC-VER-006`, `-007`, `-008`).
 *
 * The scoping is the whole rule, and getting it wrong fails the *correct*
 * migration. A naive "no RSA anywhere in the tree" check would fail the
 * reference scenario, which deliberately leaves two RSA signature usages
 * untouched — `PROHIB-001` excludes signatures — and an RSA-signed leaf
 * certificate in place, because PKI was never in the approved scope.
 *
 * So absence is asserted only for the algorithm-and-usage pairs the approved
 * plan items actually cover. Everything else that is still classical is
 * reported through `cryptoAssertions` as `NOTED`, which is why that list carries
 * a third state the nine gating checks do not.
 */

/** The algorithm-and-usage pairs the approved plan promised to remove. */
export interface MigrationScope {
  pairs: Array<{ algorithm: string; usage: CryptoUsage }>;
  /** Exact locations the approved findings named, for a precise verdict. */
  locations: Set<string>;
  target?: string;
}

const key = (path: string, line: number): string => `${path}:${line}`;

/**
 * What the approval actually covers.
 *
 * Taken from the findings the approved plan items cite, not from the policy
 * alone: the policy says RSA key transport migrates to ML-KEM-768 in general,
 * while the approval covers the specific occurrences a human reviewed.
 */
export function scopeOf(
  approvedFindings: Finding[],
  target?: string,
): MigrationScope {
  const pairs: MigrationScope['pairs'] = [];
  const locations = new Set<string>();

  for (const finding of approvedFindings) {
    if (!finding.crypto?.algorithm) continue;
    pairs.push({ algorithm: finding.crypto.algorithm, usage: finding.crypto.usage });
    for (const loc of finding.locations) {
      if (loc.path && loc.startLine) locations.add(key(loc.path, loc.startLine));
    }
  }

  return { pairs, locations, ...(target ? { target } : {}) };
}

/** Whether a residual detection is one the approval promised to remove. */
export function inScope(candidate: Candidate, scope: MigrationScope): boolean {
  // A usage the plan never covered is out of scope whatever its algorithm —
  // this is the clause that keeps the untouched signature usages passing.
  return scope.pairs.some(
    (p) => p.usage === candidate.usage
      && sameFamily(p.algorithm, candidate.algorithm ?? ''),
  );
}

/** `RSA/ECB/OAEP…`, `RSA-2048` and `RSA` are one family; `SHA256withRSA` is not. */
export function sameFamily(a: string, b: string): boolean {
  const root = (s: string): string => {
    const withArg = /^[A-Za-z0-9-]+with([A-Za-z0-9]+?)(Encryption)?$/i.exec(s);
    if (withArg) return `sig:${withArg[1]!.toUpperCase()}`;
    return (s.split('/')[0] ?? s).replace(/[-_]?\d+$/, '').toUpperCase();
  };
  return root(a) === root(b) && root(a).length > 0;
}

export interface CryptoVerification {
  prohibitedAbsent: VerificationCheckResult;
  pqcPresent: VerificationCheckResult;
  policySatisfied: VerificationCheckResult;
  assertions: CryptoAssertion[];
  residual: VerificationResult['residualLegacyCrypto'];
  detected: VerificationResult['detectedPqc'];
}

export interface CryptoEvidence {
  /** What the detector finds in the migrated tree — the same detector discovery used. */
  candidates: Candidate[];
  scope: MigrationScope;
  policy: MigrationPolicy;
  /** The execution that established the runtime facts below. */
  executionRunId?: string;
  /** `EXEC-VER-006` — established by running, never by reading. */
  roundTrip: {
    executed: boolean;
    sharedSecretsMatch: boolean;
    /** False only if nothing in the test tree stubs the primitive. */
    mockedPrimitive: boolean;
    parameterSetResolved?: string;
    detail: string;
  };
  /** `EXEC-VER-007` — which provider version actually resolved. */
  provider?: { name: string; version: string; advertisesParameterSet: boolean };
}

/**
 * Runs the three cryptographic checks over the migrated tree.
 *
 * `PROHIBITED_CRYPTO_ABSENT` and `REQUIRED_PQC_PRESENT` are deliberately
 * separate. A migration that removes the old call without adding the new one
 * passes an absence check and is still broken; one that adds the new call
 * beside the old one passes a presence check and has migrated nothing.
 */
export function verifyCrypto(evidence: CryptoEvidence): CryptoVerification {
  const { candidates, scope, policy } = evidence;

  const classical = candidates.filter((c) => c.quantumVulnerable);
  const violations = classical.filter((c) => inScope(c, scope));
  const residualOutOfScope = classical.filter((c) => !inScope(c, scope));

  const assertions: CryptoAssertion[] = [];

  // ---- PROHIBITED_CRYPTO_ABSENT (EXEC-VER-008) -------------------------
  const prohibitedAbsent: VerificationCheckResult = {
    check: 'PROHIBITED_CRYPTO_ABSENT',
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    detail: violations.length === 0
      ? `No ${scope.pairs.map((p) => `${p.algorithm} ${label(p.usage)}`).join(', ') || 'in-scope classical'} `
        + 'usage remains. Scoped to the approved plan items; residual classical '
        + `cryptography outside that scope is recorded as noted (${residualOutOfScope.length} item(s)).`
      : `${violations.length} in-scope classical usage(s) remain: `
        + violations.map((v) => `${v.algorithm ?? '?'} at ${v.path}:${v.line}`).join(', '),
    ...(evidence.executionRunId ? { executionRunId: evidence.executionRunId } : {}),
    evidenceIds: [],
    findings: violations.map((v) => ({
      path: v.path, line: v.line, match: v.matchedText.slice(0, 200),
    })),
  };

  if (violations.length === 0) {
    assertions.push({
      label: `${scope.pairs[0]?.algorithm ?? 'Classical'} `
        + `${label(scope.pairs[0]?.usage ?? 'KEY_TRANSPORT')} removed`,
      status: 'PASS',
      evidence: prohibitedAbsent.detail,
      evidenceIds: [],
    });
  }

  // Everything still classical that the approval never covered. Reported, not
  // failed — and each one says why it is acceptable, so a reader does not have
  // to reconstruct the reasoning.
  for (const r of residualOutOfScope) {
    assertions.push({
      label: `${r.algorithm ?? 'Classical'} ${label(r.usage)} at ${basename(r.path)}:${r.line}`,
      status: 'NOTED',
      evidence: acceptanceReason(r),
      evidenceIds: [],
    });
  }

  // ---- REQUIRED_PQC_PRESENT (EXEC-VER-006) -----------------------------
  const { roundTrip } = evidence;
  const pqcOk = roundTrip.executed && roundTrip.sharedSecretsMatch && !roundTrip.mockedPrimitive
    && (!scope.target || roundTrip.parameterSetResolved === scope.target);

  const pqcPresent: VerificationCheckResult = {
    check: 'REQUIRED_PQC_PRESENT',
    status: pqcOk ? 'PASS' : 'FAIL',
    detail: pqcOk
      ? `${roundTrip.parameterSetResolved ?? scope.target ?? 'KEM'} round trip executed against `
        + `the resolved provider; shared secrets match; no test stubs the primitive. `
        + roundTrip.detail
      : [
          !roundTrip.executed && 'no round trip executed',
          roundTrip.executed && !roundTrip.sharedSecretsMatch && 'shared secrets did not match',
          // The one that matters most: without it the whole verification chain
          // is satisfiable by a stub returning a constant.
          roundTrip.mockedPrimitive && 'the primitive is mocked, so nothing was proved',
          scope.target && roundTrip.parameterSetResolved !== scope.target
            && `provider resolved ${roundTrip.parameterSetResolved ?? 'nothing'}, `
              + `not the approved ${scope.target}`,
        ].filter(Boolean).join('; ') + `. ${roundTrip.detail}`,
    ...(evidence.executionRunId ? { executionRunId: evidence.executionRunId } : {}),
    evidenceIds: [],
    findings: [],
  };

  assertions.push({
    label: `${scope.target ?? 'ML-KEM'} encapsulation present and exercised`,
    status: pqcOk ? 'PASS' : 'FAIL',
    evidence: pqcPresent.detail,
    evidenceIds: [],
  });

  // ---- MIGRATION_POLICY_SATISFIED (EXEC-VER-007) -----------------------
  const applicable = policy.rules.filter((r) =>
    scope.pairs.some((p) => new RegExp(r.when.algorithmPattern, 'i').test(p.algorithm)
      && r.when.usage === p.usage));

  const providerOk = !evidence.provider || evidence.provider.advertisesParameterSet;
  const policySatisfied: VerificationCheckResult = {
    check: 'MIGRATION_POLICY_SATISFIED',
    status: violations.length === 0 && pqcOk && providerOk ? 'PASS' : 'FAIL',
    detail: [
      `${applicable.length} policy rule(s) apply to the approved scope`,
      evidence.provider
        ? `provider ${evidence.provider.name} ${evidence.provider.version} `
          + `${evidence.provider.advertisesParameterSet ? 'advertises' : 'does not advertise'} `
          + `${scope.target ?? 'the approved parameter set'}`
        : 'provider version not recorded',
      applicable.map((r) => r.ruleId).join(', '),
    ].filter(Boolean).join(' · '),
    ...(evidence.executionRunId ? { executionRunId: evidence.executionRunId } : {}),
    evidenceIds: [],
    findings: [],
  };

  return {
    prohibitedAbsent,
    pqcPresent,
    policySatisfied,
    assertions,
    residual: residualOutOfScope.map((r) => ({
      algorithm: r.algorithm ?? 'unknown',
      usage: r.usage,
      path: r.path,
      line: r.line,
      // Accepted because the approval never covered it, and the reason says so
      // rather than leaving the reader to infer it.
      accepted: true,
      acceptanceReason: acceptanceReason(r),
    })),
    detected: candidates
      .filter((c) => !c.quantumVulnerable && /ML-KEM|ML-DSA|SLH-DSA|Kyber|Dilithium/i.test(
        `${c.algorithm ?? ''} ${c.matchedText}`,
      ))
      .map((c) => ({
        algorithm: c.algorithm ?? 'ML-KEM',
        usage: c.usage,
        path: c.path,
        line: c.line,
      })),
  };
}

/** Why a residual classical usage is acceptable. Stated, never implied. */
function acceptanceReason(c: Candidate): string {
  if (/^[A-Za-z0-9-]+with/i.test(c.algorithm ?? '') || c.usage === 'DIGITAL_SIGNATURE') {
    return 'Signature usage. PROHIB-001 excludes signatures from this migration — they '
      + 'have their own timeline and were never in the approved scope.';
  }
  if (c.usage === 'CERTIFICATE_VALIDATION') {
    return 'Certificate and PKI. Out of the approved scope; raised as a follow-on '
      + 'workstream with an owner rather than migrated here.';
  }
  if (c.usage === 'UNKNOWN') {
    return 'Usage could not be determined, so it was never brought into the approved '
      + 'scope. Recorded for investigation rather than changed.';
  }
  return `${label(c.usage)} outside the approved plan items. Reported, not changed.`;
}

const label = (usage: string): string => usage.replace(/_/g, ' ').toLowerCase();
const basename = (path: string): string => path.split('/').pop() ?? path;
