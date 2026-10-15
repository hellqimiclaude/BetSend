import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Encoding guards for the Windows installer.
 *
 * These caught nothing when they were written, because they were written
 * after the fact: a box-drawing character in install.ps1 is UTF-8 `e2 94 80`,
 * and Windows PowerShell 5.1 reads a file without a BOM as the system ANSI
 * codepage, where byte 0x94 is a double quote. Ninety-six of them turned the
 * script into something the parser could not read, and nothing on Linux could
 * see it. Keeping these files pure ASCII removes the encoding question
 * entirely; keeping them CRLF matters because the setup file is downloaded
 * from GitHub rather than checked out, and cmd.exe mishandles LF labels.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function windowsScripts(): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(repoRoot)) {
    if (entry.toLowerCase().endsWith('.bat')) found.push(path.join(repoRoot, entry));
  }
  const scripts = path.join(repoRoot, 'scripts');
  for (const entry of fs.readdirSync(scripts)) {
    if (entry.toLowerCase().endsWith('.ps1')) found.push(path.join(scripts, entry));
  }
  return found;
}

/**
 * `Set-Content -Encoding UTF8` means "UTF-8 with a byte-order mark" on Windows
 * PowerShell 5.1. Node's JSON.parse treats that mark as a stray character, so
 * a freshly installed BetSend stopped at startup with "Unexpected token" and
 * said nothing about configuration. Files Node reads go through the
 * Write-JsonFile helper, which writes the same bytes without the mark.
 */
describe('JSON the installer writes for Node to read', () => {
  const scripts = [
    path.join(repoRoot, 'scripts', 'install.ps1'),
    path.join(repoRoot, 'installer', 'build-payload.ps1'),
  ];

  for (const script of scripts) {
    const name = path.relative(repoRoot, script);

    test(`${name} writes JSON without a byte-order mark`, () => {
      const offenders = fs
        .readFileSync(script, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('#'))
        .filter((line) => /Set-Content|Out-File/.test(line) && /\.json|ConvertTo-Json/.test(line));

      assert.deepEqual(
        offenders,
        [],
        `${name} writes JSON with Set-Content/Out-File — use Write-JsonFile, or PowerShell 5.1 adds a BOM Node will not parse`,
      );
    });

    test(`${name} has the Write-JsonFile helper`, () => {
      assert.match(fs.readFileSync(script, 'utf8'), /function Write-JsonFile/);
    });
  }
});

describe('Windows scripts', () => {
  const files = windowsScripts();

  test('there are some to check', () => {
    assert.ok(files.length >= 5, `expected the installer scripts, found ${files.length}`);
  });

  for (const file of files) {
    const name = path.relative(repoRoot, file);

    test(`${name} is pure ASCII`, () => {
      const bytes = fs.readFileSync(file);
      const offenders: string[] = [];

      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] > 0x7e) {
          const line = bytes.subarray(0, i).toString('latin1').split('\n').length;
          offenders.push(`line ${line}: byte 0x${bytes[i].toString(16)}`);
          if (offenders.length >= 5) break;
        }
      }

      assert.deepEqual(
        offenders,
        [],
        `${name} must stay ASCII — PowerShell 5.1 reads it as the ANSI codepage, where UTF-8 bytes become stray quotes`,
      );
    });

    test(`${name} uses CRLF line endings`, () => {
      const text = fs.readFileSync(file, 'latin1');
      const allLineFeeds = (text.match(/\n/g) ?? []).length;
      const carriageReturns = (text.match(/\r\n/g) ?? []).length;

      assert.ok(allLineFeeds > 0, `${name} looks empty`);
      assert.equal(carriageReturns, allLineFeeds, `${name} has ${allLineFeeds - carriageReturns} bare LF line endings`);
    });
  }
});
