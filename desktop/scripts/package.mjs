/**
 * Runs electron-builder.
 *
 * It exists because of npm workspaces: electron is hoisted to the repository
 * root, electron-builder only looks in the app's own node_modules, and it
 * refuses to guess from a caret range ("^33.3.1"). Rather than pinning the
 * version twice and letting the two drift, read it off the package that is
 * actually installed and pass it in.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let electronVersion;
try {
  electronVersion = require('electron/package.json').version;
} catch {
  console.error(
    'Electron is not installed. The repo .npmrc blocks install scripts, which is what\n' +
      'stops npm compiling better-sqlite3 — it also stops Electron fetching its runtime.\n' +
      'Run:  npm rebuild electron --no-ignore-scripts',
  );
  process.exit(1);
}

const targets = process.argv.slice(2);
const args = [
  ...(targets.length ? targets : ['--win']),
  '--publish',
  'never',
  `--config.electronVersion=${electronVersion}`,
];

console.log(`electron-builder ${args.join(' ')}`);
const result = spawnSync('npx', ['--no-install', 'electron-builder', ...args], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
