import { useState } from 'react';
import { useTheme } from '../hooks/useTheme';

// Global navigation shell shared by every page: a slim top bar (☰ · title ·
// optional page actions) over a slide-out drawer that reaches every
// destination from anywhere. Replaces the old per-page headers and back
// buttons. Pages render <AppShell page=… title=…>…body…</AppShell>.

const DESTINATIONS = [
  { id: 'calculator', label: 'Efficiency Calculator', hash: '' },
  { id: 'live', label: 'Live Stroke Capture', hash: '#live' },
  { id: 'course', label: 'Course Marks', hash: '#course' },
  { id: 'analyze', label: 'Video Analysis', hash: '#analyze' },
  { id: 'tradeoffs', label: 'Tradeoffs', hash: '#tradeoffs' },
];

const GithubIcon = () => (
  <svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
      0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
      -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
      .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
      -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
      .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
      .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
      0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

function AppShell({ page, title, actions, immersive = false, children }) {
  const [open, setOpen] = useState(false);
  const { resolved, toggle } = useTheme();
  const isDark = resolved === 'dark';

  const go = (hash) => {
    setOpen(false);
    if (window.location.hash === hash || (hash === '' && !window.location.hash)) return;
    window.location.hash = hash;
  };

  return (
    <div className={`app-shell${immersive ? ' app-shell-immersive' : ''}`}>
      <header className={`app-bar${immersive ? ' app-bar-overlay' : ''}`}>
        <button
          className="app-bar-btn"
          onClick={() => setOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={open}
        >☰</button>
        <h1 className="app-bar-title">{title}</h1>
        <div className="app-bar-actions">{actions}</div>
      </header>

      {open && <div className="app-drawer-scrim" onClick={() => setOpen(false)} />}

      <nav className={`app-drawer${open ? ' open' : ''}`} aria-label="Primary">
        <div className="app-drawer-head">
          <span className="app-drawer-brand">Free Speed</span>
          <button className="app-bar-btn" onClick={() => setOpen(false)} aria-label="Close menu">✕</button>
        </div>

        <ul className="app-drawer-nav">
          {DESTINATIONS.map((d) => (
            <li key={d.id}>
              <button
                className={`app-drawer-link${d.id === page ? ' active' : ''}`}
                onClick={() => go(d.hash)}
                aria-current={d.id === page ? 'page' : undefined}
              >
                {d.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="app-drawer-divider" />

        <button className="app-drawer-row" onClick={toggle} role="switch" aria-checked={isDark}>
          <span>{isDark ? '☾' : '☀'} {isDark ? 'Dark mode' : 'Light mode'}</span>
          <span className="app-drawer-toggle" data-on={isDark}><span /></span>
        </button>

        <div className="app-drawer-divider" />

        <a className="app-drawer-row" href="/math.html" target="_blank" rel="noopener noreferrer">
          Mathematical background ↗
        </a>
        <a className="app-drawer-row" href="https://github.com/alanwillemsen/free-speed" target="_blank" rel="noopener noreferrer">
          <span>GitHub</span><GithubIcon />
        </a>
      </nav>

      <div className="app-shell-body">{children}</div>
    </div>
  );
}

export default AppShell;
