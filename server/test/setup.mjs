// Loaded with --import before any application module, so the config singleton
// (captured at import time) points at a throwaway directory rather than the
// developer's real data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-test-'));

process.env.STORAGE_DIR = root;
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.LOG_LEVEL = 'silent';
process.env.RETENTION_HOURS = '72';
process.env.ORPHAN_UPLOAD_HOURS = '24';
process.env.MIN_FREE_DISK_BYTES = '0';
process.env.PER_USER_UPLOAD_BYTES = '0';
// Point at a path that cannot exist so a config.json in the repo root never
// leaks into a test run.
process.env.CONFIG_FILE = path.join(root, 'no-such-config.json');

process.env.BETSEND_TEST_ROOT = root;

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
