import type { Project } from '@proteus/schema';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { Nav } from '../components/layout/Nav';
import { CreateProject } from '../screens/CreateProject';
import { Discovery } from '../screens/discovery/Discovery';
import { Login } from '../screens/Login';
import { Projects } from '../screens/Projects';
import { Placeholder } from '../screens/Placeholder';
import { useAuth } from './AuthContext';

const CRUMBS: Record<string, string> = {
  projects: 'PROTEUS / PROJECTS',
  new: 'PROTEUS / PROJECTS / NEW',
  discovery: 'DISCOVERY',
  assessment: 'ASSESSMENT',
  migration: 'MIGRATION',
  sandbox: 'SANDBOX & REPORT',
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
  const last = pathname.split('/').filter(Boolean).pop() ?? 'projects';
  const crumb = project
    ? `${project.projectId} / ${CRUMBS[last] ?? last.toUpperCase()}`
    : CRUMBS[last] ?? 'PROTEUS';

  return (
    <div className="shell">
      <Header crumb={crumb} project={project} />
      <div className="body">
        <Nav project={project} />
        <main className="main">
          <Routes>
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/new" element={<CreateProject />} />
            <Route path="/projects/:id/discovery" element={<Discovery />} />
            <Route path="/projects/:id/assessment" element={<Placeholder title="Assessment & migration decision" prd="PRD-09 · PRD-10" />} />
            <Route path="/projects/:id/migration" element={<Placeholder title="Live autonomous migration" prd="PRD-11 · PRD-12" />} />
            <Route path="/projects/:id/sandbox" element={<Placeholder title="Sandbox & report" prd="PRD-13 · PRD-14" />} />
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
