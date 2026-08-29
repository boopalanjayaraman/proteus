import type {
  Artifact, MigrationRun, Project, Recommendation, SandboxDeployment, VerificationResult,
} from '@proteus/schema';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../app/AuthContext';
import { mix } from '../../lib/impact';
import {
  OUTCOME_COLOR, OUTCOME_LABEL, STATUS_COLOR, artifactCards, capacityNotice, checkRows,
  expiryLabel, outcomeTiles, sandboxCard, type CapacityState,
} from '../../lib/migration';

/**
 * Screen 4b — sandbox and report.
 *
 * The last screen, and the one a reviewer who watched none of this actually
 * reads. Two things it must not do: imply the sandbox is production, and let the
 * recommendations disappear because the migration succeeded. Both are structural
 * here — the label comes from `isProduction` and the recommendations come from
 * their own collection, carried forward rather than re-derived.
 */

const DISPOSITION_COLOR: Record<string, string> = {
  HUMAN_DECISION: 'var(--vio)',
  HARDWARE_REPLACEMENT: 'var(--warn)',
  VENDOR_DECISION: 'var(--vio)',
  FOLLOW_ON_WORKSTREAM: 'var(--acc)',
};

export function Completion() {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [run, setRun] = useState<MigrationRun | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [sandbox, setSandbox] = useState<SandboxDeployment | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capacity, setCapacity] = useState<CapacityState>({ configured: false });
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setProject(await api.project(id));
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    await Promise.all([
      api.migration(id).then((m) => setRun(m.run)).catch(() => undefined),
      api.verification(id).then((v) => setVerification(v.result)).catch(() => undefined),
      api.sandbox(id).then((s) => setSandbox(s.sandbox)).catch(() => undefined),
      api.artifacts(id).then((a) => setArtifacts(a.artifacts)).catch(() => undefined),
      api.recommendations(id).then((r) => setRecommendations(r.recommendations))
        .catch(() => undefined),
      api.sandboxCapacity().then(setCapacity).catch(() => undefined),
    ]);
  }, [api, id]);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <div className="placeholder">
        <h2>Nothing to review yet</h2>
        <p className="sub">
          This screen appears once the migration has been verified and its evidence
          package written. {error}
        </p>
      </div>
    );
  }
  if (!project) return <div className="label">Loading…</div>;

  const outcome = run?.outcome ?? (verification?.overall === 'VERIFIED'
    ? 'VERIFIED' : 'HUMAN_ACTION_REQUIRED');
  const card = sandboxCard(sandbox);
  const cards = artifactCards(artifacts);
  const tiles = outcomeTiles({
    autonomy: project.summary.autonomy,
    autonomousRepairs: run?.metrics.autonomousRepairs ?? 0,
    recommendations,
  });
  const rows = verification ? checkRows(verification.checks) : [];

  return (
    <div className="completion">
      <header className="completion-head">
        <div className="completion-badges">
          <span
            className="mono completion-verdict"
            style={{
              background: mix(OUTCOME_COLOR[outcome] ?? 'var(--fg3)', 13),
              color: OUTCOME_COLOR[outcome] ?? 'var(--fg3)',
            }}
          >
            {OUTCOME_LABEL[outcome] ?? outcome}
          </span>
          <span className="mono completion-meta">
            {project.projectId}
            {run?.completedAt && run.startedAt
              ? ` · ${elapsed(run.startedAt, run.completedAt)} END TO END`
              : ''}
          </span>
        </div>
        <h1>{verification?.cryptoAssertions[0]?.label ?? 'Migration complete'}</h1>
        <p className="sub">
          {project.summary.lastActivityText}
        </p>
      </header>

      {(notice || capacityNotice(capacity)) && (
        <div className="mono sandbox-notice">{notice ?? capacityNotice(capacity)}</div>
      )}

      {card && (
        <section className="sandbox-bar">
          <div className="sandbox-bar-main">
            <div className="mono panel-label ok">TESTED SANDBOX APPLICATION</div>
            {card.url && card.ready
              ? <a className="sandbox-url" href={card.url} target="_blank" rel="noreferrer">
                  {card.url}
                </a>
              : <div className="mono panel-empty">{card.status.replace(/_/g, ' ')}</div>}
            {/* From `isProduction`, every time. */}
            <div className="mono sandbox-label">
              {card.label}
              {sandbox?.expiresAt ? ` · ${expiryLabel(sandbox.expiresAt)}` : ''}
            </div>
            {sandbox?.placement === 'LOCAL' && (
              <div className="mono sandbox-line">
                Running locally — verified end to end, but this address is not reachable
                from elsewhere.
              </div>
            )}
            {sandbox?.tornDownReason === 'CAPACITY' && (
              <div className="mono sandbox-line">
                Released because the platform was at its retained-sandbox limit. The
                migration was verified end to end before it was released.
              </div>
            )}
          </div>
          <div className="sandbox-bar-actions">
            {card.url && card.ready && (
              <a
                className="primary compact"
                href={card.url}
                target="_blank"
                rel="noreferrer"
                // Opening it is the access that resets the clock. A sandbox
                // under review stays up; a forgotten one does not.
                onClick={() => { void api.extendSandbox(id!).catch(() => undefined); }}
              >
                Open sandbox app
              </a>
            )}
            <button
              className="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const diff = artifacts.find((a) => a.kind === 'GIT_DIFF');
                if (diff) await api.download(id!, diff).catch(() => undefined);
                setBusy(false);
              }}
            >
              View git diff
            </button>
            {card.ready && (
              <button
                className="ghost"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await api.extendSandbox(id!).catch(() => null);
                  setNotice(r
                    ? r.atCeiling
                      // Said plainly rather than silently capping.
                      ? 'At the maximum lifetime — this sandbox cannot be extended further.'
                      : `Extended. ${expiryLabel(r.expiresAt).toLowerCase()}.`
                    : 'Could not extend this sandbox.');
                  await load();
                  setBusy(false);
                }}
              >
                Extend
              </button>
            )}
            {card.ready && (
              <button
                className="ghost"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await api.tearDownSandbox(id!).catch(() => undefined);
                  setNotice('Sandbox torn down. The slot is free for another migration.');
                  await load();
                  setBusy(false);
                }}
              >
                Tear down
              </button>
            )}
          </div>
        </section>
      )}

      <div className="outcome-tiles">
        {tiles.map((tile) => (
          <div key={tile.label} className="outcome-tile">
            <div className="outcome-value" style={{ color: tile.fg }}>{tile.value}</div>
            <div className="mono outcome-label">{tile.label}</div>
            <div className="outcome-note">{tile.note}</div>
          </div>
        ))}
      </div>

      <div className="completion-body">
        <section className="panel completion-verification">
          <div className="mono panel-label acc">CRYPTO VERIFICATION</div>
          {rows.length === 0 && (
            <div className="mono panel-empty">No verification result yet.</div>
          )}
          {rows.map((r) => (
            <div key={r.check} className="check-row">
              <span className="mono check-glyph" style={{ color: r.colour }}>{r.glyph}</span>
              <div className="check-body">
                <div className="check-label">{r.label}</div>
                <div className="mono check-detail">{r.detail}</div>
              </div>
            </div>
          ))}
          {verification && verification.cryptoAssertions.length > 0 && (
            <>
              <div className="mono panel-label">CRYPTOGRAPHIC ASSERTIONS</div>
              {verification.cryptoAssertions.map((a) => (
                <div key={a.label} className="check-row">
                  <span
                    className="mono check-glyph"
                    style={{ color: STATUS_COLOR[a.status] ?? 'var(--fg3)' }}
                  >
                    {a.status === 'PASS' ? '✓' : a.status === 'NOTED' ? '!' : '✗'}
                  </span>
                  <div className="check-body">
                    <div className="check-label">{a.label}</div>
                    <div className="mono check-detail">{a.evidence}</div>
                  </div>
                  {a.status === 'NOTED' && <span className="mono check-noted">NOTED</span>}
                </div>
              ))}
            </>
          )}
        </section>

        <aside className="completion-side">
          <section className="panel">
            <div className="mono panel-label strong">EVIDENCE PACKAGE</div>
            {cards.length === 0 && (
              <div className="mono panel-empty">
                The package is written when the migration completes.
              </div>
            )}
            {cards.map((a) => (
              <button
                key={a.artifactId}
                className="artifact"
                style={{ borderColor: 'var(--line2)' }}
                onClick={() => {
                  const artifact = artifacts.find((x) => x.artifactId === a.artifactId);
                  if (artifact) void api.download(id!, artifact);
                }}
              >
                <span
                  className="mono artifact-ext"
                  style={{ borderColor: a.colour, color: a.colour, background: mix(a.colour, 10) }}
                >
                  {a.ext}
                </span>
                <span className="artifact-body">
                  <span className="artifact-title">{a.title}</span>
                  <span className="mono artifact-meta">{a.meta}</span>
                </span>
                <span className="mono artifact-arrow" style={{ color: a.colour }}>↓</span>
              </button>
            ))}
          </section>

          <section className="panel">
            <div className="mono panel-label warn">RECOMMENDATIONS</div>
            {/* Carried forward, not re-derived. A successful migration is exactly
                when these feel irrelevant and are most likely to be dropped. */}
            <p className="panel-sub">
              Carried forward from the assessment — hardware and vendor items the agent
              could not change, with the action each requires.
            </p>
            {recommendations.length === 0 && (
              <div className="mono panel-empty">Nothing was left outside the boundary.</div>
            )}
            {recommendations.map((r) => {
              const colour = DISPOSITION_COLOR[r.disposition] ?? 'var(--acc)';
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
        </aside>
      </div>
    </div>
  );
}

const elapsed = (from: Date | string, to: Date | string): string => {
  const s = Math.max(0, Math.round(
    (new Date(to).getTime() - new Date(from).getTime()) / 1000,
  ));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
