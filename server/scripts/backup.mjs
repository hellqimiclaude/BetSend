/**
 * Takes a consistent copy of the BetSend database while the server runs.
 *
 *     npm run backup -w server                      -> <storage>/backups/
 *     npm run backup -w server -- D:\somewhere\else
 *
 * What is worth keeping is the database: the accounts, who sent what to whom,
 * and what has been read. The uploaded files are not -- they are deleted
 * after the retention window anyway.
 */
import path from 'node:path';
import { config, configFilePath } from '../dist/config.js';
import { backupDatabase, backupName } from '../dist/services/backup.js';

const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(config.storageDir, 'backups');

console.log(`Config:   ${configFilePath ?? '(defaults and environment only)'}`);
console.log(`Database: ${config.dbPath}`);

try {
  const result = await backupDatabase(config.dbPath, path.join(target, backupName()));
  console.log(`Backup:   ${result.destination}`);
  console.log(
    `          ${(result.bytes / 1024 / 1024).toFixed(1)} MB, ` +
      `${result.users} user(s), ${result.transfers} transfer(s), integrity ok`,
  );
} catch (err) {
  console.error(`\nBackup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
