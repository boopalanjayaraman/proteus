import type {
  Evidence, GraphEdge, GraphNode, GraphStyle, Project, ProjectEvent, User,
} from '@proteus/schema';

/**
 * The typed API client.
 *
 * Response types come from `@proteus/schema` — the same definitions the backend
 * validates against and Mongo stores — so a shape change is a compile error here
 * rather than a runtime surprise during a demo.
 */

export class ApiClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string,
              readonly requestId?: string) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** Supplies a currently-valid ID token. Firebase refreshes it under the hood. */
export type TokenSource = () => Promise<string | null>;

export class ApiClient {
  constructor(private readonly baseUrl: string, private readonly token: TokenSource) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Fetched per call rather than held: Firebase ID tokens expire hourly, and a
    // cached one turns into a 401 halfway through a long migration.
    const token = await this.token();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { error?: { code: string; message: string; requestId: string } }
        | null;
      throw new ApiClientError(
        res.status,
        body?.error?.code ?? 'UNKNOWN',
        body?.error?.message ?? res.statusText,
        body?.error?.requestId,
      );
    }
    return (await res.json()) as T;
  }

  me = () => this.request<User>('/me');

  updatePreferences = (prefs: Partial<User['preferences']>) =>
    this.request<User>('/me/preferences', { method: 'PATCH', body: JSON.stringify(prefs) });

  project = (projectId: string) => this.request<Project>(`/projects/${projectId}`);

  /** The landing list. One call — `summary` is the tile, `rail` is derived server-side. */
  projects = () =>
    this.request<{
      count: number;
      awaitingApproval: number;
      needsHumanAction: number;
      projects: Array<Project & { rail: number }>;
    }>('/projects');

  requiredScopes = () => this.request<{ scopes: string[] }>('/projects/required-scopes');

  /**
   * Creates a project. The token is sent once and never comes back — the
   * response carries only a display prefix and a status.
   */
  createProject = (body: {
    name: string;
    repositoryUrl: string;
    githubToken: string;
    instructions?: string;
    files?: Array<{ kind: string; originalName: string; mimeType: string; contentBase64: string }>;
  }) => this.request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) });

  events = (projectId: string, opts: { fromSeq?: number; level?: string[] } = {}) => {
    const q = new URLSearchParams();
    if (opts.fromSeq !== undefined) q.set('fromSeq', String(opts.fromSeq));
    if (opts.level?.length) q.set('level', opts.level.join(','));
    return this.request<{ events: ProjectEvent[]; count: number }>(
      `/projects/${projectId}/events${q.size ? `?${q}` : ''}`,
    );
  };

  /** Nodes and edges in reveal order, plus the version a client compares against. */
  graph = (projectId: string) =>
    this.request<{
      projectId: string; graphVersion: number; nodes: GraphNode[]; edges: GraphEdge[];
    }>(`/projects/${projectId}/graph`);

  /** The inspector's chips, fetched for one node at a time. */
  evidence = (projectId: string, ids: string[]) =>
    ids.length === 0
      ? Promise.resolve({ evidence: [] as Evidence[] })
      : this.request<{ evidence: Evidence[] }>(
          `/projects/${projectId}/evidence?ids=${encodeURIComponent(ids.join(','))}`,
        );

  blastRadius = (projectId: string, nodeId: string) =>
    this.request<{ nodeId: string; upstream: string[] }>(
      `/projects/${projectId}/graph/nodes/${encodeURIComponent(nodeId)}/blast-radius`,
    );

  /** A deliberate placement, scoped to the style it was made in. `null` clears it. */
  pinNode = async (
    projectId: string, nodeId: string,
    pin: { x: number; y: number; style: GraphStyle } | null,
  ) => {
    const token = await this.token();
    await fetch(
      `${this.baseUrl}/projects/${projectId}/graph/nodes/${encodeURIComponent(nodeId)}/pin`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(pin),
      },
    );
  };

  streamUrl = (projectId: string) => `${this.baseUrl}/projects/${projectId}/stream`;
}
