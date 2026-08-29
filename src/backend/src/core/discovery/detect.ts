import {
  makeFindingDedupeKey, type CryptoUsage, type EvidenceInput, type Severity,
} from '@proteus/schema';
import type { RuleEngine } from '../rules/engine';
import { capabilityOf } from './providers';
import type { WorkingCopy } from './workingCopy';

/**
 * The deterministic discovery pass.
 *
 * Runs the `EXEC-DET-*` rules over a checked-out tree and produces candidate
 * findings with evidence. No model is involved: what this returns is either a
 * pattern match or nothing.
 *
 * Usage strength is the load-bearing distinction. A `STRONG` match assigns a
 * usage; a `WEAK` one produces `UNKNOWN` for investigation, because
 * `Cipher.getInstance("RSA/...")` on its own is as likely to be payload
 * encryption as key transport, and migrating the former to a KEM would be wrong.
 */

export interface Candidate {
  ruleId: string;
  path: string;
  line: number;
  matchedText: string;
  algorithm?: string;
  keySize?: number;
  usage: CryptoUsage;
  strength: 'STRONG' | 'WEAK';
  severity: Severity;
  quantumVulnerable: boolean;
  dedupeKey: string;
  evidence: EvidenceInput;
  /** Set when a rule wants a human or a later phase to look again. */
  requiresInvestigation?: boolean;
  note?: string;
}

export interface DetectionResult {
  candidates: Candidate[];
  filesScanned: number;
}

interface DetectionRule {
  ruleId: string;
  patterns: RegExp[];
  requireAll: boolean;
  /** What the matched call's algorithm must resolve to, literal or constant. */
  resolvesTo: RegExp | null;
  exclude: RegExp[];
  appliesTo: string[];
  impliesUsage: CryptoUsage;
  strength: 'STRONG' | 'WEAK';
  requiresInvestigation: boolean;
}

/** Reads the DETECTION_SIGNATURE family out of the ruleset. */
export function detectionRules(engine: RuleEngine): DetectionRule[] {
  return engine
    .matchExecution('DETECTION_SIGNATURE', {
      // Facts every detection rule is evaluated against; per-file facts are
      // applied when the rule is actually run over a file.
      fileKind: ['SOURCE', 'CONFIG', 'MANIFEST', 'TEST', 'CERTIFICATE'],
      language: 'Java',
      buildSystem: 'Maven',
      filePath: '',
    })
    .map((m) => {
      const t = m.outcome;
      return {
        ruleId: m.rule.ruleId,
        patterns: ((t['patterns'] as string[]) ?? []).map((p) => new RegExp(p, 'i')),
        requireAll: t['requireAll'] === true,
        resolvesTo: t['resolvesTo'] ? new RegExp(String(t['resolvesTo']), 'i') : null,
        exclude: ((t['excludeWhenAlsoMatches'] as string[]) ?? []).map((p) => new RegExp(p, 'i')),
        appliesTo: asArray(m.rule.when['fileKind']),
        impliesUsage: (t['impliesUsage'] as CryptoUsage) ?? 'UNKNOWN',
        strength: t['strength'] === 'STRONG' ? 'STRONG' : 'WEAK',
        requiresInvestigation: t['requiresInvestigation'] === true,
      } satisfies DetectionRule;
    })
    .filter((r) => r.patterns.length > 0);
}

export async function detect(
  engine: RuleEngine,
  wc: WorkingCopy,
  commitSha: string,
  permalinkFor: (path: string, line: number) => string | undefined,
): Promise<DetectionResult> {
  const rules = detectionRules(engine);
  const files = await wc.files();
  const candidates: Candidate[] = [];

  for (const file of files) {
    const applicable = rules.filter(
      (r) => r.appliesTo.length === 0 || r.appliesTo.includes(file.kind),
    );
    if (applicable.length === 0) continue;

    const content = await wc.read(file.path);
    const lines = content.split('\n');

    for (const rule of applicable) {
      // `requireAll` means the signals must co-occur in the file — WRAP_MODE
      // beside getInstance is what turns an RSA cipher into key transport.
      const allPresent = rule.patterns.every((p) => p.test(content));
      if (rule.requireAll && !allPresent) continue;
      if (rule.exclude.some((p) => p.test(content))) continue;

      const anchor = rule.patterns[0]!;
      lines.forEach((text, i) => {
        if (!anchor.test(text)) return;
        // A commented-out line is not a usage. EXEC-DET-002's excludeWhen cannot
        // see this, because the comment is on a different line from the anchor.
        if (/^\s*(\/\/|\*|#|<!--)/.test(text)) return;

        const line = i + 1;
        const algorithm = extractAlgorithm(content, text);

        // Production Java names its transform in a constant, so the pattern
        // matches the call and the rule says what it must resolve to. Without
        // this every rule would need a literal, and would match tutorials rather
        // than real code.
        if (rule.resolvesTo && !rule.resolvesTo.test(algorithm ?? '')) return;
        candidates.push({
          ruleId: rule.ruleId,
          path: file.path,
          line,
          matchedText: text.trim(),
          algorithm,
          keySize: extractKeySize(content, algorithm),
          usage: rule.strength === 'STRONG' ? rule.impliesUsage : 'UNKNOWN',
          strength: rule.strength,
          severity: rule.strength === 'STRONG' ? 'CRITICAL' : 'MEDIUM',
          quantumVulnerable: /^(RSA|EC|DH|DSA)/i.test(algorithm ?? ''),
          requiresInvestigation: rule.requiresInvestigation || rule.strength === 'WEAK',
          dedupeKey: makeFindingDedupeKey({
            algorithm,
            usage: rule.strength === 'STRONG' ? rule.impliesUsage : 'UNKNOWN',
            path: file.path,
            startLine: line,
            title: rule.ruleId,
          }),
          evidence: {
            evidenceType: file.kind === 'MANIFEST' ? 'DEPENDENCY'
              : file.kind === 'CONFIG' ? 'CONFIGURATION'
              : file.kind === 'CERTIFICATE' ? 'DOCUMENT' : 'SOURCE_CODE',
            // A tool established this, so it is OBSERVED at full confidence.
            // Nothing in this increment may write INFERRED (FR-8).
            evidenceClass: 'OBSERVED',
            confidence: 1.0,
            source: `${file.path}:${line}`,
            locator: {
              kind: 'REPO', path: file.path, startLine: line, commitSha,
              permalink: permalinkFor(file.path, line),
            },
            excerpt: excerpt(lines, i),
          },
        });
      });
    }
  }

  return { candidates, filesScanned: files.length };
}

/**
 * Dependencies of interest, with capability resolved from the registry rather
 * than from a version comparison in a rule (EXEC-DET-005).
 */
export interface DependencyFinding {
  dependencyName: string;
  version: string;
  path: string;
  line: number;
  capability: ReturnType<typeof capabilityOf>;
}

export async function detectDependencies(
  wc: WorkingCopy,
  targetAlgorithm = 'ML-KEM',
): Promise<DependencyFinding[]> {
  const out: DependencyFinding[] = [];
  const manifests = (await wc.files()).filter((f) => f.kind === 'MANIFEST');

  for (const m of manifests) {
    const lines = (await wc.read(m.path)).split('\n');
    lines.forEach((text, i) => {
      const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(text)?.[1];
      if (!artifact || !/^(bcprov|bcpkix|bctls|nimbus|jose|tink|conscrypt)/i.test(artifact)) return;

      // The version normally sits on the following line in a Maven POM.
      const version = /<version>([^<]+)<\/version>/.exec(lines[i + 1] ?? '')?.[1]
        ?? /<version>([^<]+)<\/version>/.exec(lines[i + 2] ?? '')?.[1];
      if (!version) return;

      out.push({
        dependencyName: artifact,
        version,
        path: m.path,
        line: i + 1,
        capability: capabilityOf(artifact, version, targetAlgorithm),
      });
    });
  }
  return out;
}

const asArray = (v: unknown): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)];

/**
 * The algorithm a call actually uses.
 *
 * Handles both forms: a string literal in the call, and — the common case in
 * production code — an identifier resolved against a constant declared in the
 * same file. Returns the full transform so a rule's `resolvesTo` can match on
 * any part of it (`^RSA`, `with(RSA|ECDSA)`).
 */
function extractAlgorithm(content: string, line: string): string | undefined {
  const literal = /getInstance\(\s*"([^"]+)"/.exec(line)?.[1];
  if (literal) return normalise(literal, line);

  const identifier = /getInstance\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/.exec(line)?.[1];
  if (identifier) {
    const declared = new RegExp(`\\b${identifier}\\s*=\\s*"([^"]+)"`).exec(content)?.[1];
    if (declared) return normalise(declared, line);
  }
  return undefined;
}

/** `RSA/ECB/OAEP…` stays whole; a key size on the line is appended when present. */
function normalise(transform: string, line: string): string {
  const size = /\b(1024|2048|3072|4096)\b/.exec(line)?.[1];
  return size ? `${transform}-${size}` : transform;
}

/** `initialize(2048)` near a key-pair generator. */
function extractKeySize(content: string, algorithm?: string): number | undefined {
  if (!algorithm || !/^(RSA|DH|DSA)/i.test(algorithm)) return undefined;
  const n = /\.initialize\(\s*(\d{3,5})/.exec(content)?.[1];
  return n ? Number(n) : undefined;
}

/** Three lines either side, with original line numbers, as the finding card shows it. */
function excerpt(lines: string[], index: number): string {
  const from = Math.max(0, index - 2);
  const to = Math.min(lines.length, index + 3);
  return lines
    .slice(from, to)
    .map((l, k) => `${String(from + k + 1).padStart(3, ' ')}  ${l}`)
    .join('\n')
    .slice(0, 2000);
}
