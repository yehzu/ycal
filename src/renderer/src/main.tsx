import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DragProvider } from './dragController';
import { QuickAdd } from './QuickAdd';
import './styles.css';

// Two renderer entry shapes share a single bundle: the full calendar app
// and the small quick-add popup. The main process picks which one to
// load via the `mode` query param when it creates each BrowserWindow.
const params = new URLSearchParams(window.location.search);
const mode = params.get('mode');

const root = createRoot(document.getElementById('root')!);

if (mode === 'quickadd') {
  document.body.classList.add('mode-quickadd');
  root.render(
    <StrictMode>
      <QuickAdd />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <DragProvider>
        <App />
      </DragProvider>
    </StrictMode>,
  );
}
