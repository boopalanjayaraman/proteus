import type { Comparison, WhenClause } from '@proteus/schema';

/**
 * Evaluates a rule's `when` clause against a bag of facts.
 *
 * The rulesets use ~60 distinct condition keys across nine families, and enumerating
 * them one by one would rot the moment a rule is added. Instead the key's SUFFIX
 * determines the operator and its STEM names the fact:
 *
 *   algorithmMatches: "^RSA"        regex   against fact `algorithm`
 *   usageIn: [A, B]                 member  against fact `usage`
 *   keySize: {op: lt, value: 3072}  compare against fact `keySize`
 *   protocolManaged: true           equals  against fact `protocolManaged`
 *   anyOf: [ {...}, {...} ]         disjunction of sub-clauses
 *
 * Two asymmetries are deliberate. A scalar predicate matches an ARRAY fact by
 * membership (`nodeType: HSM` matches `nodeType: ['HSM','SERVICE']`), because facts
 * are frequently multi-valued. And a missing fact never matches — a rule cannot fire
 * on evidence the engine does not hold, which is what keeps `machineEvaluable: false`
 * rules inert rather than accidentally true.
 */

export type Facts = Record<string, unknown>;

export interface MatchResult {
  matched: boolean;
  /** Keys that failed, for explaining why a rule did not fire. */
  failedOn: string[];
  /** Keys that had no corresponding fact — distinct from a genuine mismatch. */
  missingFacts: string[];
}

const REGEX_SUFFIX = 'Matches';
const MEMBER_SUFFIX = 'In';
const ALL_IN_SUFFIX = 'AllIn';   // every value of the fact must be in the list
const NONE_SUFFIX = 'None';      // the fact must contain none of the listed values

function isComparison(v: unknown): v is Comparison {
  return typeof v === 'object' && v !== null && 'op' in v && 'value' in v;
}

/** `algorithmMatches` -> `algorithm`; `usageIn` -> `usage`; otherwise unchanged. */
export function factNameFor(key: string): string {
  for (const suffix of [REGEX_SUFFIX, ALL_IN_SUFFIX, NONE_SUFFIX, MEMBER_SUFFIX]) {
    if (key.endsWith(suffix) && key.length > suffix.length) return key.slice(0, -suffix.length);
  }
  return key;
}

/**
 * The suffix convention collides with ordinary English: `failureOriginatesIn` reads as
 * "originates in", not "is a member of". Rather than rename rules to suit the parser,
 * resolve the stem first and fall back to the literal key — so a fact may be named
 * either way and the rule still fires.
 */
function resolveFact(key: string, facts: Facts): { name: string; value: unknown } | null {
  const stem = factNameFor(key);
  if (stem in facts && facts[stem] != null) return { name: stem, value: facts[stem] };
  if (key in facts && facts[key] != null) return { name: key, value: facts[key] };
  return null;
}

function compare(actual: unknown, c: Comparison): boolean {
  // Numeric where both sides are numeric; lexical otherwise, so semver-ish strings
  // still order sensibly without pulling in a parser.
  const a = typeof actual === 'string' && !Number.isNaN(Number(actual)) ? Number(actual) : actual;
  const b = typeof c.value === 'string' && !Number.isNaN(Number(c.value)) ? Number(c.value) : c.value;
  if (typeof a === 'number' && typeof b === 'number') {
    switch (c.op) {
      case 'lt': return a < b;
      case 'lte': return a <= b;
      case 'eq': return a === b;
      case 'gte': return a >= b;
      case 'gt': return a > b;
    }
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const cmp = compareLoose(a, b);
    switch (c.op) {
      case 'lt': return cmp < 0;
      case 'lte': return cmp <= 0;
      case 'eq': return cmp === 0;
      case 'gte': return cmp >= 0;
      case 'gt': return cmp > 0;
    }
  }
  return false;
}

/** Dotted-numeric comparison ("1.72" < "1.78"), falling back to string order. */
function compareLoose(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (Number.isNaN(na) || Number.isNaN(nb)) return a < b ? -1 : a > b ? 1 : 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

function matchesRegex(actual: unknown, pattern: string): boolean {
  const re = new RegExp(pattern, 'i');
  return asArray(actual).some((v) => typeof v === 'string' && re.test(v));
}

function matchesMember(actual: unknown, allowed: unknown[]): boolean {
  const set = new Set(allowed.map(String));
  return asArray(actual).some((v) => set.has(String(v)));
}

/** Universal quantifier — every value of the fact must appear in the list. */
function matchesAllIn(actual: unknown, allowed: unknown[]): boolean {
  const set = new Set(allowed.map(String));
  const vals = asArray(actual);
  return vals.length > 0 && vals.every((v) => set.has(String(v)));
}

/** Negated membership — the fact contains none of the listed values. */
function matchesNone(actual: unknown, forbidden: unknown[]): boolean {
  const set = new Set(forbidden.map(String));
  return !asArray(actual).some((v) => set.has(String(v)));
}

function matchesScalar(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return matchesMember(actual, expected);
  return asArray(actual).some((v) => v === expected || String(v) === String(expected));
}

function evalKey(key: string, expected: unknown, facts: Facts): 'match' | 'mismatch' | 'missing' {
  if (key === 'anyOf') {
    const branches = (expected as Array<WhenClause>) ?? [];
    return branches.some((b) => evaluate(b, facts).matched) ? 'match' : 'mismatch';
  }

  const resolved = resolveFact(key, facts);
  if (!resolved) return 'missing';
  const actual = resolved.value;

  if (key.endsWith(REGEX_SUFFIX) && typeof expected === 'string') {
    return matchesRegex(actual, expected) ? 'match' : 'mismatch';
  }
  if (key.endsWith(ALL_IN_SUFFIX) && Array.isArray(expected)) {
    return matchesAllIn(actual, expected) ? 'match' : 'mismatch';
  }
  if (key.endsWith(NONE_SUFFIX) && Array.isArray(expected)) {
    return matchesNone(actual, expected) ? 'match' : 'mismatch';
  }
  if (key.endsWith(MEMBER_SUFFIX) && Array.isArray(expected)) {
    return matchesMember(actual, expected) ? 'match' : 'mismatch';
  }
  if (isComparison(expected)) {
    return compare(actual, expected) ? 'match' : 'mismatch';
  }
  return matchesScalar(actual, expected) ? 'match' : 'mismatch';
}

/** All clauses are ANDed. An empty `when` matches unconditionally. */
export function evaluate(when: WhenClause, facts: Facts): MatchResult {
  const failedOn: string[] = [];
  const missingFacts: string[] = [];
  for (const [key, expected] of Object.entries(when ?? {})) {
    const r = evalKey(key, expected, facts);
    if (r === 'missing') missingFacts.push(key);
    else if (r === 'mismatch') failedOn.push(key);
  }
  return { matched: failedOn.length === 0 && missingFacts.length === 0, failedOn, missingFacts };
}
