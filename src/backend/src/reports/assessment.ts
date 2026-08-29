import type {
  Assessment, Evidence, Finding, GraphEdge, GraphNode, Project,
  ProjectFile, Recommendation,
} from '@proteus/schema';

/**
 * The assessment report (spec §19).
 *
 * Rendered from a structured snapshot rather than from live collections, so the
 * download a user keeps says the same thing next year that it said on screen.
 * The snapshot is stored on the artifact; this function is a pure transform of
 * it, which is what makes the output reproducible and diffable.
 */

/** Everything the report renders. Stored verbatim as `artifact.contentSnapshot`. */
export interface AssessmentReportSnapshot {
  generatedAt: string;
  project: {
    projectId: string; name: string; stage: string;
    repositoryUrl: string; defaultBranch: string; commitSha: string;
  };
  inputs: Array<{ name: string; kind: string; sizeBytes: number }>;
  summary: Assessment['summary'];
  findings: Array<{
    findingId: string; category: string; severity: string; title: string;
    summaryLine: string; description: string; disposition: string; agentIntent: string;
    crypto?: { algorithm: string; usage: string; proposedTarget?: string; quantumVulnerable: boolean };
    locations: string[];
    evidence: Array<{ evidenceClass: string; evidenceType: string; source: string; confidence: number }>;
  }>;
  relationships: Array<{ from: string; relationship: string; to: string; evidenceClass: string }>;
  planItems: Assessment['planItems'];
  scope: { autonomous: string[]; excluded: string[] };
  blockers: Array<{ title: string; kind: string; detail: string }>;
  hardware: Array<{ title: string; disposition: string; source: string }>;
  recommendations: Array<{
    name: string; disposition: string; action: string; owner: string; sourceCitation: string;
  }>;
}

const AUTONOMOUS = new Set([
  'AUTONOMOUS_MIGRATION', 'AUTONOMOUS_UPDATE', 'AUTONOMOUS_GENERATION',
  'TEST_ENVIRONMENT_ADAPTATION',
]);

const HARDWARE_TYPES = new Set([
  'HSM', 'SECURE_ELEMENT', 'OT_DEVICE', 'IOT_DEVICE', 'SECURITY_APPLIANCE',
  'VENDOR_DEPENDENCY',
]);

const locationLine = (l: Finding['locations'][number]): string =>
  `${l.path ?? l.component ?? '?'}${l.startLine ? `:${l.startLine}` : ''}`;

export function buildSnapshot(input: {
  project: Project;
  assessment: Assessment;
  findings: Finding[];
  evidence: Evidence[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  recommendations: Recommendation[];
  files: ProjectFile[];
}): AssessmentReportSnapshot {
  const { assessment } = input;
  const evidenceById = new Map(input.evidence.map((e) => [e.evidenceId, e]));
  const nodeName = (id: string) => input.nodes.find((n) => n.nodeId === id)?.name ?? id;
  const hardwareNodeIds = new Set(
    input.nodes.filter((n) => HARDWARE_TYPES.has(n.type)).map((n) => n.nodeId),
  );

  return {
    generatedAt: assessment.generatedAt.toISOString(),
    project: {
      projectId: input.project.projectId,
      name: input.project.name,
      stage: input.project.stage,
      repositoryUrl: input.project.repository.url,
      defaultBranch: input.project.repository.defaultBranch,
      commitSha: assessment.snapshot.repoCommitSha,
    },
    inputs: input.files.map((f) => ({
      name: f.originalName, kind: f.kind, sizeBytes: f.sizeBytes,
    })),
    summary: assessment.summary,
    findings: input.findings.map((f) => ({
      findingId: f.findingId,
      category: f.category, severity: f.severity, title: f.title,
      summaryLine: f.summaryLine, description: f.description,
      disposition: f.disposition, agentIntent: f.agentIntent,
      crypto: f.crypto
        ? {
            algorithm: f.crypto.algorithm, usage: f.crypto.usage,
            proposedTarget: f.crypto.proposedTarget,
            quantumVulnerable: f.crypto.quantumVulnerable,
          }
        : undefined,
      locations: f.locations.map(locationLine),
      evidence: f.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((e): e is Evidence => Boolean(e))
        .map((e) => ({
          evidenceClass: e.evidenceClass, evidenceType: e.evidenceType,
          source: e.source, confidence: e.confidence,
        })),
    })),
    relationships: input.edges.map((e) => ({
      from: nodeName(e.fromNodeId), relationship: e.relationship,
      to: nodeName(e.toNodeId), evidenceClass: e.evidenceClass,
    })),
    planItems: assessment.planItems,
    scope: {
      autonomous: assessment.planItems.filter((p) => AUTONOMOUS.has(p.mode)).map((p) => p.targetName),
      // Not "everything else" — specifically what a disposition put outside the
      // boundary, which is the question a reader of §19 is asking.
      excluded: input.findings
        .filter((f) => f.disposition !== 'AUTONOMOUS_MIGRATION' && f.disposition !== 'ASSISTED_MIGRATION')
        .map((f) => `${f.title} (${f.disposition})`),
    },
    blockers: input.findings
      .filter((f) => f.blocker)
      .map((f) => ({ title: f.title, kind: f.blocker!.kind, detail: f.blocker!.detail })),
    hardware: input.findings
      .filter((f) => f.nodeIds.some((id) => hardwareNodeIds.has(id)))
      .map((f) => ({
        title: f.title, disposition: f.disposition,
        source: f.locations.map(locationLine).join(', ') || (f.primaryEvidenceId
          ? evidenceById.get(f.primaryEvidenceId)?.source ?? '' : ''),
      })),
    recommendations: input.recommendations.map((r) => ({
      name: r.name, disposition: r.disposition, action: r.action,
      owner: r.owner, sourceCitation: r.sourceCitation,
    })),
  };
}

const h = (level: number, text: string) => `${'#'.repeat(level)} ${text}\n`;
const none = '_None._\n';

/** Markdown, because it is readable as text and converts to PDF without a renderer. */
export function renderMarkdown(s: AssessmentReportSnapshot): string {
  const out: string[] = [];

  out.push(h(1, `PQC assessment — ${s.project.name}`));
  out.push(`Generated ${s.generatedAt}\n`);

  out.push(h(2, 'Project'));
  out.push(
    `- **Project** ${s.project.projectId} — ${s.project.name}\n`
    + `- **Stage** ${s.project.stage}\n`,
  );

  out.push(h(2, 'Repository'));
  out.push(
    `- **URL** ${s.project.repositoryUrl}\n`
    + `- **Branch** ${s.project.defaultBranch}\n`
    + `- **Commit** ${s.project.commitSha}\n`,
  );

  out.push(h(2, 'Analyzed inputs'));
  out.push(s.inputs.length === 0
    ? 'Repository only — no supporting documents were supplied.\n'
    : s.inputs.map((f) => `- ${f.name} (${f.kind}, ${f.sizeBytes} bytes)`).join('\n') + '\n');

  out.push(h(2, 'Summary'));
  out.push(
    `${s.summary.headline}\n\n`
    + `**What exists** — ${s.summary.whatExists}\n\n`
    + `**What is vulnerable** — ${s.summary.whatIsVulnerable}\n\n`
    + `**What the agent will change** — ${s.summary.whatAgentWillChange}\n\n`
    + `**What the agent will not change** — ${s.summary.whatAgentWillNotChange}\n`,
  );

  out.push(h(2, 'Findings'));
  if (s.findings.length === 0) out.push(none);
  for (const f of s.findings) {
    out.push(h(3, `${f.title}`));
    out.push(
      `**${f.severity}** · ${f.category} · disposition **${f.disposition.replace(/_/g, ' ')}**\n\n`
      + `${f.summaryLine}\n\n${f.description}\n\n`
      + (f.crypto
        ? `- **Algorithm** ${f.crypto.algorithm} used for ${f.crypto.usage}`
          + `${f.crypto.quantumVulnerable ? ' — quantum-vulnerable' : ''}\n`
          + (f.crypto.proposedTarget ? `- **Proposed target** ${f.crypto.proposedTarget}\n` : '')
        : '')
      + (f.locations.length ? `- **Location** ${f.locations.join(', ')}\n` : '')
      + `\n**Agent intent** — ${f.agentIntent}\n`,
    );
    // Evidence is a sub-section rather than a footnote: §16 requires every
    // finding to retain its source, and a report that buries it fails that.
    out.push(h(4, 'Evidence'));
    out.push(f.evidence.length === 0
      ? none
      : f.evidence.map((e) =>
          `- \`${e.evidenceClass}\` ${e.evidenceType} — ${e.source} (confidence ${e.confidence.toFixed(2)})`,
        ).join('\n') + '\n');
  }

  out.push(h(2, 'Dependency relationships'));
  out.push(s.relationships.length === 0
    ? none
    : s.relationships.map((r) =>
        `- ${r.from} → **${r.relationship.replace(/_/g, ' ').toLowerCase()}** → ${r.to}`
        + `${r.evidenceClass === 'INFERRED' ? ' _(inferred)_' : ''}`,
      ).join('\n') + '\n');

  out.push(h(2, 'Proposed migration plan'));
  out.push(s.planItems.length === 0 ? none : '');
  for (const p of s.planItems) {
    out.push(h(3, `${p.targetName} → ${p.mode.replace(/_/g, ' ')}`));
    out.push(
      `${p.action}\n\n${p.rationale}\n\n`
      + `- **Risk** ${p.risk}\n`
      + (p.conditions.length ? `- **Conditions** ${p.conditions.join('; ')}\n` : '')
      + (p.expectedChanges.length
        ? `\n**Expected changes**\n\n${p.expectedChanges
            .map((c) => `- \`${c.changeType}\` ${c.paths.join(', ') || '(paths not constrained)'} — ${c.description}`)
            .join('\n')}\n`
        : ''),
    );
  }

  out.push(h(2, 'Proposed migration scope'));
  out.push(
    h(3, 'In scope, autonomous')
    + (s.scope.autonomous.length ? s.scope.autonomous.map((x) => `- ${x}`).join('\n') + '\n' : none)
    + '\n' + h(3, 'Outside the autonomy boundary')
    + (s.scope.excluded.length ? s.scope.excluded.map((x) => `- ${x}`).join('\n') + '\n' : none),
  );

  out.push(h(2, 'Blockers'));
  out.push(s.blockers.length === 0
    ? none
    : s.blockers.map((b) => `- **${b.kind}** — ${b.title}: ${b.detail}`).join('\n') + '\n');

  out.push(h(2, 'Hardware, OT and IoT findings'));
  out.push(s.hardware.length === 0
    ? none
    : s.hardware.map((x) =>
        `- **${x.title}** — ${x.disposition.replace(/_/g, ' ')}${x.source ? ` (${x.source})` : ''}`,
      ).join('\n') + '\n');

  out.push(h(2, 'Recommendations'));
  out.push(s.recommendations.length === 0 ? none : '');
  for (const r of s.recommendations) {
    out.push(
      `### ${r.name}\n\n`
      + `**${r.disposition.replace(/_/g, ' ')}** · owner: ${r.owner}\n\n`
      + `${r.action}\n\n`
      + `Source: ${r.sourceCitation}\n`,
    );
  }

  return out.join('\n');
}

/** The §19 sections, named. A test asserts the rendered report contains each. */
export const REQUIRED_SECTIONS = [
  'Project', 'Repository', 'Analyzed inputs', 'Findings',
  'Evidence', 'Dependency relationships', 'Proposed migration plan',
  'Proposed migration scope', 'Blockers', 'Hardware, OT and IoT findings',
  'Recommendations',
] as const;
