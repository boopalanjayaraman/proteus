import { useAuth } from '../app/AuthContext';

/**
 * The home screen (UX v1.3).
 *
 * The copy changed in v1.3 to say what the product does *before* asking anyone
 * to sign in. The claim it now leads with — that cryptography reaches past
 * source code into hardware and vendor firmware — is the reason the product
 * splits its output in two, so MIGRATES and RECOMMENDS are named here rather
 * than discovered on the assessment screen.
 */
export function Login() {
  const { signIn } = useAuth();
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand mono">PROTEUS</div>
        <div className="label" style={{ marginTop: 4 }}>PQC MIGRATION ENGINEER</div>
        <h1>
          An autonomous engineer for{' '}
          {/* Kept on one line: the phrase is the product's whole subject. */}
          <span className="login-nowrap">post-quantum migration.</span>
        </h1>
        <p className="sub">
          Give it the context. Watch it understand. Approve once. Watch it work.
          Review the evidence.
        </p>
        <button className="primary" onClick={() => void signIn()}>
          Continue with Google
        </button>

        <p className="fine">
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

        <div className="chips">
          {/* "v1.2 PROTOTYPE" is gone; the scoping promise it used to make in a
              sentence is now a chip, which is what PRD-15 actually enforces. */}
          <span className="chip mono">SCOPED TO YOUR ACCOUNT</span>
          <span className="chip mono">ISOLATED SANDBOX</span>
          <span className="chip mono">NO PRODUCTION ACCESS</span>
        </div>
      </div>
    </div>
  );
}
