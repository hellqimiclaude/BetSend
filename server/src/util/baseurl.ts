import os from 'node:os';
import { config } from '../config.js';

/**
 * The address to put in an email.
 *
 * A relative link is fine inside the app but useless in a mailbox, so this
 * always returns something absolute. `publicUrl` wins when it is set; on a
 * LAN install there is no such name, so fall back to the first non-loopback
 * IPv4 address of this machine — which is exactly what the installer prints
 * and what people have in their bookmarks.
 */
let cached: string | null = null;

export function appBaseUrl(): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  if (cached) return cached;

  let address = 'localhost';
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        address = entry.address;
        break;
      }
    }
    if (address !== 'localhost') break;
  }

  cached = config.port === 80 ? `http://${address}` : `http://${address}:${config.port}`;
  return cached;
}

/** Recomputed by tests, and after a configuration change. */
export function resetBaseUrl(): void {
  cached = null;
}
