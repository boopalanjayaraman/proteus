/**
 * Stands in for a screen a later increment delivers.
 *
 * Says which PRD owns it rather than showing an empty box — during a build,
 * "not built yet" and "built but broken" look identical from the outside, and
 * that costs more time than it saves.
 */
export function Placeholder({ title, prd, children }: {
  title: string; prd: string; children?: React.ReactNode;
}) {
  return (
    <div className="placeholder">
      <h2>{title}</h2>
      <p className="sub">{children ?? 'Not built yet.'}</p>
      <span className="chip mono">DELIVERED BY {prd}</span>
    </div>
  );
}
