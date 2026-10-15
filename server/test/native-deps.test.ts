import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards on the one npm setting that decides whether BetSend installs on a
 * normal office PC.
 *
 * better-sqlite3 carries a compiled binary for every platform inside its own
 * package and loads it at runtime, so no compiler is needed. It also carries
 * a binding.gyp, and npm compiles any package that has one, before the
 * prebuilt binary is ever looked at. On Linux that extra build succeeds
 * silently; on Windows it stops with "could not find any Visual Studio
 * installation to use" and the install is over. Hence `ignore-scripts`.
 *
 * Nothing in CI on Linux notices when this regresses, which is why it is
 * asserted here.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('native dependencies install without a compiler', () => {
  test('the repo .npmrc turns install scripts off', () => {
    const npmrc = read('.npmrc');
    const setting = npmrc
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(';') && !line.startsWith('#'));

    assert.deepEqual(setting, ['ignore-scripts=true']);
  });

  test('better-sqlite3 brings a Windows binary rather than building one', () => {
    const prebuilds = path.join(repoRoot, 'node_modules', 'better-sqlite3', 'prebuilds');
    assert.ok(fs.existsSync(path.join(prebuilds, 'win32-x64.node')), 'no win32-x64 prebuild');
    assert.ok(fs.existsSync(path.join(prebuilds, 'linux-x64.node')), 'no linux-x64 prebuild');
  });

  test('nothing compiled better-sqlite3 in this tree', () => {
    const built = path.join(repoRoot, 'node_modules', 'better-sqlite3', 'build');
    assert.equal(
      fs.existsSync(built),
      false,
      'better-sqlite3 was compiled from source, so npm ran node-gyp — the same npm would fail on Windows',
    );
  });

  // The installer scripts run where a stale global config might say otherwise,
  // and the staging tree in build-payload.ps1 has its own package.json, which
  // makes npm read that directory's .npmrc instead of the repo's.
  for (const script of ['scripts/install.ps1', 'installer/build-payload.ps1']) {
    test(`${script} passes --ignore-scripts to every npm install`, () => {
      const lines = read(script).split(/\r?\n/);
      // Only lines that start a command, so the `throw 'npm ci failed'` that
      // follows each one does not count as an invocation.
      const installs = lines.filter((line) =>
        /^(&\s*\$npm\.Source|npm(\.cmd)?)\s+(install|ci)\b/.test(line.trim()),
      );

      assert.ok(installs.length > 0, `found no npm install in ${script}`);
      for (const line of installs) {
        assert.match(line, /--ignore-scripts/, `${script}: ${line.trim()}`);
      }
    });
  }
});
