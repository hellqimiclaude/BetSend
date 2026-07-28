export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'betsend.theme';

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function isDark(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && prefersDark());
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', isDark(theme));
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private browsing — the theme just won't persist */
  }
}

/** Keep following the OS while the user has not made an explicit choice. */
export function watchSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
