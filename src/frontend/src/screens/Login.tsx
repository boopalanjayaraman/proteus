import { useAuth } from '../app/AuthContext';

export function Login() {
  const { signIn } = useAuth();
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand mono">PROTEUS</div>
        <div className="label" style={{ marginTop: 4 }}>PQC Migration Engineer</div>
        <h1>An autonomous engineer for post-quantum migration.</h1>
        <p className="sub">
          Give it the context. Watch it understand. Approve once. Watch it work.
          Review the evidence.
        </p>
        <button className="primary" onClick={() => void signIn()}>
          Continue with Google
        </button>
        <p className="fine">
          Projects and migration evidence are scoped to your account. Access is limited to
          authorized repositories and disposable engineering environments.
        </p>
        <div className="chips">
          <span className="chip mono">v1.2 PROTOTYPE</span>
          <span className="chip mono">ISOLATED SANDBOX</span>
          <span className="chip mono">NO PRODUCTION ACCESS</span>
        </div>
      </div>
    </div>
  );
}
