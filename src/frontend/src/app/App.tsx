import type { Project } from '@proteus/schema';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { projectIdFromPath, screenForPath } from '../lib/activity';
import { READ_ONLY_NOTICE, isArchived } from '../lib/lifecycle';
import { Activity } from '../screens/Activity';
import { Header } from '../components/layout/Header';
import { Nav } from '../components/layout/Nav';
import { CreateProject } from '../screens/CreateProject';
import { Assessment } from '../screens/assessment/Assessment';
import { Discovery } from '../screens/discovery/Discovery';
import { Migration } from '../screens/migration/Migration';
import { Completion } from '../screens/sandbox/Completion';
import { Login } from '../screens/Login';
import { Projects } from '../screens/Projects';
import { useAuth } from './AuthContext';

const CRUMBS: Record<string, string> = {
  projects: 'PROTEUS / PROJECTS',
  new: 'PROTEUS / PROJECTS / NEW',
  discovery: 'DISCOVERY',
  assessment: 'ASSESSMENT',
  migration: 'MIGRATION',
  sandbox: 'SANDBOX & REPORT',
  activity: 'PROTEUS / ACTIVITY',
  edit: 'EDIT PROJECT',
};

/**
 * Loads the project named in the route, so the header and nav can derive from it.
 *
 * The id comes from the pathname rather than `useParams`, because this hook runs
 * in the shell — which renders `<Routes>` as a child and is therefore outside
 * every route that declares `:id`.
 */
/** Often enough that a stage change is visible, rarely enough to be invisible. */
const REFRESH_MS = 4000;

function useRouteProject(pathname: string): Project | null {
  const id = projectIdFromPath(pathname);
  const { api, firebaseUser } = useAuth();
  const [project, setProject] = useState<Project | null>(null);

  /**
   * The selection outlives the route.
   *
   * Going to the project list is how you *pick* a project, not how you abandon
   * one — clearing the rail on the way there means the list is the one screen
   * from which you cannot get back to what you were doing. The selection changes
   * only when another project is opened, and clears only on sign-out.
   */
  const selectedId = id ?? project?.projectId ?? null;

  useEffect(() => {
    if (!firebaseUser) { setProject(null); return; }
    if (!selectedId) return;

    let cancelled = false;
    const load = () => {
      api.project(selectedId)
        .then((p) => { if (!cancelled) setProject(p); })
        // A project that has been deleted stops being the selection, rather
        // than leaving the rail pointing at something no longer there.
        .catch(() => { if (!cancelled) setProject(null); });
    };
    load();

    /**
     * Kept fresh while the work is still moving.
     *
     * The rail reads `summary` to decide which screens are reachable, and it
     * used to read whatever was true when the page loaded. A project opened at
     * CREATED stayed CREATED in the rail through discovery, approval and the
     * whole migration — so every screen the project had actually reached stayed
     * disabled, and there was no way to go back and look at the evidence.
     *
     * A poll rather than a second event stream: the screens already hold one
     * each, and opening another from the shell would double every connection to
     * keep one card and four nav items current.
     */
    const settled = project?.stage === 'COMPLETED' || project?.lifecycle !== 'ACTIVE';
    if (settled) return () => { cancelled = true; };

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedId, firebaseUser, api, project?.stage, project?.lifecycle]);

  return project;
}

function Shell() {
  const { pathname } = useLocation();
  const project = useRouteProject(pathname);
  const { api } = useAuth();

  /**
   * Tells the client which screen it is on.
   *
   * Set before the screens render, so the calls a screen makes on mount already
   * carry it — the backend records a page visit from the first of those rather
   * than from a beacon, and a header set after mount would attribute the visit
   * to the previous screen. An unrecognised path sets nothing rather than
   * guessing (PRD-15 FR-3a).
   */
  api.screen = screenForPath(pathname);

  const last = pathname.split('/').filter(Boolean).pop() ?? 'projects';
  const crumb = project
    ? `${project.projectId} / ${CRUMBS[last] ?? last.toUpperCase()}`
    : CRUMBS[last] ?? 'PROTEUS';

  return (
    // The rail is the chrome; the breadcrumb bar sits inside the main column
    // rather than across the top, which is what UX v1.3 shows.
    <div className="shell">
      <Nav project={project} />
      <div className="body">
        <Header crumb={crumb} project={project} />
        {/* One banner for every screen. The API refuses the writes regardless;
            this is so nobody has to discover that by clicking. */}
        {project && isArchived(project) && (
          <div className="archived-banner">
            <span className="mono archived-badge">ARCHIVED</span>
            <span>{READ_ONLY_NOTICE}</span>
          </div>
        )}
        <main className="main">
          <Routes>
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/new" element={<CreateProject />} />
            {/* The same screen: editing describes the same thing creating does. */}
            <Route path="/projects/:id/edit" element={<CreateProject />} />
            <Route path="/projects/:id/discovery" element={<Discovery />} />
            <Route path="/projects/:id/assessment" element={<Assessment />} />
            <Route path="/projects/:id/migration" element={<Migration />} />
            <Route path="/projects/:id/sandbox" element={<Completion />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="*" element={<Navigate to="/projects" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  const { firebaseUser, loading } = useAuth();
  if (loading) return <div className="booting label">Loading…</div>;
  if (!firebaseUser) return <Login />;
  return <Shell />;
}
