import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Project } from '@proteus/schema';
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
  /**
   * One screen, two jobs.
   *
   * Editing shows the same fields in the same order, because the thing being
   * described is the same thing — a second screen would drift from this one the
   * first time either changed.
   */
  const { id: editingId } = useParams<{ id: string }>();
  const editing = Boolean(editingId);

  const [loaded, setLoaded] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [instructions, setInstructions] = useState('');
  const [hardware, setHardware] = useState<Attachment[]>([]);
  const [findings, setFindings] = useState<Attachment[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [rerun, setRerun] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Served by the backend so the screen cannot drift from what is actually required.
  useEffect(() => { api.requiredScopes().then((r) => setScopes(r.scopes)).catch(() => undefined); }, [api]);

  // Fills the form from the project being edited. The token is absent by
  // design — it is never returned, so the field starts empty and an empty field
  // means "leave the stored one alone".
  useEffect(() => {
    if (!editingId) return;
    api.project(editingId).then((p) => {
      setLoaded(p);
      setName(p.name);
      setRepositoryUrl(p.repository.url);
      setInstructions(p.instructions ?? '');
    }).catch((e) => setError((e as Error).message));
  }, [api, editingId]);

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
      if (editingId) {
        await api.updateProject(editingId, {
          name,
          instructions,
          // Only sent when the user typed one. An empty field is "leave it",
          // not "clear it" — there is no way to have no credential.
          ...(githubToken ? { githubToken } : {}),
        });
        // `sizeBytes` is the screen's own bookkeeping; the endpoint takes bytes.
        for (const f of [...hardware, ...findings]) {
          await api.uploadFile(editingId, {
            kind: f.kind, originalName: f.originalName,
            mimeType: f.mimeType, contentBase64: f.contentBase64,
          });
        }
        setGithubToken('');
        if (rerun) await api.rediscover(editingId);
        navigate(`/projects/${editingId}/${rerun ? 'discovery' : 'assessment'}`);
        return;
      }

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
      <div className="create-form">
        <div className="create-head">
          <h1>{editing ? `Edit ${loaded?.projectId ?? 'project'}` : 'Create migration project'}</h1>
          <p className="create-lede">
            {editing
              ? 'Change the context the agent reasons over. Nothing already discovered is '
                + 'altered until you re-run the analysis.'
              : 'Everything you provide becomes the context the agent reasons over. '
                + 'Nothing is modified at this stage.'}
          </p>
        </div>

        <section className="sec">
          <SectionHead no="01" title="PROJECT" />
          <div className="field">
            <label htmlFor="name">Project name</label>
            <input id="name" required value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="Payment API PQC Migration" />
          </div>
          <div className="field">
            <label htmlFor="repo">Repository URL</label>
            {/* Not editable on an existing project: every finding, graph node and
                piece of evidence points into this repository at a commit, so
                changing it would orphan all of them while looking like an edit. */}
            <input id="repo" required type="url" value={repositoryUrl}
                   disabled={editing} readOnly={editing}
                   onChange={(e) => setRepositoryUrl(e.target.value)}
                   placeholder="https://github.com/northwind-pay/payments-api" />
            <div className="mono field-note">
              {editing
                ? 'FIXED FOR THE LIFE OF THE PROJECT — EVERY FINDING POINTS INTO IT. '
                  + 'POINT PROTEUS AT A DIFFERENT REPOSITORY BY CREATING A NEW PROJECT.'
                : 'READ-ONLY UNTIL MIGRATION IS APPROVED'}
            </div>
          </div>
        </section>

        <section className="sec">
          <SectionHead no="02" title={'REPOSITORY ACCESS & CREDENTIALS'} />
          <div className="field">
            <label htmlFor="pat">GitHub fine-grained personal access token</label>
            {/* A password field: the value is a live credential and must not be
                shoulder-readable or captured by a screen recording. */}
            <input id="pat" required={!editing} type="password" autoComplete="off"
                   spellCheck={false}
                   value={githubToken} onChange={(e) => setGithubToken(e.target.value)}
                   placeholder={editing
                     ? `${loaded?.repository.credential?.displayPrefix ?? 'github_pat_'}… — leave blank to keep`
                     : 'github_pat_…'} />
            {masked && (
              <div className="field-echo">
                <span className="mono field-echo-value">{masked}</span>
                <span className="mono field-echo-state">WRITE-ONLY</span>
              </div>
            )}
            <div className="mono field-note">
              {editing
                ? 'LEAVE BLANK TO KEEP THE STORED TOKEN. A NEW ONE IS STORED AS A NEW '
                  + 'SECRET VERSION · NEVER RETURNED TO THE BROWSER'
                : 'SCOPED TO THIS REPOSITORY · NEVER RETURNED TO THE BROWSER · '
                  + 'ROTATION REMINDER 90 DAYS'}
            </div>
          </div>
          {scopes.length > 0 && (
            <div className="scopes">
              <span className="mono scopes-label">REQUIRED SCOPES</span>
              {scopes.map((s) => <span key={s} className="mono scope">{s}</span>)}
            </div>
          )}
        </section>

        <FileSection
          no="03" title="HARDWARE / OT / INFRASTRUCTURE" kinds={HARDWARE_KINDS} tone="var(--vio)"
          blurb="OT / IoT / HSM specifications, firmware and security architecture documents — dependencies that cannot be inferred from source."
          files={hardware} onAdd={(fl, k) => void addFiles(fl, k, setHardware)}
          onRemove={(i) => setHardware((p) => p.filter((_, j) => j !== i))}
        />

        <FileSection
          no="04" title="EXISTING FINDINGS" kinds={FINDING_KINDS} tone="var(--acc)"
          blurb="CBOM exports, crypto discovery reports, SAST findings and PQC-readiness assessments, correlated against source."
          files={findings} onAdd={(fl, k) => void addFiles(fl, k, setFindings)}
          onRemove={(i) => setFindings((p) => p.filter((_, j) => j !== i))}
        />

        <section className="sec">
          <SectionHead no="05" title="AGENT INSTRUCTIONS" optional />
          <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)}
                    placeholder={'Do not modify the industrial gateway integration contract.\nPrefer NIST-selected algorithms.\nSettlement API response contract must not change.'} />
        </section>

        {error && <div className="error">{error}</div>}

        {/* Re-running is a separate decision from editing: changing the
            instructions is cheap and reversible, re-reading the repository is
            neither, and it supersedes the assessment already on screen. */}
        {editing && (
          <label className="rerun">
            <input type="checkbox" checked={rerun}
                   onChange={(e) => setRerun(e.target.checked)} />
            <span>
              Re-run the analysis with these changes
              <span className="rerun-note">
                Discovery reads the repository again and produces a new assessment.
                The current one is superseded.
              </span>
            </span>
          </label>
        )}

        <div className="create-foot">
          <button className="primary compact" type="submit" disabled={busy}>
            {busy
              ? 'Saving…'
              : editing
                ? (rerun ? 'Save & re-run analysis' : 'Save changes')
                : 'Create project & start discovery'}
          </button>
          <button
            className="linkish" type="button"
            onClick={() => navigate(editing ? `/projects/${editingId}/assessment` : '/projects')}
          >
            Cancel
          </button>
        </div>
      </div>

      {/* A panel beside the form, not a footnote under it. What the agent may
          and may not do before approval is the thing to read *while* filling
          this in, which is the whole reason the design puts it here. */}
      <aside className="boundary">
        <div className="mono boundary-title">AUTONOMY BOUNDARY</div>
        <p className="boundary-lede">
          Before your approval the agent may only read, inspect, correlate and propose.
        </p>
        <div className="boundary-rows">
          {BOUNDARY.map((b) => (
            <div key={b.label} className="boundary-row">
              <span className="mono boundary-mark" style={{ color: b.colour }}>{b.mark}</span>
              <span>{b.label}</span>
            </div>
          ))}
        </div>
      </aside>
    </form>
  );
}

/**
 * The numbered rule that heads every section.
 *
 * One component rather than three copies, because the number, the tracking on
 * the title and the rule that fills the remaining width are what make the form
 * read as a sequence rather than a pile of fields.
 */
function SectionHead({ no, title, optional }: { no: string; title: string; optional?: boolean }) {
  return (
    <div className="sec-head">
      <span className="mono sec-no">{no}</span>
      <span className="mono sec-title">{title}</span>
      {optional && <span className="mono sec-optional">OPTIONAL</span>}
      <span className="sec-rule" />
    </div>
  );
}

/** Spec §20's boundary, stated before anything is created rather than after. */
const BOUNDARY = [
  { mark: 'READ', label: 'Repository and configuration', colour: 'var(--ok)' },
  { mark: 'READ', label: 'Uploaded specifications & findings', colour: 'var(--ok)' },
  { mark: 'YES', label: 'Analyze, correlate, classify, map', colour: 'var(--ok)' },
  { mark: 'NO', label: 'Create a migration branch', colour: 'var(--bad)' },
  { mark: 'NO', label: 'Modify source, dependencies or tests', colour: 'var(--bad)' },
  { mark: 'NO', label: 'Deploy anything', colour: 'var(--bad)' },
  { mark: '—', label: 'Credentials held server-side only', colour: 'var(--acc)' },
] as const;

function FileSection({ no, title, blurb, kinds, tone, files, onAdd, onRemove }: {
  no: string; title: string; blurb: string; kinds: readonly string[]; tone: string;
  files: Attachment[]; onAdd: (f: FileList | null, kind: string) => void; onRemove: (i: number) => void;
}) {
  const [kind, setKind] = useState(kinds[0]!);
  return (
    <section className="sec">
      <SectionHead no={no} title={title} optional />
      {/* Dashed, because it is a drop target rather than a filled field. */}
      <div className="dropzone">
        <p className="dropzone-blurb">{blurb}</p>
        <div className="upload">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ').toLowerCase()}</option>)}
          </select>
          <input type="file" multiple onChange={(e) => { onAdd(e.target.files, kind); e.target.value = ''; }} />
        </div>
        {files.length > 0 && (
          <div className="filechips">
            {files.map((f, i) => (
              <span key={`${f.originalName}-${i}`} className="filechip">
                <span className="filechip-dot" style={{ background: tone }} />
                <span className="filechip-name">{f.originalName}</span>
                <span className="mono filechip-meta">
                  {f.kind.replace(/_/g, ' ')} · {fmtSize(f.sizeBytes)}
                </span>
                <button
                  type="button" className="filechip-x" aria-label={`Remove ${f.originalName}`}
                  onClick={() => onRemove(i)}
                >×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
