import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Load this package's own .env before anything reads process.env.
 *
 * Resolved relative to this file rather than the working directory, so it works
 * the same whether the server is started from the repo root, from src/backend, or
 * by vitest. Uses Node's built-in loader — no dependency.
 *
 * Absence is not an error: on Cloud Run the environment is already populated from
 * Secret Manager and there is no file to read.
 */
function loadDotEnv(): void {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // A malformed .env should not take the process down before the config
    // validator can produce a useful message about what is missing.
  }
}
loadDotEnv();

/**
 * Configuration, validated per feature group.
 *
 * The product needs a Gemini key, a GCP project, GitHub credentials and a database —
 * but not all at once, and not for every increment. Validating the whole lot at
 * startup would mean nobody can run the rules engine or the API until they have a
 * GCP project. So each group is validated on first use and reports precisely what is
 * missing and which feature wanted it.
 *
 * Nothing here is read by the frontend. Values the browser needs are prefixed VITE_
 * and are public by design — Firebase web config identifies a project, it does not
 * protect it. Access control lives in this backend's ownership checks.
 */

export class ConfigError extends Error {
  constructor(feature: string, missing: string[], hint?: string) {
    super(
      `Cannot start "${feature}": missing ${missing.join(', ')}.\n` +
        `  Set ${missing.length > 1 ? 'them' : 'it'} in src/backend/.env ` +
        `(cp src/backend/.env.example src/backend/.env).` +
        (hint ? `\n  ${hint}` : ''),
    );
    this.name = 'ConfigError';
  }
}

const nonEmpty = z.string().trim().min(1);

/** An env var is always a string; these are the two coercions that need saying. */
const numeric = z.coerce.number().int().nonnegative();
const bool = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase() === 'true' || v === '1')
  .pipe(z.boolean());

// ---------------------------------------------------------------------------
// Group schemas
// ---------------------------------------------------------------------------

const Core = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MONGODB_URI: nonEmpty,
  MONGODB_DB: nonEmpty.default('proteus'),
});

/**
 * Tech Stack §2 and §3 require "Gemini 3.5 Flash or newer eligible Gemini model".
 * Enforced here rather than left as a comment, because the model id is the one
 * setting that silently degrades the product: an older model will answer every
 * prompt and reason worse, with nothing in the logs to say why.
 */
export const MINIMUM_GEMINI_VERSION = 3.5;

export function geminiVersionOf(model: string): number | null {
  const m = /^gemini-(\d+(?:\.\d+)?)/i.exec(model.trim());
  return m ? Number(m[1]) : null;
}

const GeminiModel = nonEmpty.superRefine((model, ctx) => {
  const v = geminiVersionOf(model);
  // An unrecognised naming scheme passes — a future id we cannot parse should not
  // block a deploy — but a version we CAN parse and that is too low is rejected.
  if (v !== null && v < MINIMUM_GEMINI_VERSION) {
    ctx.addIssue({
      code: 'custom',
      message:
        `"${model}" is below the required Gemini ${MINIMUM_GEMINI_VERSION} floor ` +
        `(Tech Stack §3: "Use an eligible Gemini 3.5 or newer model for agent reasoning").`,
    });
  }
});

const Gemini = z
  .object({
    GOOGLE_GENAI_USE_VERTEXAI: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    GEMINI_API_KEY: z.string().trim().optional(),
    GEMINI_MODEL: GeminiModel.default('gemini-3.5-flash'),
    GCP_PROJECT_ID: z.string().trim().optional(),
    GCP_REGION: nonEmpty.default('us-central1'),
  })
  .superRefine((v, ctx) => {
    // Two ways to reach Gemini, and exactly one must be configured.
    if (v.GOOGLE_GENAI_USE_VERTEXAI) {
      if (!v.GCP_PROJECT_ID) {
        ctx.addIssue({
          code: 'custom',
          path: ['GCP_PROJECT_ID'],
          message: 'required when GOOGLE_GENAI_USE_VERTEXAI=true',
        });
      }
    } else if (!v.GEMINI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'required unless GOOGLE_GENAI_USE_VERTEXAI=true',
      });
    }
  });

const Gcp = z.object({
  GCP_PROJECT_ID: nonEmpty,
  GCP_REGION: nonEmpty.default('us-central1'),
  GCS_BUCKET: nonEmpty,
  CLOUD_BUILD_SERVICE_ACCOUNT: z.string().trim().optional(),
  ARTIFACT_REGISTRY_REPO: nonEmpty.default('proteus-sandbox'),
  SANDBOX_SERVICE_PREFIX: nonEmpty.default('pqc-sandbox'),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().trim().optional(),
});

/**
 * Where the migration builds and where the sandbox runs (PRD-16).
 *
 * Separate from `Gcp` because it is a policy group rather than a credentials
 * group: every value has a working default, and a deployment changes them to
 * change behaviour rather than to make the product function. That is also why it
 * never fails to load — a missing value here is a default, not a broken feature.
 */
const Hosting = z.object({
  // LOCAL is a development convenience. A Cloud Run container cannot start
  // another container, so a hosted Proteus must set both of these.
  BUILD_EXECUTOR: z.enum(['LOCAL', 'CLOUD_BUILD']).default('LOCAL'),
  BUILD_IMAGE: z.string().trim().default('maven:3.9-eclipse-temurin-17'),
  CLOUD_BUILD_CACHE_URI: z.string().trim().optional(),

  SANDBOX_PLACEMENT: z.enum(['LOCAL', 'CLOUD_RUN']).default('LOCAL'),

  // Caps on what is RETAINED, never on what is deployed. Past a cap the sandbox
  // is still built and exercised, then released — verification is never
  // degraded by capacity (D-020).
  SANDBOX_MAX_PER_USER: numeric.default(3),
  SANDBOX_MAX_TOTAL: numeric.default(30),
  SANDBOX_TTL_DAYS: numeric.default(7),
  SANDBOX_HARD_TTL_DAYS: numeric.default(30),

  // Blast radius for code that is under test and not trusted. `min-instances`
  // is absent on purpose: it is always 0, which is what keeps an idle sandbox
  // free, and no sandbox has a reason to want otherwise.
  SANDBOX_MAX_INSTANCES: numeric.default(2),
  SANDBOX_CPU: z.string().trim().default('1'),
  SANDBOX_MEMORY: z.string().trim().default('512Mi'),
  SANDBOX_REQUEST_TIMEOUT_SECONDS: numeric.default(60),

  // Adds the names of PASSING methods to the feed, for agent-written suites
  // only. Failures already stream per method whatever this is.
  SANDBOX_STREAM_GENERATED_TESTS: bool.default(false),
});

/**
 * No global token. UX v1.2 made repository access per-project: the PAT is entered on
 * the create-project screen and lives in Secret Manager as
 * proteus-{projectId}-github-pat. A deployment-wide token would defeat that — one leak
 * would reach every project, and a push could not be attributed to the project that
 * made it. These two are demo conveniences for prefilling the form.
 */
const GitHub = z.object({
  GITHUB_DEFAULT_OWNER: z.string().trim().optional(),
  GITHUB_DEFAULT_REPO: z.string().trim().optional(),
});

const Firebase = z.object({
  FIREBASE_PROJECT_ID: nonEmpty,
});

// ---------------------------------------------------------------------------
// Lazy, cached access
// ---------------------------------------------------------------------------

type Source = Record<string, string | undefined>;

function load<T extends z.ZodTypeAny>(
  schema: T,
  feature: string,
  hint?: string,
  src: Source = process.env,
): z.infer<T> {
  const r = schema.safeParse(src);
  if (r.success) return r.data;
  const missing = r.error.issues.map((i) => String(i.path[0] ?? '(unknown)'));
  throw new ConfigError(feature, [...new Set(missing)], hint);
}

function memo<T>(fn: () => T): () => T {
  let cached: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      cached = fn();
      done = true;
    }
    return cached as T;
  };
}

/** Exposed so the model floor is testable without a populated environment. */
export const geminiEnvSchema = () => Gemini;

export const coreConfig = memo(() =>
  load(Core, 'API and database', 'MongoDB Atlas gives you the replica set SSE needs.'),
);

export const geminiConfig = memo(() =>
  load(
    Gemini,
    'agents',
    'Get a key at https://aistudio.google.com/apikey, or set GOOGLE_GENAI_USE_VERTEXAI=true to use Vertex AI with application-default credentials.',
  ),
);

export const gcpConfig = memo(() =>
  load(
    Gcp,
    'build, test and sandbox deployment',
    'Run: gcloud auth application-default login',
  ),
);

export const githubConfig = memo(() => load(GitHub, 'repository defaults'));

/** Every value defaults, so this cannot fail — it reports policy, not readiness. */
export const hostingConfig = memo(() => load(Hosting, 'build and sandbox hosting'));

export const firebaseConfig = memo(() => load(Firebase, 'authentication'));

/**
 * Which features are configured. The startup banner prints this so a partly
 * configured environment is visible immediately rather than failing later at the
 * first request that happens to need a missing value.
 */
export function configuredFeatures(): Record<string, boolean> {
  const ok = (fn: () => unknown) => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };
  return {
    core: ok(coreConfig),
    gemini: ok(geminiConfig),
    gcp: ok(gcpConfig),
    github: ok(githubConfig),
    firebase: ok(firebaseConfig),
  };
}
