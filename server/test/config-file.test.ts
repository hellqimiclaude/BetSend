import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

/**
 * config.json is written by the Windows installer and then read by Node, and
 * the two disagreed about byte-order marks.
 *
 * PowerShell 5.1's `Set-Content -Encoding UTF8` prefixes one. JSON.parse
 * treats it as a stray character and refuses the file, so a freshly installed
 * BetSend died at startup with "Unexpected token" and never printed
 * anything about configuration. The installer writes BOM-less files now, but
 * an admin editing config.json in a Windows editor can reintroduce one at any
 * time, so the reader tolerates it as well.
 */

// Written as an escape: a real BOM byte in this file would be invisible.
const BOM = '\uFEFF';

const tempFiles: string[] = [];

function writeConfig(contents: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-config-')), 'config.json');
  fs.writeFileSync(file, contents);
  tempFiles.push(file);
  return file;
}

// Put it back rather than deleting it: with CONFIG_FILE unset, the config
// loader walks up from the working directory and would find the developer's
// real config.json.
const originalConfigFile = process.env.CONFIG_FILE;
afterEach(() => {
  process.env.CONFIG_FILE = originalConfigFile;
});

describe('reading config.json', () => {
  test('a byte-order mark does not stop the server starting', () => {
    process.env.CONFIG_FILE = writeConfig(BOM + '{ "port": 9119, "smtpHost": "mail.betlive.com" }');

    const config = loadConfig();

    assert.equal(config.port, 9119);
    assert.equal(config.smtpHost, 'mail.betlive.com');
  });

  test('the ordinary case still works', () => {
    process.env.CONFIG_FILE = writeConfig('{ "port": 9120 }');
    assert.equal(loadConfig().port, 9120);
  });

  test('genuinely broken JSON still says which file', () => {
    const file = writeConfig('{ "port": ');
    process.env.CONFIG_FILE = file;

    assert.throws(() => loadConfig(), (err: Error) => err.message.includes(file));
  });
});

describe('the shipped example config', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  test('parses, and has no byte-order mark of its own', () => {
    const bytes = fs.readFileSync(path.join(repoRoot, 'config.example.json'));
    assert.notDeepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], 'config.example.json starts with a BOM');
    JSON.parse(bytes.toString('utf8'));
  });
});
