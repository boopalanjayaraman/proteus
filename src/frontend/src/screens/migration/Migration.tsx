import type {
  Baseline, EventLevel, MigrationChange, MigrationRun, Project, SandboxDeployment,
  VerificationResult,
} from '@proteus/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ActivityFeed } from '../../components/activity/ActivityFeed';
import { useAuth } from '../../app/AuthContext';
import { useProjectStream } from '../../hooks/useProjectStream';
import {
  CLASSIFICATION_COLOR, DISPOSITION_COLOR, STATUS_COLOR, branchMeta, checkRows,
  checklist, groupSummaries, migrationStats, openProblems, progressFromEvents, rail,
  retryDisplay, sandboxCard, shortSha, summarise, verdictLine, type ProblemSummary,
} from '../../lib/migration';

/**
 * Screen 4 — live autonomous migration.
 *
 * This increment fills the left rail, the branch panel and the baseline
 * contract; the build-and-repair loop that drives the rest of the rail arrives
 * with PRD-12. Everything shown is replayed server state, so a refresh
 * mid-migration restores the same picture.
 */

export function Migration() {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [run, setRun] = useState<MigrationRun | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [changes, setChanges] = useState<MigrationChange[]>([]);
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [sandbox, setSandbox] = useState<SandboxDeployment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<EventLevel | 'ALL'>('ALL');

  // The run and everything it produces. Replaying discovery above the first
  // migration line buried the thing the screen exists to show.
  const { events, status } = useProjectStream(id, {
    phases: ['MIGRATION', 'VERIFICATION', 'SANDBOX'],
  });
  const seen = useRef(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, m] = await Promise.all([api.project(id), api.migration(id)]);
      setProject(p);
      setRun(m.run);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    // Both are absent until the baseline is captured, which is most of the
    // early screen — an error here is a stage, not a failure.
    await api.baseline(id).then((b) => setBaseline(b.baseline)).catch(() => undefined);
    await api.changes(id).then((c) => setChanges(c.changes)).catch(() => undefined);
    await api.attempts(id).then((a) => setProblems(a.problems)).catch(() => undefined);
    // Both are absent until the loop finishes, which is most of the run — an
    // error here is a stage, not a failure.
    await api.verification(id).then((v) => setVerification(v.result)).catch(() => undefined);
    await api.sandbox(id).then((s) => setSandbox(s.sandbox)).catch(() => undefined);
  }, [api, id]);

  useEffect(() => { void load(); }, [load]);

  // Every event moves something on this screen — a stage, a commit count, a
  // checklist — so the refetch is driven by the stream rather than a timer.
  useEffect(() => {
    if (events.length === seen.current) return;
    seen.current = events.length;
    void load();
  }, [events.length, load]);

  if (error) {
    return (
      <div className="placeholder">
        <h2>No migration yet</h2>
        <p className="sub">
          The migration begins once the assessment is approved. {error}
        </p>
      </div>
    );
  }
  if (!run) return <div className="label">Loading migration…</div>;

  const steps = rail(run.stage);
  const contract = checklist(baseline);
  const summary = summarise(baseline);

  const stats = migrationStats({
    commitCount: run.branch.commitCount,
    testsPassing: run.metrics.testsPassing,
    testsFailing: run.metrics.testsFailing,
    autonomousRepairs: run.metrics.autonomousRepairs,
    humanGatesOpened: run.metrics.humanGatesOpened,
  });
  const unresolved = openProblems(problems);
  const rows = verification ? checkRows(verification.checks) : [];
  const card = sandboxCard(sandbox);
  // Rebuilt from the events themselves, so a refresh mid-build restores the
  // same picture rather than an empty panel.
  const progress = progressFromEvents(events);
  const groups = groupSummaries(progress.suites);

  return (
    <div className="migration">
      <aside className="mig-rail">
        <div className="mig-branch">
          <div className="mono mig-branch-label">MIGRATION BRANCH</div>
          <div className="mono mig-branch-name">{run.branch.name}</div>
          <div className="mono mig-branch-meta">{branchMeta(run)}</div>
        </div>
        <div className="mig-stages">
          {steps.map((s) => (
            <div key={s.stage} className={`mig-stage ${s.state.toLowerCase()}`}>
              <div className="mig-stage-marker">
                <span className="mig-dot" />
                <span className="mig-line" />
              </div>
              <div className="mono mig-stage-name">{s.label}</div>
            </div>
          ))}
        </div>
      </aside>

      <div className="mig-main">
        <header className="mig-head">
          <div>
            <h1>Autonomous migration</h1>
            <p className="sub">
              {project?.name} · {run.status.toLowerCase()} ·{' '}
              {status === 'open' ? 'live' : status}
            </p>
          </div>
          <div className="mig-stats">
            {stats.map((s) => (
              <div key={s.label} className="mig-stat">
                <div className="mig-stat-value" style={{ color: s.fg }}>{s.value}</div>
                <div className="mono mig-stat-label">{s.label}</div>
              </div>
            ))}
          </div>
        </header>

        <div className="mig-body">
          <section className="mig-feed">
            {groups.length > 0 && (
              <div className="test-progress">
                <div className="test-progress-head">
                  <span className="mono panel-label acc">
                    {progress.phase ?? 'RUNNING TESTS'}
                  </span>
                  {/* The denominator comes from the baseline; the first run of a
                      repository has none and says so rather than showing a bar
                      that cannot fill. */}
                  <span className="mono test-progress-count">{progress.counted}</span>
                </div>
                {groups.map((g) => (
                  <div key={g.group} className="test-group">
                    <div className="test-group-head">
                      <span className="test-group-label">{g.label}</span>
                      <span className="mono test-group-count">
                        {g.finished} / {g.total} suites
                      </span>
                    </div>
                    <div className="test-bar">
                      <div
                        className="test-bar-fill"
                        style={{
                          width: `${g.fraction * 100}%`,
                          background: g.failed ? 'var(--bad)' : 'var(--ok)',
                        }}
                      />
                    </div>
                    {g.suites.map((suite) => (
                      <div key={suite.suite} className={`suite ${suite.state.toLowerCase()}`}>
                        <span className="mono suite-mark">
                          {suite.state === 'PASSED' ? '✓'
                            : suite.state === 'FAILED' ? '✗' : '▸'}
                        </span>
                        <span className="suite-name">{suite.short}</span>
                        <span className="mono suite-meta">
                          {suite.state === 'RUNNING'
                            ? 'running…'
                            : `${suite.total ?? 0} tests`
                              + (suite.seconds !== undefined ? ` · ${suite.seconds}s` : '')}
                        </span>
                        {/* Surefire names failing methods individually and
                            passing ones only as a count — the right asymmetry
                            for a feed, and the reason this is worth rendering. */}
                        {suite.failed.map((f) => (
                          <div key={f.method} className="suite-failure">
                            <div className="mono suite-failure-method">{f.method}</div>
                            {f.message && (
                              <div className="mono suite-failure-message">{f.message}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <ActivityFeed events={events} level={level} onLevel={setLevel} status={status} />
          </section>

          <aside className="mig-side">
            {/* Spec §37 — the completion artifact. First once it exists, because
                it is the thing the reader came for. */}
            {card && (
              <section className={`panel sandbox-card ${card.ready ? 'ready' : ''}`}>
                <div className="mono panel-label ok">TESTED SANDBOX APPLICATION</div>
                {card.url && card.ready ? (
                  <a className="sandbox-url" href={card.url} target="_blank" rel="noreferrer">
                    {card.url} ↗
                  </a>
                ) : (
                  <div className="mono panel-empty">{card.status.replace(/_/g, ' ')}</div>
                )}
                {/* Derived from `isProduction`, never hardcoded — spec §36
                    requires the environment never to be shown as production. */}
                <div className="mono sandbox-label">{card.label}</div>
                {card.startup && <div className="mono sandbox-line">{card.startup}</div>}
                {card.e2e && <div className="mono sandbox-line">{card.e2e}</div>}
              </section>
            )}

            {verification && (
              <section className="panel">
                <div className="mono panel-label acc">DETERMINISTIC VERIFICATION</div>
                <div
                  className="mono verdict"
                  style={{
                    color: verification.overall === 'VERIFIED' ? 'var(--ok)' : 'var(--bad)',
                  }}
                >
                  {verdictLine(verification.overall, verification.checks)}
                </div>
                {rows.map((r) => (
                  <div key={r.check} className="check-row">
                    <span className="mono check-glyph" style={{ color: r.colour }}>
                      {r.glyph}
                    </span>
                    <div className="check-body">
                      <div className="check-label">{r.label}</div>
                      <div className="mono check-detail">{r.detail}</div>
                    </div>
                  </div>
                ))}

                {verification.cryptoAssertions.length > 0 && (
                  <>
                    <div className="mono panel-label">CRYPTO VERIFICATION</div>
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
                        {/* NOTED is narrative and never gating. Labelled so a
                            reader does not mistake it for a failure. */}
                        {a.status === 'NOTED' && (
                          <span className="mono check-noted">NOTED</span>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </section>
            )}

            {/* The retry budget, per problem. Above the contract during a run,
                because it is the thing that decides whether the agent keeps
                going — and the one number a viewer watches. */}
            {unresolved.length > 0 && (
              <section className="panel">
                <div className="mono panel-label warn">RETRY POLICY</div>
                {unresolved.map((p) => {
                  const retry = retryDisplay(p);
                  return (
                    <div key={p.problemKey} className="problem">
                      <div className="problem-top">
                        <span
                          className="mono problem-class"
                          style={{ color: CLASSIFICATION_COLOR[p.classification] ?? 'var(--fg2)' }}
                        >
                          {p.classification.replace(/_/g, ' ')}
                        </span>
                        <span className="mono problem-count" style={{ color: retry.colour }}>
                          {retry.label}
                        </span>
                      </div>
                      <div className="problem-bar">
                        <div
                          className="problem-bar-fill"
                          style={{ width: `${retry.fraction * 100}%`, background: retry.colour }}
                        />
                      </div>
                      <div className="mono problem-signature">{p.signature}</div>
                      {retry.exhausted && (
                        <div className="mono problem-note">
                          ESCALATED · UNRELATED APPROVED WORK CONTINUES
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            )}

            <section className="panel">
              <div className="mono panel-label acc">BASELINE CONTRACT</div>
              {!summary && (
                <div className="mono panel-empty">
                  Captured before anything is modified. Not yet available.
                </div>
              )}
              {summary && (
                <>
                  <p className="panel-sub">{summary.headline}</p>
                  {contract.map((i) => (
                    <div
                      key={i.detail}
                      className="contract-item"
                      style={{ borderLeftColor: DISPOSITION_COLOR[i.disposition] }}
                    >
                      <div className="contract-top">
                        <span className="contract-label">{i.label}</span>
                        <span
                          className="mono contract-disposition"
                          style={{ color: DISPOSITION_COLOR[i.disposition] }}
                        >
                          {i.disposition === 'MUST_PRESERVE' ? 'MUST PRESERVE' : 'WILL CHANGE'}
                        </span>
                      </div>
                      <div className="mono contract-kind">{i.kind}</div>
                      {/* The executable assertion, verbatim. An invariant the
                          reader cannot see is one they cannot check. */}
                      <code className="mono contract-assertion">{i.detail}</code>
                    </div>
                  ))}
                  {baseline!.tests.knownFailures.length > 0 && (
                    <div className="mono panel-note">
                      KNOWN FAILURES · NEVER ATTRIBUTED TO THE MIGRATION
                      {baseline!.tests.knownFailures.map((f) => (
                        <div key={f.testId} className="known-failure">{f.name}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>

            {changes.length > 0 && (
              <section className="panel">
                <div className="mono panel-label">MODIFICATIONS</div>
                {changes.map((c) => (
                  <div key={c.changeId} className="change">
                    <div className="change-top">
                      <span className="mono change-seq">#{c.sequence}</span>
                      <span className="change-summary">{c.summary}</span>
                    </div>
                    <div className="mono change-meta">
                      {c.changeType} · {shortSha(c.commitSha)} ·{' '}
                      {c.files.map((f) => f.path.split('/').pop()).join(', ')}
                    </div>
                    {/* Spec §26 — why it was safe to edit this test, on screen
                        rather than only in the audit trail. */}
                    {c.testIntegrity && (
                      <div className="mono change-integrity">
                        {c.testIntegrity.failureClassification} · BASELINE REQUIREMENT{' '}
                        {c.testIntegrity.baselineRequirementChanged ? 'CHANGED' : 'UNCHANGED'}
                        <div className="change-reason">{c.testIntegrity.reason}</div>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
