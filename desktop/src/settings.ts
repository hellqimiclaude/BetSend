import fs from 'node:fs';
import path from 'node:path';

/**
 * What the app remembers between runs: the server it talks to, where its
 * window was, and whether it starts with Windows.
 *
 * Deliberately a plain JSON file and no dependency. There is very little here,
 * and a settings file somebody can open in Notepad to fix a wrong address is
 * worth more to whoever supports this than a tidy abstraction.
 *
 * Nothing in here imports Electron, so it can be tested without one.
 */

export interface Settings {
  /** Origin of the BetSend server, e.g. http://betsend-pc:8080. */
  serverUrl: string | null;
  startWithWindows: boolean;
  window: { width: number; height: number; x?: number; y?: number; maximized: boolean } | null;
}

export const DEFAULTS: Settings = {
  serverUrl: null,
  startWithWindows: true,
  window: null,
};

/**
 * Read settings, falling back to defaults for anything missing or wrong.
 *
 * A corrupt settings file must never stop the app opening: the worst it can
 * cost somebody is retyping the server address, and an app that refuses to
 * start because of its own cache file is indefensible.
 */
export function readSettings(file: string): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };

  const raw = parsed as Record<string, unknown>;
  return {
    serverUrl: typeof raw.serverUrl === 'string' && raw.serverUrl ? raw.serverUrl : null,
    startWithWindows:
      typeof raw.startWithWindows === 'boolean' ? raw.startWithWindows : DEFAULTS.startWithWindows,
    window: readWindow(raw.window),
  };
}

function readWindow(raw: unknown): Settings['window'] {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const width = Number(w.width);
  const height = Number(w.height);
  // A zero or negative size would open a window nobody can see or grab.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 320) return null;

  const x = Number(w.x);
  const y = Number(w.y);
  return {
    width: Math.round(width),
    height: Math.round(height),
    ...(Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : {}),
    maximized: w.maximized === true,
  };
}

export function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written without a byte-order mark, for the same reason config.json is:
  // JSON.parse treats one as a stray character and refuses the file.
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), { encoding: 'utf8' });
}
