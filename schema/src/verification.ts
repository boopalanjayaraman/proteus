import { z } from 'zod';
import { CommitSha, Id, ProjectId, Timestamp, baseDocFields } from './common';
import { CryptoUsage, REQUIRED_VERIFICATION_CHECKS, VerificationCheck } from './enums';

/**
 * Deterministic verification (spec §34, §35).
 *
 * The verdict is computed from the checks array in code. No model output can
 * shortcut it, and no check may pass without pointing at a real execution.
 */

export const VerificationCheckResult = z
  .object({
    check: VerificationCheck,
    status: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']),
    detail: z.string(),
    /** Provenance. A PASS with neither an execution nor evidence is rejected. */
    executionRunId: Id.optional(),
    evidenceIds: z.array(Id).default([]),
    /** e.g. residual RSA occurrences found by PROHIBITED_CRYPTO_ABSENT. */
    findings: z
      .array(
        z.object({
          path: z.string(),
          line: z.number().int().positive().optional(),
          match: z.string(),
        }),
      )
      .default([]),
  })
  .superRefine((check, ctx) => {
    if (check.status === 'PASS' && !check.executionRunId && check.evidenceIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['executionRunId'],
        message: 'a PASS must cite an execution run or evidence — reasoning is not proof',
      });
    }
  });
export type VerificationCheckResult = z.infer<typeof VerificationCheckResult>;

/**
 * The crypto-specific summary on the completion screen. Deliberately a SEPARATE
 * list from `checks`: it is narrative rather than gating, and it needs a third
 * state. "Certificate chain still RSA-signed — PKI migration out of approved
 * scope" is neither a pass nor a failure; it is an honest NOTED. Letting NOTED
 * into `checks` would make the completion rule ambiguous.
 */
export const CryptoAssertion = z.object({
  label: z.string(), // "ML-KEM-768 encapsulation present"
  status: z.enum(['PASS', 'NOTED', 'FAIL']),
  evidence: z.string(), // "CryptoService.java:51 · provider verified at runtime"
  evidenceIds: z.array(Id).default([]),
});
export type CryptoAssertion = z.infer<typeof CryptoAssertion>;

export const VerificationResult = z.object({
  ...baseDocFields,
  verificationResultId: Id,
  projectId: ProjectId,
  migrationRunId: Id,
  commitSha: CommitSha,

  /** The nine gating checks. This list alone decides `overall`. */
  checks: z.array(VerificationCheckResult),
  cryptoAssertions: z.array(CryptoAssertion).default([]),

  overall: z.enum(['VERIFIED', 'NOT_VERIFIED']),

  residualLegacyCrypto: z
    .array(
      z.object({
        algorithm: z.string(),
        usage: CryptoUsage,
        path: z.string(),
        line: z.number().int().positive(),
        accepted: z.boolean().default(false),
        acceptanceReason: z.string().optional(),
      }),
    )
    .default([]),
  detectedPqc: z
    .array(
      z.object({
        algorithm: z.string(),
        usage: CryptoUsage,
        path: z.string(),
        line: z.number().int().positive(),
      }),
    )
    .default([]),

  verifiedAt: Timestamp,
});
export type VerificationResult = z.infer<typeof VerificationResult>;

/**
 * The completion rule from spec §35, as code. Tests passing is not migration
 * verified — every required check must pass or be genuinely inapplicable, and
 * nothing may be missing from the list. `cryptoAssertions` does not participate.
 */
export function computeOverallVerdict(
  checks: ReadonlyArray<Pick<VerificationCheckResult, 'check' | 'status'>>,
): 'VERIFIED' | 'NOT_VERIFIED' {
  const byCheck = new Map(checks.map((c) => [c.check, c.status]));
  for (const required of REQUIRED_VERIFICATION_CHECKS) {
    const status = byCheck.get(required);
    if (status !== 'PASS' && status !== 'NOT_APPLICABLE') return 'NOT_VERIFIED';
  }
  return 'VERIFIED';
}

// ---------------------------------------------------------------------------
// Sandbox (spec §36, §37)
// ---------------------------------------------------------------------------

export const SandboxDeployment = z.object({
  ...baseDocFields,
  sandboxDeploymentId: Id,
  projectId: ProjectId,
  migrationRunId: Id,

  imageUri: z.string(),
  imageDigest: z.string().optional(),
  commitSha: CommitSha,

  service: z.object({
    name: z.string(),
    region: z.string(),
    url: z.string().url().optional(),
    revision: z.string().optional(),
  }),

  status: z.enum(['BUILDING_IMAGE', 'DEPLOYING', 'STARTING', 'READY', 'FAILED', 'TORN_DOWN']),
  startupCheck: z
    .object({
      passed: z.boolean(),
      httpStatus: z.number().int().optional(),
      detail: z.string().optional(),
      /** "service started in 2.4s". */
      startupMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  e2e: z
    .object({
      executionRunId: Id,
      passed: z.boolean(),
      scenarios: z.array(z.object({ name: z.string(), passed: z.boolean() })).default([]),
      /** "latency +4.1ms vs baseline". */
      latencyDeltaMs: z.number().optional(),
    })
    .optional(),

  /** Literal, so every surface that shows this URL can label it from the data. */
  isProduction: z.literal(false).default(false),
  expiresAt: Timestamp.optional(),
  deployedAt: Timestamp.optional(),
});
export type SandboxDeployment = z.infer<typeof SandboxDeployment>;
