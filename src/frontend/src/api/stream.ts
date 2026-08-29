import type { ProjectEvent } from '@proteus/schema';

/**
 * The event stream client.
 *
 * `EventSource` cannot send an Authorization header, so this reads the response
 * body directly and reconnects by hand. That is more code than EventSource, and
 * it buys the two things that matter: the request can be authenticated, and the
 * resume cursor is ours to control rather than the browser's.
 *
 * The client tracks `lastSeq` itself and never renders an event at or below it.
 * The server also guards, so a duplicate would have to get past both — which is
 * deliberate: a repeated row in the live feed is the most visible possible bug
 * and the cheapest to prevent twice.
 */

export interface StreamOptions {
  url: string;
  token: () => Promise<string | null>;
  fromSeq: number;
  onEvent: (event: ProjectEvent) => void;
  onStatus?: (status: StreamStatus) => void;
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

export class EventStream {
  private controller: AbortController | null = null;
  private lastSeq: number;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly opts: StreamOptions) {
    this.lastSeq = opts.fromSeq;
  }

  /** The cursor a caller should persist if it wants to resume later. */
  get cursor(): number {
    return this.lastSeq;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.opts.onStatus?.('closed');
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.opts.onStatus?.(this.attempt === 0 ? 'connecting' : 'reconnecting');
    this.controller = new AbortController();

    try {
      const token = await this.opts.token();
      const res = await fetch(this.opts.url, {
        signal: this.controller.signal,
        headers: {
          accept: 'text/event-stream',
          // Resume from where this client got to, not from where the server
          // thinks it did. Set explicitly because fetch does not replay
          // Last-Event-ID the way EventSource does.
          'last-event-id': String(this.lastSeq),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok || !res.body) throw new Error(`stream returned ${res.status}`);

      this.attempt = 0;
      this.opts.onStatus?.('open');
      await this.read(res.body);
    } catch {
      // Any failure is a reconnect, not an error: the whole point is that a
      // dropped connection is invisible to the user.
    }

    if (!this.stopped) {
      this.attempt++;
      const delay = Math.min(BASE_RETRY_MS * 2 ** (this.attempt - 1), MAX_RETRY_MS);
      setTimeout(() => void this.connect(), delay);
    }
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; the last chunk may be partial.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!data) continue; // heartbeat comment
        try {
          const event = JSON.parse(data.slice(6)) as ProjectEvent;
          if (event.seq > this.lastSeq) {
            this.lastSeq = event.seq;
            this.opts.onEvent(event);
          }
        } catch {
          // A truncated frame is not fatal; the next read completes it.
        }
      }
    }
  }
}
