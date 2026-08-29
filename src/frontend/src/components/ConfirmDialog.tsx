import { useEffect, useRef } from 'react';

/**
 * A modal confirmation for an irreversible action (PRD-17).
 *
 * Built on the native `<dialog>` element rather than a div with a high z-index:
 * `showModal()` traps focus, closes on Escape, renders in the top layer above
 * everything, and makes the rest of the page inert — four behaviours that are
 * each easy to get subtly wrong by hand, on a dialog whose whole job is to
 * make someone stop and read.
 */
export function ConfirmDialog({
  open, title, danger = false, confirmLabel, confirmDisabled, busy,
  onConfirm, onCancel, children,
}: {
  open: boolean;
  title: string;
  danger?: boolean;
  confirmLabel: string;
  confirmDisabled: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `showModal` throws if the dialog is already open, and `close` on a closed
    // one is a no-op — so both are guarded on the element's own state rather
    // than on the prop.
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog${danger ? ' danger' : ''}`}
      // Escape fires `cancel`; routing it through onCancel keeps React's state
      // and the element's state from disagreeing about whether it is open.
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      onClick={(e) => { if (e.target === ref.current) onCancel(); }}
    >
      <form method="dialog" className="dialog-body" onSubmit={(e) => e.preventDefault()}>
        <h2 className="dialog-title">{title}</h2>
        <div className="dialog-content">{children}</div>
        <div className="dialog-foot">
          <button type="button" className="linkish" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'danger-btn' : 'primary compact'}
            disabled={confirmDisabled || busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
