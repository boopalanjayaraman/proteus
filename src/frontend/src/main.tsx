import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import { AuthProvider } from './app/AuthContext';
import { ThemeProvider } from './app/ThemeContext';
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
