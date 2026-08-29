import type { EvidenceInput } from '@proteus/schema';
import type { WorkingCopy } from './workingCopy';

/**
 * The cryptography a repository declares rather than calls.
 *
 * Transport protocols, certificates and the services a system talks to leave no
 * `Cipher.getInstance` behind, so the code scanner never sees them — yet they are
 * exactly what a PQC assessment turns on. This reads them out of configuration
 * and certificate files, deterministically, so they arrive as OBSERVED facts
 * rather than as something a model remembered about the domain.
 */

export interface EnvironmentFact {
  kind: 'PROTOCOL' | 'CERTIFICATE' | 'EXTERNAL_SERVICE';
  /** The identifier as the repository states it. */
  name: string;
  detail: string;
  note: string;
  /** True when the fact concerns cryptography a migration would have to change. */
  quantumVulnerable: boolean;
  path: string;
  line: number;
  evidence: EvidenceInput;
}

const CERT_SUBJECT = /^\s*Subject:\s*(.+?)\s*$/im;
const CERT_ALGORITHM = /^\s*Signature Algorithm:\s*(.+?)\s*$/im;
const CERT_KEY = /^\s*Public Key:\s*(.+?)\s*$/im;

/** Line number of the first occurrence of `needle`, 1-indexed. */
function lineOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
}

const observed = (
  commitSha: string, path: string, line: number, excerpt: string,
): EvidenceInput => ({
  evidenceType: path.endsWith('.md') ? 'DOCUMENT' : 'CONFIGURATION',
  evidenceClass: 'OBSERVED',
  confidence: 1,
  source: `${path}:${line}`,
  locator: { kind: 'REPO', path, startLine: line, commitSha },
  excerpt: excerpt.slice(0, 2000),
});

export async function detectEnvironment(
  wc: WorkingCopy,
  commitSha: string,
): Promise<EnvironmentFact[]> {
  const out: EnvironmentFact[] = [];
  const files = (await wc.files()).filter(
    (f) => f.kind === 'CONFIG' || f.kind === 'CERTIFICATE',
  );

  for (const file of files) {
    const text = await wc.read(file.path);

    // Transport protocols, as configured. A version is only recorded when the
    // file names one — "TLS" with no version tells an assessment nothing.
    for (const m of text.matchAll(/enabled-protocols:\s*(.+)/gi)) {
      for (const raw of m[1]!.split(',')) {
        const protocol = raw.trim().replace(/^TLSv/i, 'TLS ');
        if (!protocol) continue;
        const line = lineOf(text, m[0]!);
        out.push({
          kind: 'PROTOCOL', name: protocol,
          detail: file.path,
          note: 'Transport protocol offered by the deployment. '
            + 'Its key exchange is a migration concern even though the application does not negotiate it.',
          // TLS 1.3 key exchange is classical ECDHE unless a hybrid group is
          // configured; the config names no group, so it stays a concern.
          quantumVulnerable: true,
          path: file.path, line,
          evidence: observed(commitSha, file.path, line, m[0]!),
        });
      }
    }

    // The services the system talks to. An endpoint is where a handshake, and
    // therefore a negotiation the repository does not control, actually happens.
    for (const m of text.matchAll(/^\s*endpoint:\s*(https?:\/\/\S+)/gim)) {
      const url = m[1]!;
      const host = url.replace(/^https?:\/\//, '').split('/')[0]!;
      const line = lineOf(text, m[0]!);
      out.push({
        kind: 'EXTERNAL_SERVICE', name: host,
        detail: url,
        note: 'External boundary. Any change to the cryptography crossing it '
          + 'requires the counterparty to move in step.',
        quantumVulnerable: false,
        path: file.path, line,
        evidence: observed(commitSha, file.path, line, m[0]!.trim()),
      });
    }

    // Certificates, named by subject so a re-observation from a second file
    // converges on the same node.
    const subject = CERT_SUBJECT.exec(text);
    if (subject) {
      const algorithm = CERT_ALGORITHM.exec(text)?.[1];
      const key = CERT_KEY.exec(text)?.[1];
      const line = lineOf(text, subject[0]);
      out.push({
        kind: 'CERTIFICATE', name: subject[1]!,
        detail: [algorithm, key].filter(Boolean).join(' · '),
        note: `Certificate signature algorithm ${algorithm ?? 'not stated'}.`
          + ' Issued by the PKI, so the algorithm is the CA\'s decision, not this repository\'s.',
        quantumVulnerable: /RSA|ECDSA|DSA/i.test(`${algorithm ?? ''} ${key ?? ''}`),
        path: file.path, line,
        evidence: observed(
          commitSha, file.path, line,
          [subject[0], algorithm, key].filter(Boolean).join('\n'),
        ),
      });
    }
  }
  return out;
}
