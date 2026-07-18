import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import PreferencesApp from './PreferencesApp';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{view === 'preferences' ? <PreferencesApp /> : <App />}</StrictMode>
);
