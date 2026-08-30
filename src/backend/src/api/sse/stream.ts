import type { ProjectEvent } from '@proteus/schema';
import type { FastifyReply } from 'fastify';
import type { Repositories, Subscription } from '../../core/repositories';

/**
 * Server-Sent Events, with resume.
 *
 * The stream is a TAIL, never a source. A client reads state first, then
 * subscribes from the sequence number it already holds; the server replays
 * anything missed and continues live. That ordering is what makes the product's
 * "the browser is not the source of truth" claim real rather than aspirational.
 *
 * Two failure modes this is built against:
 *
 *   GAPS — a naive implementation subscribes first and replays second, and loses
 *   anything written in between. Here the live tail is opened BEFORE the replay
 *   query runs, and events arriving during replay are buffered, so the seam is
 *   covered from both sides.
 *
 *   DUPLICATES — the buffer and the replay can overlap. Every frame passes
 *   through a monotonic `seq` filter, so a client can never be sent the same
 *   event twice, regardless of which path delivered it.
 */

/** Intermediaries close a quiet connection; a comment costs nothing and resets that. */
const HEARTBEAT_MS = 15_000;

export interface StreamHandle {
  close: () => Promise<void>;
}

export async function openEventStream(
  repos: Repositories,
  reply: FastifyReply,
  projectId: string,
  fromSeq: number,
): Promise<StreamHandle> {
  /**
   * Written on the raw socket, so CORS has to be carried across by hand.
   *
   * `reply.raw.writeHead` bypasses Fastify's reply lifecycle entirely — which is
   * the point, because the handler owns this socket for the life of the run.
   * The cost is that `@fastify/cors`'s `onSend` hook never runs, so the response
   * went out with no `Access-Control-Allow-Origin` and every browser dropped it.
   *
   * The failure looked like a server that never sent anything: the preflight
   * passed, the request reached the handler, the events were written, and the
   * browser discarded the whole response. Only the live feed was affected —
   * every other endpoint goes through the normal reply path.
   *
   * The header is copied from what `cors` already decided for this request
   * rather than recomputed, so there is one allowlist and not two.
   */
  const allowOrigin = reply.getHeader('access-control-allow-origin');
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Proxies that buffer would defeat the point of a stream.
    'X-Accel-Buffering': 'no',
  };
  if (allowOrigin !== undefined) {
    headers['Access-Control-Allow-Origin'] = String(allowOrigin);
    const vary = reply.getHeader('vary');
    if (vary !== undefined) headers['Vary'] = String(vary);
    const credentials = reply.getHeader('access-control-allow-credentials');
    if (credentials !== undefined) headers['Access-Control-Allow-Credentials'] = String(credentials);
  }

  reply.raw.writeHead(200, headers);

  let lastSent = fromSeq;
  let closed = false;

  const send = (event: ProjectEvent): void => {
    // The monotonic guard. Nothing older than what the client has can pass,
    // whether it came from the replay or the live tail.
    if (closed || event.seq <= lastSent) return;
    lastSent = event.seq;
    reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  // Open the tail first, buffer what it yields, then replay. Subscribing after
  // the replay would drop anything written during it.
  const buffered: ProjectEvent[] = [];
  let replaying = true;
  const stream: Subscription = repos.events.watch(projectId, (e) => {
    if (replaying) buffered.push(e);
    else send(e);
  });

  const missed = await repos.events.since(projectId, fromSeq);
  for (const e of missed) send(e);

  replaying = false;
  for (const e of buffered.sort((a, b) => a.seq - b.seq)) send(e);

  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    await stream.close().catch(() => undefined);
    reply.raw.end();
  };

  reply.raw.on('close', () => void close());
  return { close };
}

/**
 * Where to resume from.
 *
 * `Last-Event-ID` is set by the browser automatically on reconnect, so a dropped
 * connection recovers without the client tracking anything. An explicit
 * `?fromSeq=` is for a client that has just read state and knows its cursor.
 */
export function resumePoint(headers: Record<string, unknown>, query: unknown): number {
  const header = headers['last-event-id'];
  const fromHeader = Number(Array.isArray(header) ? header[0] : header);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;

  const q = (query as { fromSeq?: string } | undefined)?.fromSeq;
  const fromQuery = Number(q);
  return Number.isFinite(fromQuery) && fromQuery >= 0 ? fromQuery : 0;
}
