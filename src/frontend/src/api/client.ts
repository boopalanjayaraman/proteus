import type {
  ApproveMigrationInput, Artifact, Assessment, Baseline, Evidence, ExecutionRun, Finding,
  GraphEdge, GraphNode, GraphStyle, HumanGate, MigrationAttempt, MigrationChange,
  MigrationRun, Project, ProjectEvent, Recommendation, SandboxDeployment, Screen, User,
  UserActivity, VerificationResult,
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

  /**
   * The screen the user is on, sent with every call as `x-proteus-screen`.
   *
   * Set once by the router. The backend records a page visit from the first call
   * a screen makes rather than from a beacon, so this header is the whole
   * mechanism — which is also why it lives at the one fetch wrapper every call
   * goes through, where no screen can forget to send it. Validated server-side
   * against a closed set of six; anything else is dropped, not stored.
   */
  screen: Screen | undefined;

  private async headers(init: RequestInit = {}): Promise<Record<string, string>> {
    // Fetched per call rather than held: Firebase ID tokens expire hourly, and a
    // cached one turns into a 401 halfway through a long migration.
    const token = await this.token();
    return {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(this.screen ? { 'x-proteus-screen': this.screen } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: await this.headers(init),
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
   * Edits a project. The repository URL is not editable — that is a new project.
   *
   * `githubToken` omitted leaves the stored credential alone; supplied, it adds
   * a new secret version.
   */
  updateProject = (projectId: string, body: {
    name?: string; defaultBranch?: string; instructions?: string; githubToken?: string;
  }) => this.request<Project>(`/projects/${projectId}`, {
    method: 'PATCH', body: JSON.stringify(body),
  });

  /** Attaches one more context file to an existing project. */
  uploadFile = (projectId: string, file: {
    kind: string; originalName: string; mimeType: string; contentBase64: string;
  }) => this.request<unknown>(`/projects/${projectId}/files`, {
    method: 'POST', body: JSON.stringify(file),
  });

  /** Runs discovery again over the edited context. */
  rediscover = (projectId: string) =>
    this.request<{ status: string }>(`/projects/${projectId}/rediscover`, {
      method: 'POST', body: '{}',
    });

  /** Ends a run that will not finish. Nothing is rolled back. */
  stopMigration = (projectId: string) =>
    this.request<{ stopped: number }>(`/projects/${projectId}/migration/stop`, {
      method: 'POST', body: '{}',
    });

  /**
   * Archives a project. Irreversible, so the id is typed rather than clicked.
   */
  archiveProject = (projectId: string) =>
    this.request<Project>(`/projects/${projectId}/archive`, {
      method: 'POST', body: JSON.stringify({ confirm: projectId }),
    });

  /** What a delete would do. Platform admin only; changes nothing. */
  deletionPreview = (projectId: string) =>
    this.request<{
      projectId: string; lifecycle: string; totalRows: number;
      rows: Array<{ collection: string; count: number }>;
      sandbox: { present: boolean; url?: string };
      credential: { present: boolean };
    }>(`/projects/${projectId}/deletion-preview`);

  /** Soft delete. Platform admin only. */
  deleteProject = async (projectId: string): Promise<void> => {
    const body = JSON.stringify({ confirm: projectId });
    const res = await fetch(`${this.baseUrl}/projects/${projectId}`, {
      method: 'DELETE', headers: await this.headers({ body }), body,
    });
    if (!res.ok) {
      const parsed = (await res.json().catch(() => null)) as
        | { error?: { code: string; message: string } } | null;
      throw new ApiClientError(
        res.status, parsed?.error?.code ?? 'UNKNOWN',
        parsed?.error?.message ?? res.statusText,
      );
    }
  };

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
    const body = JSON.stringify(pin);
    await fetch(
      `${this.baseUrl}/projects/${projectId}/graph/nodes/${encodeURIComponent(nodeId)}/pin`,
      { method: 'PATCH', headers: await this.headers({ body }), body },
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

  /**
   * Runs the approved migration again, from the same scope.
   *
   * Not a re-approval — discovery and assessment are not repeated, and the
   * original authorisation is carried forward.
   */
  retryMigration = (projectId: string) =>
    this.request<{ migrationRunId: string; approvedPlanItemIds: string[]; status: string }>(
      `/projects/${projectId}/migration/retry`,
      { method: 'POST', body: '{}' },
    );

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

  /**
   * Extends the sandbox and records that it was opened.
   *
   * Called when a user follows the link, which is the "inactivity" clock: a
   * sandbox under review stays up, a forgotten one does not.
   */
  extendSandbox = (projectId: string) =>
    this.request<{
      expiresAt: string; hardExpiresAt?: string; extended: boolean; atCeiling: boolean;
    }>(`/projects/${projectId}/sandbox/extend`, { method: 'POST', body: '{}' });

  /** Frees a slot without waiting for expiry. */
  tearDownSandbox = async (projectId: string): Promise<void> => {
    await fetch(`${this.baseUrl}/projects/${projectId}/sandbox`, {
      method: 'DELETE',
      headers: await this.headers(),
    });
  };

  /** What is used and what is free, so the screen can say so before a run. */
  sandboxCapacity = () =>
    this.request<{
      configured: boolean; perUserUsed?: number; perUserLimit?: number;
      totalUsed?: number; totalLimit?: number; canRetain?: boolean;
      boundBy?: 'USER' | 'PLATFORM'; ownProjects?: string[]; nextExpiryAt?: string;
    }>('/sandbox/capacity');

  /** Carried forward from the assessment; the completion screen re-reads them. */
  recommendations = (projectId: string) =>
    this.request<{ count: number; recommendations: Recommendation[] }>(
      `/projects/${projectId}/recommendations`,
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
    const res = await fetch(this.artifactUrl(projectId, artifact.artifactId), {
      headers: await this.headers(),
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

  /**
   * A page of activity, newest first.
   *
   * `userId` is honoured only for a platform admin — a non-admin who sends it
   * gets their own activity back rather than an error, because there is nothing
   * to refuse and a 403 would confirm the filter means something.
   */
  activity = (params: {
    category?: string; projectId?: string; outcome?: string; userId?: string;
    from?: string; to?: string; q?: string; cursor?: string; limit?: number;
    includeNavigation?: boolean;
  } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '' && v !== false) qs.set(k, String(v));
    }
    return this.request<{
      scope: 'ALL' | 'SELF' | 'USER';
      isAdmin: boolean;
      count: number;
      entries: Array<UserActivity & { atUtc: string }>;
      nextCursor?: string;
    }>(`/activity${qs.size ? `?${qs}` : ''}`);
  };

  /** Who has activity. One entry — the caller — unless they are an admin. */
  activityUsers = () =>
    this.request<{ users: Array<{ userId: string; userEmail: string; lastAt: string | null }> }>(
      '/activity/users',
    );
}
