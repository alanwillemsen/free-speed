import { useEffect, useState } from 'react';

// Chart.js "chrome" colors (axis ticks, grid lines, titles) pulled from the
// active theme tokens so charts stay legible in both light and dark mode.
// Dataset line hues are chosen per-chart and left alone — these only cover the
// surrounding scaffolding. Read at render time so a theme switch is picked up.

const readVar = (name, fallback) => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
};

export function chartChrome() {
  return {
    tick: readVar('--text-muted', '#4a5568'),
    grid: readVar('--border', '#e2e8f0'),
    title: readVar('--text', '#2d3748'),
  };
}

// Hook variant: returns chartChrome() and re-renders the caller when the theme
// changes (useTheme dispatches a 'themechange' event), so chart options pick up
// the new colors live.
export function useChartChrome() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = () => setTick((t) => t + 1);
    window.addEventListener('themechange', h);
    return () => window.removeEventListener('themechange', h);
  }, []);
  return chartChrome();
}
