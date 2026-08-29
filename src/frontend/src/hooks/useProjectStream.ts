import type { ProjectEvent } from '@proteus/schema';
import { useEffect, useRef, useState } from 'react';
import { EventStream, type StreamStatus } from '../api/stream';
import { useAuth } from '../app/AuthContext';
import { currentToken } from '../lib/firebase';

/**
 * The live feed for one project.
 *
 * History is fetched first and the stream resumes from the last seq it carried,
 * so a refresh mid-discovery shows the same feed it showed a second earlier —
 * the screen has no memory of its own and needs none.
 */
export function useProjectStream(projectId: string | undefined, opts: { limit?: number } = {}) {
  const { api } = useAuth();
  const limit = opts.limit ?? 300;
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [ready, setReady] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!projectId) return;
    let stream: EventStream | null = null;
    let cancelled = false;
    seen.current = new Set();

    void (async () => {
      let fromSeq = 0;
      try {
        const history = await api.events(projectId);
        if (cancelled) return;
        for (const e of history.events) seen.current.add(e.eventId);
        setEvents(history.events.slice(-limit));
        fromSeq = history.events.at(-1)?.seq ?? 0;
      } catch {
        // A failed history load is not fatal — the stream still delivers what
        // happens from here, which is what a user watching a live run wants.
      }
      if (cancelled) return;
      setReady(true);

      stream = new EventStream({
        url: api.streamUrl(projectId),
        token: currentToken,
        fromSeq,
        onStatus: setStatus,
        onEvent: (event) => {
          // The stream guards by seq and so does the server; this guards by id,
          // because a duplicated row in a live feed is the most visible bug there is.
          if (seen.current.has(event.eventId)) return;
          seen.current.add(event.eventId);
          setEvents((prev) => [...prev, event].slice(-limit));
        },
      });
      stream.start();
    })();

    return () => { cancelled = true; stream?.stop(); };
  }, [projectId, api, limit]);

  return { events, status, ready };
}
