import type { BehavioralInvariant } from '@proteus/schema';

/**
 * Invariant classification (`EXEC-INV-003`, `EXEC-INV-004`).
 *
 * Risk 1 of this increment: classification is a model judgment with a
 * wrong-by-default failure mode in both directions. Capture everything as
 * MUST_PRESERVE and the correct migration is blocked by its own contract —
 * RSA-2048 wraps to 256 bytes and ML-KEM-768 to 1088, so an invariant pinning
 * ciphertext length would fail a working migration. Capture too little and a
 * regression walks through: a migration that turns a rejection into an
 * acceptance passes every happy-path test.
 *
 * So the rule sets the default per kind and the model may only override it with
 * a reason, which is recorded. The default is where the judgment lives; the
 * override is where the exception is justified.
 */

export type InvariantKind = BehavioralInvariant['kind'];
export type Disposition = BehavioralInvariant['disposition'];

/** `EXEC-INV-003`, as a table. */
export const DEFAULT_DISPOSITION: Record<InvariantKind, Disposition> = {
  API_BEHAVIOR: 'MUST_PRESERVE',
  FAILURE_MODE: 'MUST_PRESERVE',
  FUNCTIONAL_OUTCOME: 'MUST_PRESERVE',
  CRYPTO_OUTCOME: 'MUST_PRESERVE',
  // The one that must default the other way. Only preserved where an external
  // party contractually depends on the format, at which point EXEC-ESC-002
  // applies and it is a gate rather than an invariant.
  MESSAGE_FORMAT: 'EXPECTED_TO_CHANGE',
};

/**
 * CRYPTO_OUTCOME facts the migration is *supposed* to change.
 *
 * `EXEC-INV-003` names these as exceptions to the MUST_PRESERVE default: key
 * establishment must still succeed, but the algorithm it names and the encoding
 * of the secret it produces are the migration doing its job.
 *
 * The gap between the noun and its measurement is deliberate. This first read
 * `wrapped\s*(key\s*)?(length|size|bytes)`, which matches "wrapped key length"
 * and misses "wrapped **session** key length" — the exact phrasing the fixture
 * uses. One unanticipated word, and the invariant stayed MUST_PRESERVE,
 * `EXEC-DIAG-005` outranked `EXEC-DIAG-004`, and the run ended at a human gate
 * that this constant exists specifically to prevent.
 *
 * So the qualifier is a short unbounded window rather than an enumerated word.
 * A description is prose written by a model; matching it on an exact word
 * sequence is a guess about phrasing dressed up as a rule.
 */
const CRYPTO_OUTCOME_EXCEPTIONS =
  /algorithm\s*(identifier|name|id)|negotiated|shared[-\s]?secret\s*encoding|key\s*(type|encoding)|(cipher(text)?|encapsulation|wrapped)[\w\s.-]{0,32}?(length|size|bytes|encoding)/i;

/** Only an externally contractualised format survives the MESSAGE_FORMAT default. */
const EXTERNALLY_CONTRACTUALISED = /\b(contract|contractual|partner agreement|published (api|schema)|external consumer|wire contract|interface specification)\b/i;

export interface ProposedInvariant {
  kind: InvariantKind;
  description: string;
  /** Executable, not prose — `EXEC-INV-004` rejects the alternative. */
  assertion: string;
  capturedFrom: BehavioralInvariant['capturedFrom'];
  /** The model's proposal. Honoured only with a reason, and only downward. */
  proposedDisposition?: Disposition;
  overrideReason?: string;
  evidenceIds?: string[];
}

export interface ClassifiedInvariant {
  invariant: BehavioralInvariant;
  /** Which rule decided it, for the report and the checklist. */
  ruleId: 'EXEC-INV-003';
  /** Set when the default was not used. */
  override?: { from: Disposition; reason: string };
}

export class InvariantRejected extends Error {
  constructor(readonly ruleId: 'EXEC-INV-004', message: string) {
    super(message);
    this.name = 'InvariantRejected';
  }
}

/**
 * An assertion that can be re-run, as opposed to a sentence about behaviour.
 *
 * `BASELINE_INVARIANTS_PRESERVED` is a deterministic check in PRD-13. An
 * invariant recorded only in English cannot be re-run against the migrated
 * build, so accepting one silently degrades that verification into a model
 * opinion — which is the failure this whole architecture exists to avoid.
 */
export function isExecutable(assertion: string): boolean {
  const a = assertion.trim();
  if (a.length < 8) return false;
  return /assert|expect|verify|\bshould\b\s*\(|==|!=|=>|\)\s*;|\breturns?\b\s*\d|status\s*\(?\s*\d{3}/i
    .test(a) && /[(){}=;.]/.test(a);
}

/**
 * Applies the rule to one proposed invariant.
 *
 * The model may move an invariant to EXPECTED_TO_CHANGE only with a reason, and
 * may move one to MUST_PRESERVE only where the format is externally
 * contractualised. Both directions are constrained because both are ways to get
 * the answer wrong, and neither is the model's to decide unilaterally.
 */
export function classify(
  proposed: ProposedInvariant,
  index: number,
  projectId: string,
): ClassifiedInvariant {
  if (!isExecutable(proposed.assertion)) {
    throw new InvariantRejected(
      'EXEC-INV-004',
      `"${proposed.description}" carries no executable assertion (got: `
      + `"${proposed.assertion.slice(0, 60)}"). An invariant that cannot be re-run against `
      + 'the migrated build is a sentence, not a contract.',
    );
  }

  const fallback = DEFAULT_DISPOSITION[proposed.kind];
  let disposition = fallback;
  let override: ClassifiedInvariant['override'];

  const wanted = proposed.proposedDisposition;
  if (wanted && wanted !== fallback) {
    const reason = proposed.overrideReason?.trim();
    if (reason) {
      const permitted = wanted === 'EXPECTED_TO_CHANGE'
        // Loosening a crypto outcome is permitted only for the facts the rule
        // already names as exceptions — the algorithm identifier and the
        // encoding, not "key establishment still succeeds".
        ? proposed.kind !== 'CRYPTO_OUTCOME'
          || CRYPTO_OUTCOME_EXCEPTIONS.test(`${proposed.description} ${proposed.assertion}`)
        // Tightening MESSAGE_FORMAT is permitted only where an external party
        // depends on the format.
        : proposed.kind !== 'MESSAGE_FORMAT'
          || EXTERNALLY_CONTRACTUALISED.test(`${proposed.description} ${reason}`);

      if (permitted) {
        disposition = wanted;
        override = { from: fallback, reason };
      }
    }
  }

  // A crypto outcome describing a size or an algorithm name is expected to
  // change whether or not the model noticed. This is the case the fixture turns
  // on: `assertEquals(256, wrapped.length)` is an observation the migration is
  // supposed to invalidate, and calling it a regression ends the run with a
  // human engineering action that should never have been needed.
  if (proposed.kind === 'CRYPTO_OUTCOME' && disposition === 'MUST_PRESERVE'
      && CRYPTO_OUTCOME_EXCEPTIONS.test(`${proposed.description} ${proposed.assertion}`)) {
    disposition = 'EXPECTED_TO_CHANGE';
    override = {
      from: 'MUST_PRESERVE',
      reason: 'EXEC-INV-003 exception: the negotiated algorithm identifier and the encoding '
        + 'of the wrapped key are what the migration changes.',
    };
  }

  return {
    invariant: {
      invariantId: `inv_${projectId}_${index + 1}`,
      kind: proposed.kind,
      description: proposed.description,
      assertion: proposed.assertion.trim(),
      capturedFrom: proposed.capturedFrom,
      disposition,
      evidenceIds: proposed.evidenceIds ?? [],
    },
    ruleId: 'EXEC-INV-003',
    ...(override ? { override } : {}),
  };
}

export interface ClassificationPass {
  classified: ClassifiedInvariant[];
  /** Proposals refused for carrying no executable assertion (`EXEC-INV-004`). */
  rejected: Array<{ description: string; reason: string }>;
}

export function classifyAll(
  proposals: ProposedInvariant[],
  projectId: string,
): ClassificationPass {
  const classified: ClassifiedInvariant[] = [];
  const rejected: ClassificationPass['rejected'] = [];

  for (const p of proposals) {
    try {
      classified.push(classify(p, classified.length, projectId));
    } catch (e) {
      if (e instanceof InvariantRejected) {
        // Dropped, not repaired. Inventing an assertion for a proposal that had
        // none would put a check into the contract that nothing observed.
        rejected.push({ description: p.description, reason: e.message });
        continue;
      }
      throw e;
    }
  }
  return { classified, rejected };
}
