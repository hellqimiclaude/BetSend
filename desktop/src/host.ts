import { session as electronSession } from 'electron';

/**
 * The session cookie, read out of the window's own cookie jar.
 *
 * The upload happens in the main process but must look like the signed-in
 * user, and the only place that identity exists is the cookie the window got
 * when they signed in. Reading it here means there is no second login and no
 * second credential to store -- sign out in the window and this stops working
 * too, which is the behaviour anybody would expect.
 */
export const COOKIE_NAME = 'bs_session';

export async function sessionCookieFor(origin: string): Promise<string | null> {
  try {
    const cookies = await electronSession.defaultSession.cookies.get({ url: origin, name: COOKIE_NAME });
    const cookie = cookies[0];
    return cookie ? `${cookie.name}=${cookie.value}` : null;
  } catch {
    return null;
  }
}
