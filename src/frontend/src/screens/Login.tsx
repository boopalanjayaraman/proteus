import { useState } from 'react';
import { useAuth } from '../app/AuthContext';
import { describeAuthError, type AuthFailure } from '../lib/authErrors';
import { useTheme } from '../app/ThemeContext';
import { LOGIN_VIEWBOX, loginEdges, loginNodes } from '../lib/loginGraph';

/**
 * The home screen (UX v1.3).
 *
 * Two panes: what the product is on the left, what it produces on the right.
 * The graph is decorative and fixed — nobody is signed in, so there is no
 * project to draw, and inventing a live one would put a fabricated finding on
 * the first screen a visitor sees. It is the payments fixture, which is the
 * same graph discovery builds for real once a project exists.
 *
 * The copy changed in v1.3 to say what the product does before asking anyone to
 * sign in. The claim it leads with — that cryptography reaches past source code
 * into hardware and vendor firmware — is why the product splits its output in
 * two, so MIGRATES and RECOMMENDS are named here rather than discovered later.
 */
export function Login() {
  const { signIn } = useAuth();
  const { theme, toggle } = useTheme();
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
      <section className="login-pane">
        <header className="login-head">
          <div className="login-mark" aria-hidden="true" />
          <div className="login-wordmark">
            <div className="login-brand">PROTEUS</div>
            <div className="mono login-tagline">PQC MIGRATION ENGINEER</div>
          </div>
          {/* The only theme control before sign-in — the header that normally
              carries one belongs to the shell, which does not exist yet. */}
          <button className="ghost login-theme" onClick={toggle} title="Switch theme">
            {theme === 'dark' ? 'LIGHT' : 'DARK'}
          </button>
        </header>

        <div className="login-middle">
          <h1>
            An autonomous engineer for{' '}
            {/* Kept on one line: the phrase is the product's whole subject. */}
            <span className="login-nowrap">post-quantum migration.</span>
          </h1>
          <div className="login-cta">
            <button
              className="login-google"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFailure(null);
                try {
                  await signIn();
                } catch (e) {
                  setFailure(describeAuthError(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <span className="login-g" aria-hidden="true">G</span>
              {busy ? 'Signing in…' : 'Continue with Google'}
            </button>

            {failure && (
              <div className="login-error" role="alert">
                <div className="login-error-msg">{failure.message}</div>
                {failure.fix && <div className="login-error-fix">{failure.fix}</div>}
                <div className="mono login-error-code">{failure.code}</div>
              </div>
            )}
            <p className="login-sub">
              Give it the context. Watch it understand. Approve once. Watch it work.
              Review the evidence.
            </p>
          </div>
        </div>

        <footer className="login-foot">
          <p className="login-fine">
            Where cryptography reaches past source code — HSMs, industrial gateways,
            vendor firmware.
          </p>

          {/* The split the whole product rests on: what the agent changes itself,
              and what it can only hand to a person. Said before sign-in so nobody
              arrives expecting an HSM to be migrated. */}
          <div className="login-split">
            <div className="login-split-col">
              <div className="mono login-split-label" style={{ color: 'var(--acc)' }}>
                MIGRATES
              </div>
              <div className="login-split-value">Code, dependencies, tests</div>
            </div>
            <div className="login-split-col">
              <div className="mono login-split-label" style={{ color: 'var(--vio)' }}>
                RECOMMENDS
              </div>
              <div className="login-split-value">Hardware, firmware, vendors</div>
            </div>
          </div>

          <div className="login-rule" />

          {/* "v1.2 PROTOTYPE" is gone. The scoping promise it used to make in a
              sentence is now a claim PRD-15 actually enforces. */}
          <div className="mono login-chips">
            <span>SCOPED TO YOUR ACCOUNT</span>
            <span className="login-dot">·</span>
            <span>ISOLATED SANDBOX</span>
            <span className="login-dot">·</span>
            <span>NO PRODUCTION ACCESS</span>
          </div>
        </footer>
      </section>

      <section className="login-graph" aria-hidden="true">
        {/* Stretched rather than letterboxed, and the chips are positioned in
            percentages, so lines stay attached to boxes at any pane width. */}
        <svg
          className="login-graph-edges"
          viewBox={`0 0 ${LOGIN_VIEWBOX.width} ${LOGIN_VIEWBOX.height}`}
          preserveAspectRatio="none"
        >
          {loginEdges.map((e, i) => (
            <line
              key={i}
              x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
              stroke="var(--line2)"
              strokeWidth={1}
              strokeDasharray={e.inferred ? '4 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {loginNodes.map((n) => (
          <div
            key={n.id}
            className="login-node"
            style={{ left: `${n.left}%`, top: `${n.top}%` }}
          >
            <span className="login-node-dot" style={{ background: n.colour }} />
            <span className="mono login-node-name">{n.name}</span>
          </div>
        ))}

        <div className="login-graph-caption">
          <div className="mono login-graph-label">LIVE CRYPTO DEPENDENCY GRAPH</div>
          <div className="login-graph-note">
            Observed facts kept separate from inferred relationships.
          </div>
        </div>
      </section>
    </div>
  );
}
