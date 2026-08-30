import type { BehavioralInvariant, ChangeType, TestIntegrityRecord } from '@proteus/schema';

/**
 * The anti-test-cheating guardrails (spec §25, §26; `EXEC-TEST-*`, `EXEC-MOCK-*`).
 *
 * Every one of these is a way an agent can produce a green suite without having
 * migrated anything, and each is refused deterministically rather than
 * discouraged in a prompt. The model proposes a test; this decides whether it
 * may be written. Nothing here consults the model, which is the point — a
 * guardrail the subject can argue with is not a guardrail.
 *
 * The four failures being prevented:
 *
 *   MOCKED PRIMITIVE   stub Encaps/Decaps to return a constant and every PQC
 *                      assertion passes with no cryptography executed.
 *   WRONG ORACLE       assert a tampered ciphertext throws. FIPS 203 says it
 *                      does not — so the test fails CORRECT code, and the agent
 *                      then "repairs" a working implementation to satisfy it.
 *   VACUOUS TEST       a new PQC test that already passes before the migration
 *                      is asserting nothing about the migration.
 *   WEAKENED CONTRACT  quietly editing the assertion that encodes a baseline
 *                      invariant, rather than reporting that it changed.
 */

export type GuardRuleId =
  | 'EXEC-MOCK-004' | 'EXEC-MOCK-001' | 'EXEC-TEST-001'
  | 'EXEC-TEST-002' | 'EXEC-TEST-004' | 'EXEC-TEST-007' | 'EXEC-TEST-008';

export interface GuardRefusal {
  ruleId: GuardRuleId;
  classification: 'PROHIBITED_TEST_CONSTRUCTION' | 'REQUIRES_GATE' | 'INCOMPLETE_RECORD'
    | 'VACUOUS_TEST';
  reason: string;
  /** Set when the correct response is to ask a human rather than to refuse. */
  gateType?: 'BASELINE_CONTRACT_CHANGE';
}

export type GuardVerdict =
  | { allowed: true; ruleIds: GuardRuleId[] }
  | { allowed: false; refusals: GuardRefusal[] };

/** A test or mock the agent proposes to write, before anything is written. */
export interface ProposedTestArtifact {
  path: string;
  changeType: ChangeType;
  /** `MIGRATION_ACCEPTANCE_TEST` must fail at base; `CHARACTERIZATION` must pass. */
  testKind: 'CHARACTERIZATION' | 'MIGRATION_ACCEPTANCE_TEST' | 'MOCK' | 'FIXTURE';
  content: string;
  /** What the agent says this stands in for. Only meaningful for mocks. */
  mockTarget?: string;
  testIntegrity?: TestIntegrityRecord;
}

// ---------------------------------------------------------------------------
// EXEC-MOCK-004 — never mock the primitive under migration
// ---------------------------------------------------------------------------

/**
 * The prohibited mock targets, as declared and as written.
 *
 * Both halves are needed. An agent naming its target `KEM_ENCAPSULATION` is
 * caught by the first; an agent naming it `partnerSimulator` and then stubbing
 * `encapsulate()` in the body is caught by the second. Neither alone is enough,
 * and the second is the one that matters, because the declaration is the part
 * the model controls.
 */
const PROHIBITED_MOCK_TARGETS = [
  'KEM_ENCAPSULATION', 'KEM_DECAPSULATION', 'SHARED_SECRET_COMPARISON',
  'ALGORITHM_SELECTION', 'CRYPTO_PROVIDER',
] as const;

/**
 * Stubbing the primitive, as it appears in Java test code.
 *
 * Matches a mocking framework being pointed at encapsulation, decapsulation,
 * the KEM itself, or the provider — not mere mentions of those words, which
 * appear legitimately in a test that exercises the real thing.
 *
 * Exported because `EXEC-VER-006`'s `mockedPrimitive: false` is the same
 * question asked at the other end of the run: the guard refuses a stub before
 * it is written, and verification confirms none reached the tree. Two copies of
 * this would drift, and PRD-12 already paid for that lesson once.
 */
export const PRIMITIVE_STUB_PATTERNS: Array<{ re: RegExp; what: string }> = [
  // Both Mockito shapes: `when(mock.encaps(..))` and `doReturn(x).when(mock).encaps(..)`.
  // The gap crosses `)` deliberately — the second form puts a closing paren
  // between the stubbing verb and the method, and matching only the first form
  // would leave the more common one open.
  { re: /\b(when|given|doReturn|thenReturn|mock|spy|stub)\s*\(?[^\n]{0,80}\b(encaps|encapsulate)\b/i,
    what: 'KEM encapsulation' },
  { re: /\b(when|given|doReturn|thenReturn|mock|spy|stub)\s*\(?[^\n]{0,80}\b(decaps|decapsulate)\b/i,
    what: 'KEM decapsulation' },
  { re: /\b(mock|spy)\s*\(\s*(KEM|KeyEncapsulation|MLKEM|MlKem|ML_KEM)[A-Za-z]*\.class/i,
    what: 'the KEM implementation' },
  { re: /\b(mock|spy)\s*\(\s*(Provider|KeyPairGenerator|KeyGenerator|Cipher)\.class/i,
    what: 'the cryptographic provider' },
  { re: /\b(when|given|doReturn|thenReturn)\s*\(?[^\n]{0,80}\b(sharedSecret|getSharedSecret)\b/i,
    what: 'the shared-secret comparison' },
];

// ---------------------------------------------------------------------------
// EXEC-TEST-004 / FIPS203-3.2-002 — implicit rejection
// ---------------------------------------------------------------------------

/**
 * A test asserting that a tampered ciphertext throws.
 *
 * FIPS 203 §7.3 rejects a ciphertext of the wrong LENGTH at the input check.
 * A tampered ciphertext of the RIGHT length is *implicitly* rejected: Decaps
 * returns a pseudorandom secret and raises nothing. So this assertion fails a
 * correct implementation — and the agent's next move would be to change the
 * implementation until it passed.
 *
 * The narrowing clause matters: the same `assertThrows` is correct for a
 * wrong-length input, so the pattern only fires where the test says the input
 * was tampered, corrupted or flipped rather than malformed.
 */
const TAMPER_THROWS = [
  /assert(Throws|Fails)[^;]{0,200}\b(tamper|corrupt|flip|mutat|modif)/is,
  /\b(tamper|corrupt|flip|mutat)[a-z]*\b[^;]{0,200}assert(Throws|Fails)/is,
  /expect\s*\(\s*[^)]{0,80}\b(tamper|corrupt|flip)[a-z]*[^)]{0,80}\)\s*\.\s*(toThrow|rejects)/is,
];

/** A wrong-LENGTH input genuinely is rejected, so the same shape is correct here. */
const LENGTH_QUALIFIED = /\b(wrong|invalid|bad|short|long|truncat|malformed)[a-z]*\s*(length|size|format)/i;

export function guardTestArtifact(
  artifact: ProposedTestArtifact,
  context: {
    invariants?: BehavioralInvariant[];
    /** Paths the approved plan will change. A characterization test must not pin them. */
    approvedPaths?: string[];
  } = {},
): GuardVerdict {
  const refusals: GuardRefusal[] = [];
  const applied: GuardRuleId[] = [];

  /*
   * EXEC-TEST-008 — a characterization test may not pin what the plan changes.
   *
   * The agent wrote `PomDependencyCharacterizationTest`, asserting
   * `bcprov-jdk18on` was at its pre-migration version. It passed against the
   * base commit, which is what a characterization test is asked to do, and then
   * failed the moment the approved dependency upgrade landed — a tripwire the
   * agent set for itself, diagnosed as TEST_FIXTURE_OUTDATED and repaired out of
   * its own budget.
   *
   * A characterization test captures what the migration must PRESERVE. Asserting
   * the current state of a file the plan is about to rewrite is the opposite of
   * that, and it is checkable: the approved paths are known before any test is
   * written.
   */
  if (artifact.testKind === 'CHARACTERIZATION' && context.approvedPaths?.length) {
    applied.push('EXEC-TEST-008');
    const pinned = context.approvedPaths.filter((path) => {
      const name = path.split('/').pop();
      // Only a literal reference counts. A test that happens to exercise a
      // migrated class is expected; one that reads the file being rewritten is
      // pinning the change itself.
      return Boolean(name) && artifact.content.includes(name!);
    });

    if (pinned.length > 0) {
      refusals.push({
        ruleId: 'EXEC-TEST-008',
        classification: 'PROHIBITED_TEST_CONSTRUCTION',
        reason: `a characterization test must survive the migration, and this one reads `
          + `${pinned.join(', ')} — a file the approved plan changes. Characterize what the `
          + 'migration must keep true, not the state it is about to leave.',
      });
    }
  }

  // EXEC-MOCK-004 — the subject of the test may never be faked.
  applied.push('EXEC-MOCK-004');
  if (artifact.mockTarget
      && (PROHIBITED_MOCK_TARGETS as readonly string[]).includes(artifact.mockTarget)) {
    refusals.push({
      ruleId: 'EXEC-MOCK-004',
      classification: 'PROHIBITED_TEST_CONSTRUCTION',
      reason: `${artifact.mockTarget} is the primitive under migration. Mocking the peer is `
        + 'permitted; mocking the primitive produces evidence of nothing.',
    });
  }
  for (const { re, what } of PRIMITIVE_STUB_PATTERNS) {
    if (re.test(artifact.content)) {
      refusals.push({
        ruleId: 'EXEC-MOCK-004',
        classification: 'PROHIBITED_TEST_CONSTRUCTION',
        reason: `${artifact.path} stubs ${what}. The primitive being migrated is the one thing `
          + 'that must be exercised for real, including in integration tests.',
      });
      break;
    }
  }

  // EXEC-TEST-004 — assert implicit rejection, never an exception.
  if (artifact.testKind !== 'MOCK') {
    applied.push('EXEC-TEST-004');
    const tampers = TAMPER_THROWS.some((re) => re.test(artifact.content));
    if (tampers && !LENGTH_QUALIFIED.test(artifact.content)) {
      refusals.push({
        ruleId: 'EXEC-TEST-004',
        classification: 'PROHIBITED_TEST_CONSTRUCTION',
        reason: `${artifact.path} asserts that a tampered ciphertext throws. FIPS 203 §7.3 `
          + 'rejects a wrong-length input, but a tampered ciphertext of the correct length is '
          + 'implicitly rejected — Decaps returns a different shared secret and raises nothing. '
          + 'Assert DIFFERENT_SHARED_SECRET instead; this test would fail a correct '
          + 'implementation and invite a repair to working code.',
      });
    }
  }

  // EXEC-MOCK-001 / FR-12 — the record comes before the edit.
  if (artifact.changeType === 'TEST' || artifact.changeType === 'MOCK'
      || artifact.changeType === 'FIXTURE') {
    applied.push('EXEC-MOCK-001');
    const integrity = artifact.testIntegrity;
    if (!integrity) {
      refusals.push({
        ruleId: 'EXEC-MOCK-001',
        classification: 'INCOMPLETE_RECORD',
        reason: `a ${artifact.changeType} change requires a testIntegrity record: why it failed, `
          + 'whether a baseline requirement changed, and whether the edit is safe.',
      });
    } else if (integrity.baselineRequirementChanged && !integrity.gateId) {
      refusals.push({
        ruleId: 'EXEC-MOCK-001',
        classification: 'REQUIRES_GATE',
        reason: 'the record states a baseline behavioural requirement changed, which is a '
          + 'human decision, not an autonomous edit.',
        gateType: 'BASELINE_CONTRACT_CHANGE',
      });
    }
  }

  // EXEC-TEST-007 — a MUST_PRESERVE assertion is not the agent's to soften.
  const touched = touchedInvariants(artifact, context.invariants ?? []);
  if (touched.length > 0) {
    applied.push('EXEC-TEST-007');
    if (!artifact.testIntegrity?.gateId) {
      refusals.push({
        ruleId: 'EXEC-TEST-007',
        classification: 'REQUIRES_GATE',
        reason: `${artifact.path} changes an assertion encoding `
          + `${touched.map((i) => i.description).join('; ')} — a MUST_PRESERVE baseline `
          + 'invariant. Spec §25 forbids weakening a legitimate behavioural requirement to '
          + 'achieve a passing result.',
        gateType: 'BASELINE_CONTRACT_CHANGE',
      });
    }
  }

  return refusals.length > 0
    ? { allowed: false, refusals }
    : { allowed: true, ruleIds: [...new Set(applied)] };
}

/**
 * Which MUST_PRESERVE invariants this artifact's content touches.
 *
 * Matched on the invariant's own executable assertion appearing in the file.
 * `EXPECTED_TO_CHANGE` invariants are deliberately excluded — the whole reason
 * the disposition exists is that changing those assertions is the migration
 * working, and gating on them would block a correct run (decision D-003).
 */
export function touchedInvariants(
  artifact: ProposedTestArtifact,
  invariants: BehavioralInvariant[],
): BehavioralInvariant[] {
  const normalised = artifact.content.replace(/\s+/g, '');
  return invariants.filter(
    (i) => i.disposition === 'MUST_PRESERVE'
      && i.assertion.length > 8
      && normalised.includes(i.assertion.replace(/\s+/g, '')),
  );
}

// ---------------------------------------------------------------------------
// EXEC-TEST-002 — a generated acceptance test must fail before the migration
// ---------------------------------------------------------------------------

export interface BaseValidation {
  testId: string;
  testKind: ProposedTestArtifact['testKind'];
  passedAtBase: boolean;
}

export interface ValidationVerdict {
  /** Tests that behaved as their kind requires and may be kept. */
  accepted: string[];
  /** Acceptance tests that already passed — vacuous, and a finding (FR-8). */
  vacuous: string[];
  /** Characterization tests that failed at base — a bug found, not a baseline. */
  brokenAtBase: string[];
}

/**
 * Checks generated tests against the unmigrated build.
 *
 * The cheapest available detector of a vacuous test, and it runs before a single
 * line of implementation changes. The two kinds have opposite expectations and
 * that is the whole content of the check: an acceptance test that passes before
 * the migration asserts nothing about it, and a characterization test that fails
 * before the migration has documented a bug rather than pinned a baseline.
 */
export function validateAgainstBase(results: BaseValidation[]): ValidationVerdict {
  const verdict: ValidationVerdict = { accepted: [], vacuous: [], brokenAtBase: [] };

  for (const r of results) {
    if (r.testKind === 'MIGRATION_ACCEPTANCE_TEST') {
      (r.passedAtBase ? verdict.vacuous : verdict.accepted).push(r.testId);
    } else if (r.testKind === 'CHARACTERIZATION') {
      (r.passedAtBase ? verdict.accepted : verdict.brokenAtBase).push(r.testId);
    } else {
      verdict.accepted.push(r.testId);
    }
  }
  return verdict;
}
