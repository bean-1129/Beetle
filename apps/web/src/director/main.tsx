import { createRoot } from 'react-dom/client';
import '../shared/platform.css';
import { DirectorApp } from './App.tsx';

createRoot(document.getElementById('root') as HTMLElement).render(<DirectorApp />);
