import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EventStream } from '../src/api/stream';
import { ApiClient, ApiClientError } from '../src/api/client';
import {
  IMPACT_COLOR, IMPACT_LABEL, STAGE_LABEL, actionLabel, autonomyDisplay, elapsed, isLive,
} from '../src/lib/impact';

/** PRD-04 acceptance criteria. */

describe('AC-3 · header values are derived, never stored', () => {
  it('renders an em dash before a migration starts, not 0%', () => {
    expect(autonomyDisplay(null)).toBe('—');
    expect(autonomyDisplay(undefined)).toBe('—');
    expect(autonomyDisplay(0)).toBe('0%');
    expect(autonomyDisplay(100)).toBe('100%');
  });

  it('counts elapsed time from the stage it entered', () => {
    const since = new Date('2026-08-29T10:00:00Z');
    const now = new Date('2026-08-29T10:07:12Z').getTime();
    expect(elapsed(since, now)).toBe('07:12');
    expect(elapsed(undefined)).toBe('00:00');
  });

  it('treats only analysing and migrating as live', () => {
    expect(isLive('ANALYZING')).toBe(true);
    expect(isLive('MIGRATING')).toBe(true);
    expect(isLive('AWAITING_APPROVAL')).toBe(false);
    expect(isLive('COMPLETED')).toBe(false);
  });

  it('derives the tile action from stage and actionRequired', () => {
    expect(actionLabel('AWAITING_APPROVAL', false)).toBe('REVIEW & APPROVE');
    expect(actionLabel('MIGRATING', false)).toBe('IN PROGRESS');
    expect(actionLabel('SANDBOX_READY', false)).toBe('REVIEW SANDBOX');
    expect(actionLabel('COMPLETED', false)).toBe('VIEW REPORT');
    // A project needing a decision says so, whatever stage it is in.
    expect(actionLabel('MIGRATING', true)).toBe('DECISION REQUIRED');
  });

  it('labels every stage and impact the schema defines', () => {
    expect(Object.keys(STAGE_LABEL)).toHaveLength(10);
    expect(Object.keys(IMPACT_LABEL)).toHaveLength(8);
    // The legend collapses vendor and hardware; the data keeps them apart.
    expect(IMPACT_LABEL.VENDOR_CONTROLLED).toBe(IMPACT_LABEL.HARDWARE_CONTROLLED);
    expect(IMPACT_COLOR.VENDOR_CONTROLLED).toBe(IMPACT_COLOR.HARDWARE_CONTROLLED);
  });
});

describe('AC-4 · the stream never duplicates a row', () => {
  const frame = (seq: number, title: string) =>
    `id: ${seq}\nevent: CRYPTO_FINDING_DETECTED\ndata: ${JSON.stringify({ seq, title })}\n\n`;

  function streamOf(...chunks: string[]) {
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    });
  }

  it('drops anything at or below the resume cursor', async () => {
    const seen: number[] = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, body: streamOf(frame(1, 'a'), frame(2, 'b'), frame(3, 'c')),
    }));

    const s = new EventStream({
      url: '/stream', token: async () => 't', fromSeq: 2,
      onEvent: (e) => seen.push(e.seq),
    });
    s.start();
    await new Promise((r) => setTimeout(r, 60));
    s.stop();

    expect(seen).toEqual([3]);
    vi.unstubAllGlobals();
  });

  it('advances its cursor so a reconnect resumes from the right place', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, body: streamOf(frame(7, 'a'), frame(8, 'b')),
    }));
    const s = new EventStream({
      url: '/stream', token: async () => 't', fromSeq: 0, onEvent: () => undefined,
    });
    s.start();
    await new Promise((r) => setTimeout(r, 60));
    s.stop();
    expect(s.cursor).toBe(8);
    vi.unstubAllGlobals();
  });

  it('reassembles a frame split across two chunks', async () => {
    const whole = frame(1, 'split across reads');
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      body: streamOf(whole.slice(0, 30), whole.slice(30)),
    }));
    const s = new EventStream({
      url: '/stream', token: async () => 't', fromSeq: 0,
      onEvent: (e) => seen.push((e as unknown as { title: string }).title),
    });
    s.start();
    await new Promise((r) => setTimeout(r, 60));
    s.stop();
    expect(seen).toEqual(['split across reads']);
    vi.unstubAllGlobals();
  });

  it('ignores heartbeat comments', async () => {
    const seen: number[] = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, body: streamOf(': keep-alive\n\n', frame(1, 'a')),
    }));
    const s = new EventStream({
      url: '/stream', token: async () => 't', fromSeq: 0, onEvent: (e) => seen.push(e.seq),
    });
    s.start();
    await new Promise((r) => setTimeout(r, 60));
    s.stop();
    expect(seen).toEqual([1]);
    vi.unstubAllGlobals();
  });
});

describe('AC-2 · every request carries a fresh token', () => {
  it('fetches the token per call rather than caching it', async () => {
    const token = vi.fn().mockResolvedValue('tok-1');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ userId: 'u1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = new ApiClient('http://api', token);
    await api.me();
    await api.me();

    // Twice, not once — a cached token expires mid-migration.
    expect(token).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.authorization).toBe('Bearer tok-1');
    vi.unstubAllGlobals();
  });

  it('surfaces the server error shape rather than a raw status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
      json: async () => ({ error: { code: 'NOT_FOUND', message: 'Project not found', requestId: 'req-9' } }),
    }));
    const api = new ApiClient('http://api', async () => 't');
    await expect(api.project('PQC-0001')).rejects.toMatchObject({
      status: 404, code: 'NOT_FOUND', requestId: 'req-9',
    });
    await expect(api.project('PQC-0001')).rejects.toBeInstanceOf(ApiClientError);
    vi.unstubAllGlobals();
  });
});

describe('AC-6 · the bundle contains no backend secret', () => {
  it('ships nothing from src/backend/.env', () => {
    const dist = join(import.meta.dirname, '..', 'dist', 'assets');
    let bundle = '';
    for (const f of readdirSync(dist)) {
      if (f.endsWith('.js')) bundle += readFileSync(join(dist, f), 'utf8');
    }
    expect(bundle.length).toBeGreaterThan(1000); // the build actually ran

    // Anything that would be a leak if Vite inlined it.
    expect(bundle).not.toMatch(/mongodb\+srv:\/\//);
    expect(bundle).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
    expect(bundle).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{16,}/);
    expect(bundle).not.toMatch(/GEMINI_API_KEY/);
    expect(bundle).not.toMatch(/CLOUD_BUILD_SERVICE_ACCOUNT/);
    expect(bundle).not.toMatch(/serviceAccount|private_key/);
  });
});
