import type {
  ApproveMigrationInput, Artifact, Assessment, Baseline, Evidence, ExecutionRun, Finding,
  GraphEdge, GraphNode, GraphStyle, HumanGate, MigrationAttempt, MigrationChange,
  MigrationRun, Project, ProjectEvent, Recommendation, SandboxDeployment, User,
  VerificationResult,
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

  /**
   * The whole assessment screen in one call. Findings, plan and recommendations
   * arrive together because the screen means nothing with any one missing.
   */
  assessment = (projectId: string, version?: number) =>
    this.request<{
      assessment: Assessment;
      findings: Finding[];
      recommendations: Recommendation[];
      versions: Array<{ version: number; status: string; generatedAt: string }>;
    }>(`/projects/${projectId}/assessment${version ? `?version=${version}` : ''}`);

  /** Regeneration produces version N+1; it never edits what was on screen. */
  regenerateAssessment = (projectId: string) =>
    this.request<{ status: string }>(`/projects/${projectId}/assessment`, { method: 'POST', body: '{}' });

  /**
   * Authorises the migration.
   *
   * The body pins the assessment version and echoes the disclosure the modal
   * showed. Both are checked server-side: approving a superseded assessment or a
   * disclosure that is not the current one is refused rather than upgraded.
   */
  approveMigration = (projectId: string, body: ApproveMigrationInput) =>
    this.request<{
      migrationRunId: string; branch: string; approvedPlanItemIds: string[];
      approvedAt: string; gateId?: string; created: boolean;
    }>(`/projects/${projectId}/migration/approve`, {
      method: 'POST', body: JSON.stringify(body),
    });

  /** Every gate this project has raised. The approval is the first of them. */
  gates = (projectId: string) =>
    this.request<{ count: number; open: number; gates: HumanGate[] }>(
      `/projects/${projectId}/gates`,
    );

  /** 404 until a human approves — before that there is no branch and no run. */
  migration = (projectId: string) =>
    this.request<{ run: MigrationRun }>(`/projects/${projectId}/migration`);

  /** The behavioural contract, with the executions that established it. */
  baseline = (projectId: string) =>
    this.request<{ baseline: Baseline; executions: ExecutionRun[] }>(
      `/projects/${projectId}/baseline`,
    );

  /** What the agent has changed on the branch, newest first. */
  changes = (projectId: string) =>
    this.request<{ count: number; changes: MigrationChange[] }>(
      `/projects/${projectId}/changes`,
    );

  /**
   * The attempt history and the retry counters.
   *
   * `problems` is per problem rather than per run: the `n / 4` the screen shows
   * is a budget against one unresolved problem, and a run-level count would say
   * something else entirely.
   */
  attempts = (projectId: string) =>
    this.request<{
      count: number;
      attempts: MigrationAttempt[];
      problems: Array<{
        problemKey: string; classification: string; signature: string;
        meaningfulAttempts: number; budget: number; status: string;
      }>;
    }>(`/projects/${projectId}/migration/attempts`);

  /**
   * The verdict, with each check's provenance and the narrative assertions.
   *
   * `cryptoAssertions` comes back separate from `checks` because it carries a
   * NOTED state the nine gating checks do not, and conflating them is how a
   * screen ends up implying a noted residual is a failure.
   */
  verification = (projectId: string) =>
    this.request<{ result: VerificationResult; executions: ExecutionRun[] }>(
      `/projects/${projectId}/verification`,
    );

  /** 404 until one is deployed, which requires the other checks to pass. */
  sandbox = (projectId: string) =>
    this.request<{ sandbox: SandboxDeployment }>(`/projects/${projectId}/sandbox`);

  artifacts = (projectId: string) =>
    this.request<{ artifacts: Artifact[] }>(`/projects/${projectId}/artifacts`);

  /** The download URL. Authenticated, so the click goes through `download`. */
  artifactUrl = (projectId: string, artifactId: string) =>
    `${this.baseUrl}/projects/${projectId}/artifacts/${artifactId}`;

  /**
   * Fetches an artifact and hands it to the browser as a file.
   *
   * A plain link cannot carry the Authorization header, and putting a token in
   * a query string would put it in logs and history.
   */
  download = async (projectId: string, artifact: Artifact): Promise<void> => {
    const token = await this.token();
    const res = await fetch(this.artifactUrl(projectId, artifact.artifactId), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiClientError(res.status, 'DOWNLOAD_FAILED', res.statusText);

    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${artifact.title.replace(/[^\w.-]+/g, '-')}.`
      + (artifact.format === 'MARKDOWN' ? 'md' : artifact.format.toLowerCase());
    a.click();
    URL.revokeObjectURL(url);
  };

  streamUrl = (projectId: string) => `${this.baseUrl}/projects/${projectId}/stream`;
}
