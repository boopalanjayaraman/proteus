import { readFileSync } from 'node:fs';

/**
 * Provider capability lookup.
 *
 * `EXEC-DET-005` locates a crypto provider dependency but refuses to infer its
 * capability from a version number, because that inference is not a corpus fact
 * and it goes stale. This reads a maintained data file instead, and returns
 * `UNKNOWN` where the file is silent — a finding that says "capability not
 * established" is honest; one that guesses is not.
 */

export type Capability = 'SUPPORTED' | 'NOT_SUPPORTED' | 'UNKNOWN';

export interface CapabilityAnswer {
  capability: Capability;
  /** Why, in words a finding can carry. */
  reason: string;
  availableFrom?: string;
  confidence?: string;
}

interface Registry {
  providers: Array<{
    coordinates: string;
    aliases: string[];
    algorithms: Record<string, { availableFrom?: string; note?: string; confidence?: string }>;
    note?: string;
  }>;
}

let registry: Registry | null = null;

export function loadRegistry(path: string): Registry {
  registry = JSON.parse(readFileSync(path, 'utf8')) as Registry;
  return registry;
}

export function setRegistry(r: Registry): void {
  registry = r;
}

/** Dotted-numeric comparison — "1.72" is below "1.78", which string order gets wrong. */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split(/[.\-+]/).map(Number);
  const pb = b.split(/[.\-+]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a < b;
    if (x !== y) return x < y;
  }
  return false;
}

export function capabilityOf(
  dependencyName: string,
  version: string,
  algorithm: string,
): CapabilityAnswer {
  const provider = registry?.providers.find(
    (p) => p.coordinates.endsWith(`:${dependencyName}`) || p.aliases.includes(dependencyName),
  );

  if (!provider) {
    return {
      capability: 'UNKNOWN',
      reason: `${dependencyName} is not in the provider capability registry; ` +
        `its ${algorithm} support has not been established`,
    };
  }

  const entry = provider.algorithms[algorithm];
  if (!entry) {
    return {
      capability: 'NOT_SUPPORTED',
      reason: provider.note ?? `${provider.coordinates} does not list ${algorithm}`,
    };
  }
  if (!entry.availableFrom) {
    return { capability: 'UNKNOWN', reason: `${provider.coordinates} lists ${algorithm} with no version` };
  }

  return versionLt(version, entry.availableFrom)
    ? {
        capability: 'NOT_SUPPORTED',
        reason: `${dependencyName} ${version} predates ${algorithm} support ` +
          `(registry: available from ${entry.availableFrom})`,
        availableFrom: entry.availableFrom,
        confidence: entry.confidence,
      }
    : {
        capability: 'SUPPORTED',
        reason: `${dependencyName} ${version} is at or above ${entry.availableFrom}`,
        availableFrom: entry.availableFrom,
        confidence: entry.confidence,
      };
}
