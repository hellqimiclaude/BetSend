const LAST_EMAIL_KEY = 'betsend.lastEmail';

/**
 * The signed-in identity lives in an httpOnly cookie the browser handles for
 * us. All we keep here is the address last typed at the sign-in screen, so a
 * returning colleague only has to enter their password.
 */

export function rememberedEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberEmail(email: string): void {
  try {
    localStorage.setItem(LAST_EMAIL_KEY, email);
  } catch {
    /* private browsing - they will just type it again */
  }
}

export function forgetEmail(): void {
  try {
    localStorage.removeItem(LAST_EMAIL_KEY);
  } catch {
    /* ignore */
  }
}
