import { GoogleAuth } from 'google-auth-library';

/**
 * A small authenticated JSON client for the two Google APIs this product calls.
 *
 * REST rather than the generated SDKs, deliberately. `@google-cloud/cloudbuild`
 * and `@google-cloud/run` are gRPC clients that pull in `google-gax` and a large
 * dependency tree, and the two things needed here — submit a build and poll it,
 * create a service and poll it — are plain JSON over HTTPS. `google-auth-library`
 * is already present for the storage client, so this adds no new tree.
 *
 * The other reason is control. `EXEC-VER`'s live feed needs the build's log
 * *while it is running*, which means polling the log object on a schedule the
 * caller chooses rather than awaiting a completed long-running operation.
 */

export class GcpApiError extends Error {
  constructor(
    readonly status: number,
    readonly api: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'GcpApiError';
  }
}

export interface GcpTransport {
  request<T>(init: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    body?: unknown;
    /** Some responses are plain text — a build log object, for instance. */
    text?: boolean;
  }): Promise<T>;
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Application Default Credentials, once.
 *
 * A token is cached and refreshed by the library. Constructing `GoogleAuth` per
 * call would re-read the credential file and re-mint a token on every poll, and
 * this polls.
 */
export class GoogleApiTransport implements GcpTransport {
  private readonly auth = new GoogleAuth({ scopes: [SCOPE] });

  async request<T>(init: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    body?: unknown;
    text?: boolean;
  }): Promise<T> {
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();

    const res = await fetch(init.url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token.token ?? ''}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      const message = (detail as { error?: { message?: string } })?.error?.message
        ?? res.statusText;
      // 404 on a poll is ordinary — a log object that does not exist yet — so
      // the status is carried rather than flattened into one failure type.
      throw new GcpApiError(res.status, hostOf(init.url), message, detail);
    }

    return (init.text ? await res.text() : await res.json()) as T;
  }
}

/**
 * A transport that answers from a script.
 *
 * The executors and deployers built on this are exercised for real in tests —
 * their polling, their parsing, their error handling — with only the network
 * replaced. A test that mocked the executor instead would prove nothing about
 * any of it.
 */
export class ScriptedTransport implements GcpTransport {
  readonly calls: Array<{ method: string; url: string; body?: unknown }> = [];

  constructor(
    private readonly answers: Array<{
      match: RegExp;
      /** A function so a poll can return a different answer each time. */
      reply: (call: number) => unknown;
      status?: number;
    }>,
  ) {}

  private readonly counts = new Map<RegExp, number>();

  async request<T>(init: { method: string; url: string; body?: unknown }): Promise<T> {
    this.calls.push({ method: init.method, url: init.url, ...(init.body ? { body: init.body } : {}) });
    const answer = this.answers.find((a) => a.match.test(`${init.method} ${init.url}`));
    if (!answer) throw new GcpApiError(404, 'scripted', `no scripted reply for ${init.url}`);

    const n = (this.counts.get(answer.match) ?? 0) + 1;
    this.counts.set(answer.match, n);

    if (answer.status && answer.status >= 400) {
      throw new GcpApiError(answer.status, 'scripted', `scripted ${answer.status}`);
    }
    return answer.reply(n) as T;
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.split('.')[0] ?? url;
  } catch {
    return url;
  }
};

/**
 * Polls until a predicate holds or the deadline passes.
 *
 * Shared because both APIs are long-running in the same way, and because the
 * interval matters: too eager and a build burns quota on `get`, too slow and the
 * feed lags behind the thing it is describing.
 */
export async function pollUntil<T>(
  fetchOnce: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { intervalMs?: number; timeoutMs?: number; onPoll?: (value: T) => void | Promise<void> } = {},
): Promise<{ value: T; timedOut: boolean }> {
  const interval = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000);

  let value = await fetchOnce();
  await opts.onPoll?.(value);

  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    value = await fetchOnce();
    await opts.onPoll?.(value);
  }
  return { value, timedOut: !done(value) };
}
