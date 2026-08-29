import type { Evidence, Finding } from '@proteus/schema';
import { useEffect, useState } from 'react';
import { useAuth } from '../../app/AuthContext';
import { DISPOSITION_COLOR, mix } from '../../lib/impact';

/**
 * One finding, with its evidence behind a disclosure.
 *
 * The card is collapsed by default and expands to the detail, the evidence and
 * the AGENT INTENT — which is shown for every finding, including the ones
 * nothing will happen to. "No modification, and here is why" is the sentence a
 * sceptical reader is looking for, and hiding it for out-of-scope items would
 * make silence and oversight look identical.
 */

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: 'var(--bad)', HIGH: 'var(--warn)', MEDIUM: 'var(--acc)',
  LOW: 'var(--fg3)', INFO: 'var(--ok)',
};

export function FindingCard({ projectId, finding }: { projectId: string; finding: Finding }) {
  const { api } = useAuth();
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<Evidence[] | null>(null);

  useEffect(() => {
    if (!open || evidence) return;
    api.evidence(projectId, finding.evidenceIds)
      .then((r) => setEvidence(r.evidence))
      .catch(() => setEvidence([]));
  }, [open, evidence, api, projectId, finding.evidenceIds]);

  const accent = SEVERITY_COLOR[finding.severity] ?? 'var(--fg3)';
  const disposition = DISPOSITION_COLOR[finding.disposition];
  const primary = evidence?.find((e) => e.evidenceId === finding.primaryEvidenceId) ?? evidence?.[0];
  const location = finding.locations[0];
  const citation = location?.path
    ? `${location.path}${location.startLine ? `:${location.startLine}` : ''}`
    : finding.title;

  return (
    <div
      className="finding"
      style={{ borderLeftColor: accent }}
      onClick={() => setOpen((v) => !v)}
    >
      <div className="finding-top">
        <div className="finding-head">
          <div className="finding-tags">
            <span className="mono finding-category">{finding.category}</span>
            <span
              className="mono finding-severity"
              style={{ background: mix(accent, 13), color: accent }}
            >
              {finding.severity}
            </span>
          </div>
          <div className="finding-title">{finding.title}</div>
          <div className="mono finding-usage">{finding.summaryLine}</div>
        </div>
        <div className="finding-right">
          <span
            className="mono finding-disposition"
            style={{ background: mix(disposition, 13), color: disposition }}
          >
            {finding.disposition.replace(/_/g, ' ')}
          </span>
          <span className="mono finding-expand">{open ? 'HIDE EVIDENCE' : 'SHOW EVIDENCE'}</span>
        </div>
      </div>

      <div className="finding-cite">
        {primary && (
          <span
            className="mono finding-class"
            style={{
              background: mix(primary.evidenceClass === 'OBSERVED' ? 'var(--ok)' : 'var(--warn)', 13),
              color: primary.evidenceClass === 'OBSERVED' ? 'var(--ok)' : 'var(--warn)',
            }}
          >
            {primary.evidenceClass}
          </span>
        )}
        <span className="mono finding-source">{citation}</span>
      </div>

      {open && (
        <div className="finding-detail" onClick={(e) => e.stopPropagation()}>
          <div className="finding-rule" />
          <p className="finding-description">{finding.description}</p>

          {evidence === null && <div className="mono finding-empty">Loading evidence…</div>}
          {evidence?.map((e) => (
            <div key={e.evidenceId} className="snippet">
              <div className="snippet-head">
                {/* §16: repository evidence is clickable through to the source. */}
                {e.locator.kind === 'REPO' && e.locator.permalink ? (
                  <a className="mono snippet-source" href={e.locator.permalink}
                     target="_blank" rel="noreferrer">{e.source}</a>
                ) : (
                  <span className="mono snippet-source">{e.source}</span>
                )}
                <span className="mono snippet-type">{e.evidenceType}</span>
              </div>
              {e.excerpt && <pre className="mono snippet-body">{e.excerpt}</pre>}
            </div>
          ))}

          <div className="finding-intent">
            <div className="mono finding-intent-label">AGENT INTENT</div>
            <div className="finding-intent-text">{finding.agentIntent}</div>
          </div>
        </div>
      )}
    </div>
  );
}
