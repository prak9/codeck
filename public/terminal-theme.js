// Run before styles paint; this preference is deliberately separate from Remote.
(() => {
  const key = 'codeck-terminal-theme';
  const root = document.documentElement;
  const normalize = value => value === 'mac' ? 'mac' : 'classic';
  let saved;
  try { saved = localStorage.getItem(key); } catch { /* Storage may be disabled. */ }
  root.dataset.terminalTheme = normalize(saved);
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('terminalThemeSelect');
    select.value = root.dataset.terminalTheme;
    select.addEventListener('change', () => {
      root.dataset.terminalTheme = normalize(select.value);
      try { localStorage.setItem(key, root.dataset.terminalTheme); } catch { /* Page-only preference. */ }
    });
  });
})();
