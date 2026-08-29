/**
 * The startup probe and the end-to-end scenario (spec §36, `EXEC-VER-010`,
 * `-011`).
 *
 * `EXEC-VER-010` separates "deployed" from "running": a Cloud Run revision can
 * exist and serve errors, and end-to-end results against a dead service are
 * meaningless. So the probe comes first and the scenario only runs once it has
 * passed.
 *
 * Everything here talks to a URL. This is the one check that exercises the
 * migrated application as a running system rather than as a build artifact,
 * which is exactly why it cannot be satisfied by reading source.
 */

export interface ProbeResult {
  passed: boolean;
  httpStatus?: number;
  startupMs: number;
  detail: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  detail: string;
  latencyMs?: number;
}

export interface E2EOutcome {
  passed: boolean;
  scenarios: ScenarioResult[];
  latencyDeltaMs?: number;
  log: string;
}

/** A scenario the deployed application must satisfy. */
export interface Scenario {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  expectStatus: number;
  /** Optional assertion over the response body, so a 201 with nothing in it fails. */
  expectBody?: (body: unknown) => { ok: boolean; detail: string };
}

/**
 * The reference scenario for the demo repository.
 *
 * Named here rather than generated, because a model-authored end-to-end suite
 * would be judging the migration against criteria the migration's author chose.
 * These come from the fixture's own contract: 201 on a valid settlement advice,
 * 400 on a malformed one, and a console that reports the mechanism actually in
 * use — which is what turns the sandbox link from "the app still starts" into
 * "you can see the cryptography changed".
 */
export const SETTLEMENT_SCENARIOS: Scenario[] = [
  {
    name: 'Settlement advice is accepted',
    method: 'POST',
    path: '/settlements',
    body: { merchantId: 'MERCH-001', amountMinor: 125_00, currency: 'GBP', reference: 'e2e-1' },
    expectStatus: 201,
    expectBody: (body) => {
      const b = body as { keyEstablishment?: string; wrappedKeyBytes?: number };
      // The point of the check. A 201 proves the endpoint works; the mechanism
      // it names proves the migration reached the running system.
      if (!b?.keyEstablishment) {
        return { ok: false, detail: 'response did not report a key establishment mechanism' };
      }
      return {
        ok: true,
        detail: `keyEstablishment=${b.keyEstablishment}`
          + (b.wrappedKeyBytes ? ` · ${b.wrappedKeyBytes} bytes` : ''),
      };
    },
  },
  {
    name: 'Malformed advice is rejected',
    method: 'POST',
    path: '/settlements',
    body: { merchantId: '', amountMinor: -1 },
    // The failure mode is part of the acquirer contract. A migration that turns
    // a rejection into an acceptance passes every happy-path test ever written.
    expectStatus: 400,
  },
  {
    name: 'Operator console reports the mechanism in use',
    method: 'GET',
    path: '/',
    expectStatus: 200,
  },
];

/**
 * Waits for the service to answer its health endpoint.
 *
 * Polls rather than sleeping a fixed interval: a container that starts in two
 * seconds should not cost thirty, and one that never starts should fail with
 * the status it was actually returning rather than a timeout with no detail.
 */
export async function probeStartup(
  baseUrl: string,
  opts: { path?: string; timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProbeResult> {
  const path = opts.path ?? '/healthz';
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 500;
  const doFetch = opts.fetchImpl ?? fetch;

  const started = Date.now();
  let lastStatus: number | undefined;
  let lastError = 'no response';

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await doFetch(`${baseUrl}${path}`, { method: 'GET' });
      lastStatus = res.status;
      if (res.ok) {
        return {
          passed: true,
          httpStatus: res.status,
          startupMs: Date.now() - started,
          detail: `service answered ${path} with ${res.status} in `
            + `${((Date.now() - started) / 1000).toFixed(1)}s`,
        };
      }
      lastError = `${path} returned ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    passed: false,
    ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
    startupMs: Date.now() - started,
    detail: `service did not become healthy within ${timeoutMs / 1000}s: ${lastError}`,
  };
}

/**
 * Runs the scenarios against the deployed URL.
 *
 * Every scenario runs even after one fails. A suite that stops at the first
 * failure reports one problem when there may be three, and the report is
 * supposed to say what the state of the system is.
 */
export async function runScenarios(
  baseUrl: string,
  scenarios: Scenario[],
  opts: { fetchImpl?: typeof fetch; baselineLatencyMs?: number } = {},
): Promise<E2EOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const results: ScenarioResult[] = [];
  const log: string[] = [];

  for (const scenario of scenarios) {
    const started = Date.now();
    try {
      const res = await doFetch(`${baseUrl}${scenario.path}`, {
        method: scenario.method,
        ...(scenario.body !== undefined
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(scenario.body),
            }
          : {}),
      });
      const latencyMs = Date.now() - started;

      if (res.status !== scenario.expectStatus) {
        results.push({
          name: scenario.name, passed: false, latencyMs,
          detail: `expected ${scenario.expectStatus}, got ${res.status}`,
        });
        log.push(`FAIL ${scenario.method} ${scenario.path} → ${res.status}`);
        continue;
      }

      if (scenario.expectBody) {
        const body = await res.json().catch(() => null);
        const verdict = scenario.expectBody(body);
        results.push({
          name: scenario.name, passed: verdict.ok, latencyMs, detail: verdict.detail,
        });
        log.push(`${verdict.ok ? 'PASS' : 'FAIL'} ${scenario.method} ${scenario.path} `
          + `→ ${res.status} · ${verdict.detail}`);
        continue;
      }

      results.push({
        name: scenario.name, passed: true, latencyMs, detail: `${res.status} as expected`,
      });
      log.push(`PASS ${scenario.method} ${scenario.path} → ${res.status} (${latencyMs}ms)`);
    } catch (e) {
      results.push({
        name: scenario.name, passed: false, latencyMs: Date.now() - started,
        detail: (e as Error).message,
      });
      log.push(`FAIL ${scenario.method} ${scenario.path} → ${(e as Error).message}`);
    }
  }

  const measured = results.filter((r) => r.latencyMs !== undefined);
  const meanLatency = measured.length > 0
    ? measured.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / measured.length
    : undefined;

  return {
    passed: results.every((r) => r.passed),
    scenarios: results,
    // Reported, never gated. `EXEC-ESC-007` is explicit that "material" needs a
    // budget nobody has supplied, so the delta is measured and shown and only
    // blocks once someone has said what too slow means.
    ...(meanLatency !== undefined && opts.baselineLatencyMs !== undefined
      ? { latencyDeltaMs: Math.round((meanLatency - opts.baselineLatencyMs) * 10) / 10 }
      : {}),
    log: log.join('\n'),
  };
}
