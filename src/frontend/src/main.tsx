import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import { AuthProvider } from './app/AuthContext';
import { ThemeProvider } from './app/ThemeContext';
// IBM Plex, self-hosted.
//
// The UX canvas sets every rule in IBM Plex Sans or Mono, and the app was
// falling back to system fonts — which is most of what made it look unlike the
// design. Bundled rather than linked from Google Fonts: it removes a
// third-party request from the critical path, works offline, and keeps the
// Cloud Run deployment free of an external dependency it cannot control.
// Only the four weights the design actually uses.
import '@fontsource/ibm-plex-sans/300.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import './styles/tokens.css';
import './styles/shell.css';
import './styles/discovery.css';
import './styles/assessment.css';
import './styles/migration.css';
import './styles/activity.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
