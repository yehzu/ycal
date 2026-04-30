import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DragProvider } from './dragController';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DragProvider>
      <App />
    </DragProvider>
  </StrictMode>,
);
