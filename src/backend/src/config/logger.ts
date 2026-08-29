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
  'githubToken', 'token', 'apiKey', 'GEMINI_API_KEY', 'MONGODB_URI',
  'authorization', 'password', 'secret',
];

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(GITHUB_TOKEN_PATTERN, '[REDACTED]');
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        SENSITIVE_KEYS.includes(k) ? [k, '[REDACTED]'] : [k, scrub(v)],
      ),
    );
  }
  return value;
}

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
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
        method.apply(this, args.map(scrub) as Parameters<typeof method>);
      },
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });
}

export type { Logger };
