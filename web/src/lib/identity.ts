const LAST_NAME_KEY = 'betsend.lastName';

/**
 * The signed-in identity lives in an httpOnly cookie the browser handles for
 * us. All we keep here is the last name typed at the sign-in screen, so a
 * returning colleague only has to enter their password.
 */

export function rememberedName(): string {
  try {
    return localStorage.getItem(LAST_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(LAST_NAME_KEY, name);
  } catch {
    /* private browsing — they will just type it again */
  }
}

export function forgetName(): void {
  try {
    localStorage.removeItem(LAST_NAME_KEY);
  } catch {
    /* ignore */
  }
}
