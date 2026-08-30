import { GITHUB_TOKEN_PATTERN } from '@proteus/schema';
import pino, { type Logger } from 'pino';

/**
 * Operational logging (TD-008).
 *
 * Distinct from the event log, which is the product's audit trail. Events record
 * what the agent did; this records what the process did — including the failures
 * that happen *before* an emitter runs, which until now left no trace at all.
 *
 * Redaction is applied at the serialiser, not by callers. `redactTokens` protects
 * what reaches the database; this protects what reaches stdout, and Cloud Run
 * ships stdout to Cloud Logging where it is retained and searchable. An
 * operational log that leaks a credential the event log was careful about is the
 * same failure by a different route.
 */

const SENSITIVE_KEYS = [
  'githubtoken', 'token', 'apikey', 'gemini_api_key', 'mongodb_uri',
  'authorization', 'password', 'secret',
];

const isSensitive = (key: string) => SENSITIVE_KEYS.includes(key.toLowerCase());

/**
 * A plain object or an array — the only things worth walking.
 *
 * Anything else is left for pino's own serialisers, and that is the important
 * half. `Object.entries` on an Error returns `{}`, because `message` and `stack`
 * are not enumerable: walking one would silently throw away the whole reason
 * something failed. And walking a Fastify request reaches `raw.socket.server`
 * and never comes back.
 */
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/** Deep enough for anything this product logs, shallow enough to stay cheap. */
const MAX_DEPTH = 8;

/**
 * Redacts credentials on the way to stdout.
 *
 * `ancestors` tracks the path currently being walked rather than everything
 * seen, so a genuine cycle is caught while the same object appearing twice in
 * two branches still renders both times.
 */
function scrub(value: unknown, ancestors: Set<object> = new Set(), depth = 0): unknown {
  if (typeof value === 'string') return value.replace(GITHUB_TOKEN_PATTERN, '[REDACTED]');
  if (!isPlain(value) && !Array.isArray(value)) return value;

  if (ancestors.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => scrub(v, ancestors, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) =>
        isSensitive(k) ? [k, '[REDACTED]'] : [k, scrub(v, ancestors, depth + 1)],
      ),
    );
  } finally {
    // Removed on the way out: a sibling reference is not a cycle.
    ancestors.delete(value);
  }
}

/**
 * pino's level labels, in the vocabulary Cloud Logging indexes.
 *
 * Without this every line arrives as `DEFAULT` severity, so the console cannot
 * filter errors and none of them page anyone. `level` also arrives as a number,
 * which is the field Cloud Logging would otherwise show instead of the message.
 */
const GCP_SEVERITY: Record<string, string> = {
  trace: 'DEBUG', debug: 'DEBUG', info: 'INFO',
  warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL',
};

/**
 * Whether to emit Cloud Logging's structured shape.
 *
 * `K_SERVICE` is set by Cloud Run itself, so a deployed service needs no
 * configuration. `LOG_FORMAT=GCP` covers a GCE VM running the ops agent, which
 * ingests the same JSON from stdout but sets no marker of its own.
 */
export function useCloudLogging(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['K_SERVICE']) || env['LOG_FORMAT'] === 'GCP';
}

export function createLogger(
  level: string,
  pretty: boolean,
  /**
   * Where the lines go. Injected so a test can read what was actually written
   * rather than assert on what `scrub` returns — the redaction that matters is
   * the redaction that survives pino's own serialisation.
   */
  destination?: pino.DestinationStream,
  /** Defaults to auto-detection; a test passes it explicitly. */
  cloudLogging: boolean = useCloudLogging(),
): Logger {
  const options: pino.LoggerOptions = {
    level,
    // Nested paths the pattern cannot see, removed by key.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.githubToken',
        '*.GEMINI_API_KEY',
        '*.MONGODB_URI',
      ],
      censor: '[REDACTED]',
    },
    hooks: {
      logMethod(args, method) {
        method.apply(
          this,
          args.map((a) => scrub(a)) as Parameters<typeof method>,
        );
      },
    },
    ...(pretty && !destination
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
    // Cloud Logging reads `severity`, `message` and an ISO `timestamp`. pino's
    // defaults are `level` (a number), `msg` and epoch millis, none of which it
    // recognises — so a deployed run would show numeric levels and no message
    // text at all. Redaction and the scrub hook above are untouched: this only
    // renames the envelope.
    ...(cloudLogging
      ? {
          messageKey: 'message',
          formatters: { level: (label: string) => ({ severity: GCP_SEVERITY[label] ?? 'DEFAULT' }) },
          timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
        }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
