import os from 'node:os';
import { buildApp } from './app.js';
import { config, configFilePath, ensureDirs, paths } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { attachWebSocket } from './ws/hub.js';
import { startCleanupLoop } from './services/cleanup.js';
import { getSettings } from './services/settings.js';
import { mailConfigured, setMailLogger } from './services/mail.js';
import { checkForUpdate } from './services/selfupdate.js';
import { APP_VERSION } from './version.js';

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
  setMailLogger(app.log);
  const stopCleanup = startCleanupLoop(app.log);

  await app.listen({ host: config.host, port: config.port });

  const detachWs = attachWebSocket(app.server, app.log);
  const settings = getSettings();

  /*
   * Look for a newer BetSend, so the Admin page can say one exists. It
   * only ever says so: installing is a button somebody presses, because
   * this machine is the whole office's file transfer and three in the
   * afternoon is not a moment anything should pick for itself.
   *
   * A check that fails is logged and forgotten. On a network with no way
   * out every one of them will fail, and that is not a fault.
   */
  const lookForUpdate = (): void => {
    void checkForUpdate(APP_VERSION).then((status) => {
      if (status.available) app.log.info(`BetSend ${status.available} is available`);
      else if (status.error) app.log.debug({ err: status.error }, 'update check failed');
    });
  };
  // Not during boot: it is a network call and nothing waits on its answer.
  const firstLook = setTimeout(lookForUpdate, 60_000);
  const everyFewHours = setInterval(lookForUpdate, 6 * 3600_000);
  firstLook.unref();
  everyFewHours.unref();

  app.log.info(
    {
      // Which config file won, so a surprising setting is traceable.
      config: configFilePath ?? '(none — defaults and environment only)',
      database: config.dbPath,
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

  if (!mailConfigured()) {
    app.log.warn(
      'No mail relay configured (smtpHost/smtpFrom). Nobody can register or reset a password, and recipients will not be told files are waiting.',
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
