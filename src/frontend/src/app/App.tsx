import type { Project } from '@proteus/schema';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { screenForPath } from '../lib/activity';
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
};

/** Loads the project named in the route, so the header and nav can derive from it. */
function useRouteProject(): Project | null {
  const { id } = useParams<{ id: string }>();
  const { api, firebaseUser } = useAuth();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    if (!id || !firebaseUser) { setProject(null); return; }
    let cancelled = false;
    api.project(id).then((p) => { if (!cancelled) setProject(p); }).catch(() => setProject(null));
    return () => { cancelled = true; };
  }, [id, firebaseUser, api]);

  return project;
}

function Shell() {
  const project = useRouteProject();
  const { pathname } = useLocation();
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
        <main className="main">
          <Routes>
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/new" element={<CreateProject />} />
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
