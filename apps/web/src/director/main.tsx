import { createRoot } from 'react-dom/client';
import '../shared/platform.css';
import { DirectorApp } from './App.tsx';
import { ensureDirectorToken } from '../shared/token.ts';

void ensureDirectorToken().finally(() => {
  createRoot(document.getElementById('root') as HTMLElement).render(<DirectorApp />);
});
