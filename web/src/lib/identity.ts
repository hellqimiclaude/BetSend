const STORAGE_KEY = 'betsend.user';

/** The chosen name is remembered so returning users skip the picker. */
export function loadIdentity(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveIdentity(name: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* ignore — the user will just be asked again next time */
  }
}

export function clearIdentity(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
