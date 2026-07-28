import os from 'node:os';
import { buildApp } from './app.js';
import { config, ensureDirs, paths } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { attachWebSocket } from './ws/hub.js';
import { startCleanupLoop } from './services/cleanup.js';
import { getSettings } from './services/settings.js';

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

async function main(): Promise<void> {
  ensureDirs();
  getDb(); // apply schema before anything can query

  const app = await buildApp();
  const stopCleanup = startCleanupLoop(app.log);

  await app.listen({ host: config.host, port: config.port });

  const detachWs = attachWebSocket(app.server, app.log);
  const settings = getSettings();

  app.log.info(
    {
      storage: paths.root,
      retentionHours: settings.retentionHours,
      deleteAfterAllDownloaded: settings.deleteAfterAllDownloaded,
      registrationMode: settings.registrationMode,
      maxUploadSize: settings.maxUploadSize || 'unlimited',
    },
    'BetSend ready',
  );

  const addresses = lanAddresses();
  if (addresses.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `\n  BetSend is running. Colleagues can open:\n${addresses
        .map((ip) => `    http://${ip}:${config.port}`)
        .join('\n')}\n`,
    );
  }

  if (config.adminToken === 'change-me') {
    app.log.warn('ADMIN_TOKEN is still the default "change-me" — set your own before using this in the office.');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    stopCleanup();
    detachWs();
    try {
      await app.close();
    } finally {
      closeDb();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('BetSend failed to start:', err);
  process.exit(1);
});
