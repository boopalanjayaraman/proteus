import {
  MIGRATION_DISCLOSURE_TEXT,
  MIGRATION_UNTOUCHED_STATEMENT,
  type Assessment,
} from '@proteus/schema';
import { useEffect, useRef } from 'react';
import { scopeOf } from '../../lib/approval';

/**
 * The human approval gate (spec §20, UX v1.2).
 *
 * The disclosure is imported from the shared schema rather than written here,
 * for the same reason the server stores it on the gate: the words that obtain
 * consent and the words that are later produced as the record of it have to be
 * the same words. The server re-checks the list this dialog sends back, so a
 * stale bundle is refused rather than believed.
 *
 * Cancel does nothing but close. That is the whole of FR-10 — a dismissed
 * dialog must not leave a trace, so there is no request to make.
 */

interface Props {
  assessment: Assessment;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ApproveModal({ assessment, busy, error, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const scope = scopeOf(assessment);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-scrim" onClick={onCancel} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="mono modal-eyebrow">HUMAN APPROVAL GATE</div>
          <h2 id="approve-heading">Authorize autonomous migration</h2>
          <p className="modal-lede">
            You are approving the migration scope shown, not a generic instruction to
            start. After confirmation the agent will perform reversible engineering work
            without asking for routine approvals.
          </p>
        </div>

        {/* Every disclosed action, in full. The user confirms this list and the
            server stores exactly what was confirmed. */}
        <ul className="disclosure">
          {MIGRATION_DISCLOSURE_TEXT.map((action) => (
            <li key={action}>
              <span className="mono disclosure-arrow" aria-hidden="true">→</span>
              <span>{action}</span>
            </li>
          ))}
        </ul>

        <div className="modal-scope">
          <div className="mono modal-scope-label">AUTHORISING</div>
          <div className="modal-scope-value">
            {scope.autonomous.length} plan item{scope.autonomous.length === 1 ? '' : 's'}
            {scope.paths.length > 0 && ` · ${scope.paths.length} declared `}
            {scope.paths.length > 0 && (scope.paths.length === 1 ? 'file' : 'files')}
            {scope.excluded.length > 0
              && ` · ${scope.excluded.length} item${scope.excluded.length === 1 ? '' : 's'} `
                + 'left to their owners'}
          </div>
          {scope.paths.length > 0 && (
            <div className="mono modal-scope-paths">{scope.paths.join(' · ')}</div>
          )}
        </div>

        <div className="modal-boundary">{MIGRATION_UNTOUCHED_STATEMENT}</div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-foot">
          <button
            ref={confirmRef}
            className="primary compact"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Starting migration…' : 'Confirm & start migration'}
          </button>
          <button className="linklike" disabled={busy} onClick={onCancel}>Cancel</button>
          <div className="modal-foot-spacer" />
          <div className="mono modal-audit">LOGGED TO AUDIT TRAIL</div>
        </div>
      </div>
    </div>
  );
}
