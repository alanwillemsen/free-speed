import { useCallback, useEffect, useState } from 'react';

// Light/dark theme, applied as data-theme on <html>.
//
// Preference model: if the user has made an explicit choice it is stored in
// localStorage and wins; otherwise we follow the OS setting live. Toggling
// always writes an explicit choice. The attribute is also set pre-paint in
// index.html so there's no flash before React mounts — this hook keeps it in
// sync and re-renders the toggle UI.

const KEY = 'freespeed_theme';

const systemPrefersDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-color-scheme: dark)').matches;

// The stored explicit choice ('light' | 'dark'), or null to follow the system.
export const storedTheme = () => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
};

// The theme that should currently be applied, honouring an explicit choice.
export const resolveTheme = () => storedTheme() ?? (systemPrefersDark() ? 'dark' : 'light');

const apply = (theme) => {
  document.documentElement.dataset.theme = theme;
};

export function useTheme() {
  const [resolved, setResolved] = useState(resolveTheme);

  // Re-apply whenever the resolved theme changes, and notify theme-dependent
  // consumers that read CSS variables imperatively (e.g. chart.js colors).
  useEffect(() => {
    apply(resolved);
    window.dispatchEvent(new Event('themechange'));
  }, [resolved]);

  // Follow the OS while no explicit choice is stored.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onChange = () => { if (!storedTheme()) setResolved(resolveTheme()); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((next) => {
    try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
    setResolved(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(resolveTheme() === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  return { resolved, setTheme, toggle };
}
