import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';

interface Attachment {
  kind: string;
  originalName: string;
  mimeType: string;
  contentBase64: string;
  sizeBytes: number;
}

const HARDWARE_KINDS = ['HARDWARE_SPEC', 'OT_SPEC', 'IOT_SPEC', 'HSM_SPEC', 'FIRMWARE_DOC',
  'ARCHITECTURE_DOC', 'SECURITY_ARCHITECTURE_DOC', 'PROTOCOL_DOC'] as const;
const FINDING_KINDS = ['CBOM', 'SAST_FINDINGS', 'VULN_REPORT', 'PQC_READINESS_REPORT'] as const;

const readAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });

const fmtSize = (b: number) =>
  b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export function CreateProject() {
  const { api } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [instructions, setInstructions] = useState('');
  const [hardware, setHardware] = useState<Attachment[]>([]);
  const [findings, setFindings] = useState<Attachment[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Served by the backend so the screen cannot drift from what is actually required.
  useEffect(() => { api.requiredScopes().then((r) => setScopes(r.scopes)).catch(() => undefined); }, [api]);

  const addFiles = async (
    files: FileList | null,
    kind: string,
    setter: (fn: (prev: Attachment[]) => Attachment[]) => void,
  ) => {
    for (const f of Array.from(files ?? [])) {
      const contentBase64 = await readAsBase64(f);
      setter((prev) => [...prev, {
        kind, originalName: f.name, mimeType: f.type || 'application/octet-stream',
        contentBase64, sizeBytes: f.size,
      }]);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        name, repositoryUrl, githubToken,
        instructions: instructions || undefined,
        files: [...hardware, ...findings].map(({ sizeBytes: _drop, ...f }) => f),
      });
      // Cleared immediately. The token has been vaulted; there is no reason for
      // it to stay in a form field or a React state tree.
      setGithubToken('');
      navigate(`/projects/${project.projectId}/discovery`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const masked = githubToken
    ? `${githubToken.slice(0, 12)}${'•'.repeat(Math.max(0, Math.min(42, githubToken.length - 12)))}`
    : '';

  return (
    <form className="create" onSubmit={submit}>
      <div className="create-head">
        <h2>Create migration project</h2>
        <p className="sub">
          Everything you provide becomes the context the agent reasons over.
          Nothing is modified at this stage.
        </p>
      </div>

      <section className="sec">
        <div className="sec-no mono">01</div>
        <div className="sec-body">
          <div className="label">Project</div>
          <label htmlFor="name">Project name</label>
          <input id="name" required value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="Payment API PQC Migration" />
          <label htmlFor="repo">Repository URL</label>
          <input id="repo" required type="url" value={repositoryUrl}
                 onChange={(e) => setRepositoryUrl(e.target.value)}
                 placeholder="https://github.com/northwind-pay/payments-api" />
          <div className="note label">Read-only until migration is approved</div>
        </div>
      </section>

      <section className="sec">
        <div className="sec-no mono">02</div>
        <div className="sec-body">
          <div className="label">Repository access &amp; credentials</div>
          <label htmlFor="pat">GitHub fine-grained personal access token</label>
          <input id="pat" required type="password" autoComplete="off" spellCheck={false}
                 value={githubToken} onChange={(e) => setGithubToken(e.target.value)}
                 placeholder="github_pat_…" />
          {masked && <div className="masked mono">{masked}</div>}
          <div className="note label">
            Stored write-only · scoped to this repository · never returned to the browser ·
            rotation reminder 90 days
          </div>
          {scopes.length > 0 && (
            <>
              <div className="label" style={{ marginTop: 14 }}>Required scopes</div>
              <div className="chips">
                {scopes.map((s) => <span key={s} className="chip mono">{s}</span>)}
              </div>
            </>
          )}
        </div>
      </section>

      <FileSection
        no="03" title="Hardware / OT / infrastructure" kinds={HARDWARE_KINDS}
        blurb="OT / IoT / HSM specifications, firmware and security architecture documents — dependencies that cannot be inferred from source."
        files={hardware} onAdd={(fl, k) => void addFiles(fl, k, setHardware)}
        onRemove={(i) => setHardware((p) => p.filter((_, j) => j !== i))}
      />

      <FileSection
        no="04" title="Existing findings" kinds={FINDING_KINDS}
        blurb="CBOM exports, crypto discovery reports, SAST findings and PQC-readiness assessments, correlated against source."
        files={findings} onAdd={(fl, k) => void addFiles(fl, k, setFindings)}
        onRemove={(i) => setFindings((p) => p.filter((_, j) => j !== i))}
      />

      <section className="sec">
        <div className="sec-no mono">05</div>
        <div className="sec-body">
          <div className="label">Agent instructions <span className="optional">optional</span></div>
          <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)}
                    placeholder={'Do not modify the industrial gateway integration contract.\nPrefer NIST-selected algorithms.\nSettlement API response contract must not change.'} />
        </div>
      </section>

      {error && <div className="error">{error}</div>}

      <div className="create-foot">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create project & start discovery'}
        </button>
        <button className="ghost" type="button" onClick={() => navigate('/projects')}>Cancel</button>
      </div>

      <section className="boundary">
        <div className="label">Autonomy boundary</div>
        <p className="sub">Before your approval the agent may only read, inspect, correlate and propose.</p>
        <ul>
          <li><b style={{ color: 'var(--ok)' }}>READ</b> Repository and configuration</li>
          <li><b style={{ color: 'var(--ok)' }}>READ</b> Uploaded specifications &amp; findings</li>
          <li><b style={{ color: 'var(--ok)' }}>YES</b> Analyze, correlate, classify, map</li>
          <li><b style={{ color: 'var(--bad)' }}>NO</b> Create a migration branch</li>
          <li><b style={{ color: 'var(--bad)' }}>NO</b> Modify source, dependencies or tests</li>
          <li><b style={{ color: 'var(--bad)' }}>NO</b> Deploy anything</li>
          <li><b style={{ color: 'var(--acc)' }}>—</b> Credentials held server-side only</li>
        </ul>
      </section>
    </form>
  );
}

function FileSection({ no, title, blurb, kinds, files, onAdd, onRemove }: {
  no: string; title: string; blurb: string; kinds: readonly string[];
  files: Attachment[]; onAdd: (f: FileList | null, kind: string) => void; onRemove: (i: number) => void;
}) {
  const [kind, setKind] = useState(kinds[0]!);
  return (
    <section className="sec">
      <div className="sec-no mono">{no}</div>
      <div className="sec-body">
        <div className="label">{title} <span className="optional">optional</span></div>
        <p className="sub">{blurb}</p>
        <div className="upload">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ').toLowerCase()}</option>)}
          </select>
          <input type="file" multiple onChange={(e) => { onAdd(e.target.files, kind); e.target.value = ''; }} />
        </div>
        {files.map((f, i) => (
          <div key={`${f.originalName}-${i}`} className="file-row">
            <span>{f.originalName}</span>
            <span className="label">{f.kind.replace(/_/g, ' ')} · {fmtSize(f.sizeBytes)}</span>
            <button type="button" className="ghost" onClick={() => onRemove(i)}>Remove</button>
          </div>
        ))}
      </div>
    </section>
  );
}
