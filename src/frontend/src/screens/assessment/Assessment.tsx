import type { Artifact, Assessment as AssessmentDoc, Finding, PlanItem, Project, Recommendation } from '@proteus/schema';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../app/AuthContext';
import { ApiClientError } from '../../api/client';
import { ApproveModal } from '../../components/approval/ApproveModal';
import { FindingCard } from '../../components/findings/FindingCard';
import { approvalErrorMessage, approvalRequest, approvalSubtitle, scopeOf, approvalAvailability,
} from '../../lib/approval';
import { mix } from '../../lib/impact';

/**
 * Screen 3 — assessment and migration decision.
 *
 * The four questions of spec §14, answered in one page: what exists, what is
 * vulnerable, what the agent proposes to change, and what it will not. The last
 * is the reason the recommendations panel is not a footnote — an item outside
 * the autonomy boundary with an owner and an action is a result, not an
 * omission.
 */

const MODE_COLOR: Record<string, string> = {
  AUTONOMOUS_MIGRATION: 'var(--bad)',
  AUTONOMOUS_UPDATE: 'var(--bad)',
  AUTONOMOUS_GENERATION: 'var(--bad)',
  TEST_ENVIRONMENT_ADAPTATION: 'var(--warn)',
  ASSISTED_MIGRATION: 'var(--warn)',
  NO_AUTONOMOUS_CHANGE: 'var(--vio)',
};

const RECOMMENDATION_COLOR: Record<string, string> = {
  HUMAN_DECISION: 'var(--vio)',
  HARDWARE_REPLACEMENT: 'var(--warn)',
  VENDOR_DECISION: 'var(--vio)',
  FOLLOW_ON_WORKSTREAM: 'var(--acc)',
};

interface Data {
  assessment: AssessmentDoc;
  findings: Finding[];
  recommendations: Recommendation[];
  versions: Array<{ version: number; status: string }>;
}

export function Assessment() {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();
  const navigate = useNavigate();

  const [data, setData] = useState<Data | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [assessment, p, a] = await Promise.all([
        api.assessment(id), api.project(id), api.artifacts(id).catch(() => ({ artifacts: [] })),
      ]);
      setData(assessment as Data);
      setProject(p);
      setArtifacts(a.artifacts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, id]);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <div className="placeholder">
        <h2>No assessment yet</h2>
        <p className="sub">{error}</p>
        <p className="sub">
          An assessment is generated when discovery completes. If discovery has finished
          and this is still empty, regenerate it below.
        </p>
        <button
          className="primary compact"
          disabled={busy || !id}
          onClick={async () => {
            setBusy(true);
            try { await api.regenerateAssessment(id!); await load(); }
            catch (e) { setError((e as Error).message); }
            finally { setBusy(false); }
          }}
        >
          {busy ? 'Generating…' : 'Generate assessment'}
        </button>
      </div>
    );
  }
  if (!data) return <div className="label">Loading assessment…</div>;

  const { assessment, findings, recommendations } = data;
  const scope = scopeOf(assessment);
  // The migration is always a human decision, so the bar follows the assessment
  // rather than a single stage value (see `approvalAvailability`).
  const approval = project
    ? approvalAvailability(project, assessment)
    : { offer: false, enabled: false };
  const autonomousItems = scope.autonomous;
  const report = artifacts.find((a) => a.kind === 'ASSESSMENT_REPORT');

  /**
   * The one call that turns a read-only analyser into an agent with write access.
   *
   * On success the project has moved to MIGRATING and a run exists, so the
   * screen hands over rather than trying to render a state it no longer owns.
   */
  const approve = async () => {
    if (!id) return;
    setApproving(true);
    setApprovalError(null);
    try {
      await api.approveMigration(id, approvalRequest(assessment));
      setConfirming(false);
      navigate(`/projects/${id}/migration`);
    } catch (e) {
      const err = e as ApiClientError;
      setApprovalError(approvalErrorMessage(err.status, err.message));
      // A refusal usually means the screen is behind the server. Reloading is
      // what makes the next attempt meaningful rather than a repeat.
      if (err.status === 409) await load();
    } finally {
      setApproving(false);
    }
  };

  const stats = [
    { value: findings.length, label: 'FINDINGS', fg: 'var(--fg)' },
    { value: autonomousItems.length, label: 'AUTONOMOUS ITEMS', fg: 'var(--acc)' },
    { value: recommendations.length, label: 'RECOMMENDATIONS', fg: 'var(--warn)' },
    { value: project?.stage === 'AWAITING_APPROVAL' ? 1 : 0, label: 'HUMAN APPROVAL', fg: 'var(--ok)' },
  ];

  return (
    <div className="assessment">
      <div className="assessment-main">
        <header className="assessment-head">
          <div>
            <h1>Assessment &amp; migration decision</h1>
            <p className="sub">
              {findings.length} findings · evidence attributed ·{' '}
              {autonomousItems.length === 1
                ? '1 unambiguous autonomous migration scenario'
                : `${autonomousItems.length} autonomous plan items`}
            </p>
          </div>
          {report && (
            <button
              className="ghost assessment-download"
              onClick={() => void api.download(id!, report)}
            >
              ↓ Download assessment report
            </button>
          )}
        </header>

        <div className="assessment-stats">
          {stats.map((s) => (
            <div key={s.label} className="assessment-stat">
              <div className="assessment-stat-value" style={{ color: s.fg }}>{s.value}</div>
              <div className="mono assessment-stat-label">{s.label}</div>
            </div>
          ))}
        </div>

        {/* The four questions, above the detail — a reader who stops here still
            knows where the boundary is. */}
        <section className="summary-card">
          <div className="mono summary-label">ASSESSMENT SUMMARY</div>
          <p className="summary-headline">{assessment.summary.headline}</p>
          <dl className="summary-grid">
            <div><dt className="mono">WHAT EXISTS</dt><dd>{assessment.summary.whatExists}</dd></div>
            <div><dt className="mono">WHAT IS VULNERABLE</dt><dd>{assessment.summary.whatIsVulnerable}</dd></div>
            <div><dt className="mono">WILL CHANGE</dt><dd>{assessment.summary.whatAgentWillChange}</dd></div>
            <div><dt className="mono">WILL NOT CHANGE</dt><dd>{assessment.summary.whatAgentWillNotChange}</dd></div>
          </dl>
        </section>

        <div className="mono assessment-section">FINDINGS &amp; PROPOSED DISPOSITION</div>
        <div className="findings">
          {findings.map((f) => <FindingCard key={f.findingId} projectId={id!} finding={f} />)}
        </div>
      </div>

      <aside className="assessment-side">
        <section className="panel">
          <div className="mono panel-label acc">PROPOSED MIGRATION PLAN</div>
          {assessment.planItems.length === 0 && (
            <div className="mono panel-empty">
              Nothing in this repository is inside the autonomy boundary.
            </div>
          )}
          {assessment.planItems.map((p: PlanItem) => (
            <div key={p.planItemId} className="plan-item">
              <div className="plan-item-top">
                <span className="plan-dot" style={{ background: MODE_COLOR[p.mode] }} />
                <span className="plan-target">{p.targetName}</span>
              </div>
              <div className="mono plan-mode" style={{ color: MODE_COLOR[p.mode] }}>
                {p.mode.replace(/_/g, ' ')}
              </div>
              <div className="plan-what">{p.action}</div>
              {/* The autonomy contract — what verification will hold it to. */}
              {p.expectedChanges.length > 0 && (
                <div className="mono plan-scope">
                  {p.expectedChanges.map((c) => `${c.changeType}: ${c.paths.join(', ')}`).join(' · ')}
                </div>
              )}
              {p.conditions.map((c) => (
                <div key={c} className="mono plan-condition">ONLY IF · {c}</div>
              ))}
            </div>
          ))}
          <div className="mono panel-note">
            ONE APPROVAL AUTHORIZES ROUTINE ENGINEERING
          </div>
        </section>

        <section className="panel">
          <div className="mono panel-label warn">RECOMMENDATIONS</div>
          <p className="panel-sub">
            Outside the autonomous boundary — the agent will not modify these. Each
            carries a recommended action and an owner.
          </p>
          {recommendations.length === 0 && (
            <div className="mono panel-empty">
              Nothing fell outside the boundary in a way that needs a human owner.
            </div>
          )}
          {recommendations.map((r) => {
            const colour = RECOMMENDATION_COLOR[r.disposition] ?? 'var(--acc)';
            return (
              <div key={r.recommendationId} className="rec" style={{ borderLeftColor: colour }}>
                <div className="rec-top">
                  <span className="rec-name">{r.name}</span>
                  <span
                    className="mono rec-disposition"
                    style={{ background: mix(colour, 13), color: colour }}
                  >
                    {r.disposition.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="rec-action">{r.action}</div>
                <div className="rec-owner">
                  <span className="mono rec-owner-label">OWNER</span>
                  <span className="mono rec-owner-value">{r.owner}</span>
                </div>
                <div className="mono rec-source">{r.sourceCitation}</div>
              </div>
            );
          })}
        </section>

        {data.versions.length > 1 && (
          <section className="panel">
            <div className="mono panel-label">VERSIONS</div>
            <p className="panel-sub">
              Assessments are immutable. Regenerating writes a new version and leaves
              the approved one intact.
            </p>
            {data.versions.map((v) => (
              <div key={v.version} className="mono version-row">
                v{v.version} · {v.status}
              </div>
            ))}
          </section>
        )}
      </aside>

      {approval.offer && (
        <div className="approve-bar">
          <div>
            <div className="approve-title">Approve the proposed migration scope</div>
            <div className="mono approve-sub">
              {approvalSubtitle(assessment, recommendations.length)}
            </div>
          </div>
          <button
            className="primary compact"
            disabled={!approval.enabled}
            title={approval.reason}
            onClick={() => { setApprovalError(null); setConfirming(true); }}
          >
            Approve migration →
          </button>
        </div>
      )}

      {/* Already authorised: the bar becomes the record of what was authorised,
          which is the thing a reviewer needs after the fact. */}
      {project && project.summary.migrationApproved && project.stage !== 'AWAITING_APPROVAL' && (
        <div className="approve-bar approved">
          <div>
            <div className="approve-title">
              Migration approved — {autonomousItems.length} plan item
              {autonomousItems.length === 1 ? '' : 's'} authorised
            </div>
            <div className="mono approve-sub">
              ASSESSMENT V{assessment.version} · APPROVED SCOPE RECORDED TO AUDIT TRAIL
            </div>
          </div>
          <button className="ghost" onClick={() => navigate(`/projects/${id}/migration`)}>
            View migration →
          </button>
        </div>
      )}

      {confirming && (
        <ApproveModal
          assessment={assessment}
          busy={approving}
          error={approvalError}
          onConfirm={() => void approve()}
          // FR-10: dismissing the dialog makes no request and leaves the project
          // exactly where it was.
          onCancel={() => { if (!approving) { setConfirming(false); setApprovalError(null); } }}
        />
      )}
    </div>
  );
}
