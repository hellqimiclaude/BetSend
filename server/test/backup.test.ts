import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase, backupName } from '../src/services/backup.js';
import { getDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { makeTransfer, makeUser, resetState } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The backup is the only thing standing between a dead disk and everybody's
 * accounts, so it gets tested like it matters.
 *
 * The bug it was written around: a read-only connection cannot read SQLite's
 * write-ahead log, so it sees the main file alone and reports a database with
 * nothing in it. The first version of this script copied that happily and
 * said "integrity ok".
 */

let outDir: string;

beforeEach(() => {
  resetState();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-backup-'));
});

describe('backing up the database', () => {
  test('the copy holds what the original holds', async () => {
    const sender = await makeUser('J.Johnson');
    const recipient = await makeUser('M.Beridze');
    makeTransfer(sender.id, [recipient.id], { note: 'the quarterly numbers' });

    const destination = path.join(outDir, backupName());
    const result = await backupDatabase(config.dbPath, destination);

    assert.equal(result.users, 2);
    assert.equal(result.transfers, 1);
    assert.ok(result.bytes > 0);

    const copy = new Database(destination, { readonly: true });
    try {
      const names = copy.prepare('SELECT name FROM users ORDER BY name').all() as { name: string }[];
      assert.deepEqual(names.map((u) => u.name), ['J.Johnson', 'M.Beridze']);
    } finally {
      copy.close();
    }
  });

  /**
   * Writes that have not been checkpointed yet live only in the -wal file.
   * This is the case the read-only version got wrong, so it is written
   * deliberately: make a change, do not checkpoint, back up immediately.
   */
  test('it captures writes still sitting in the write-ahead log', async () => {
    await makeUser('J.Johnson');
    const db = getDb();
    assert.equal((db.pragma('journal_mode', { simple: true }) as string).toLowerCase(), 'wal', 'expected WAL mode');

    // A fresh write with no checkpoint after it.
    await makeUser('M.Beridze');

    const destination = path.join(outDir, backupName());
    const result = await backupDatabase(config.dbPath, destination);

    assert.equal(result.users, 2, 'the newest write did not make it into the copy');
  });

  /**
   * A database left behind by a writer that was killed: rows in the log, no
   * clean close, and nobody holding it open. That is the state a server
   * leaves after a power cut -- which is also exactly when somebody reaches
   * for a backup.
   */
  function abandonedDatabase(rows: number): string {
    const file = path.join(outDir, 'abandoned.db');
    const writer = path.join(outDir, 'writer.mjs');
    fs.writeFileSync(
      writer,
      `
      import Database from ${JSON.stringify(path.join(repoRoot, 'node_modules', 'better-sqlite3', 'lib', 'index.js'))};
      const db = new Database(${JSON.stringify(file)});
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      db.exec('CREATE TABLE transfers (id INTEGER PRIMARY KEY)');
      const insert = db.prepare('INSERT INTO users (name) VALUES (?)');
      for (let i = 0; i < ${rows}; i++) insert.run('person' + i);
      // Killed here: no close, no checkpoint. The rows live only in the log.
      process.kill(process.pid, 'SIGKILL');
      `,
    );

    const ran = spawnSync(process.execPath, [writer], { encoding: 'utf8' });
    assert.equal(ran.signal, 'SIGKILL', `the writer never got as far as being killed: ${ran.stderr}`);
    assert.ok(fs.existsSync(file + '-wal'), 'expected a write-ahead log left behind');
    assert.ok(fs.statSync(file + '-wal').size > 0, 'expected the log to hold the rows');
    return file;
  }

  test('it reads a log left behind by a killed writer', async () => {
    const abandoned = abandonedDatabase(50);
    const result = await backupDatabase(abandoned, path.join(outDir, 'recovered.db'));
    assert.equal(result.users, 50, 'the rows in the abandoned log did not reach the backup');
  });

  /**
   * An earlier version opened the source read-write, on a mistaken theory
   * about write-ahead logs. It worked -- and checkpointed the live database
   * every time it ran, rewriting the very file the server was using. A
   * backup that modifies the original is not a backup.
   *
   * Checked against an abandoned database, because that is the only case
   * where the backup's own connection is the last one and a close would
   * checkpoint. With the server running there is always another holder.
   */
  test('it does not touch the database it is copying', async () => {
    const abandoned = abandonedDatabase(50);
    const before = {
      db: fs.statSync(abandoned).size,
      wal: fs.statSync(abandoned + '-wal').size,
    };

    await backupDatabase(abandoned, path.join(outDir, 'untouched.db'));

    assert.equal(fs.statSync(abandoned).size, before.db, 'the source database was rewritten');
    assert.equal(fs.statSync(abandoned + '-wal').size, before.wal, 'the source log was checkpointed away');
  });

  test('the copy is a single file, not three', async () => {
    await makeUser('J.Johnson');
    const destination = path.join(outDir, backupName());
    await backupDatabase(config.dbPath, destination);

    assert.deepEqual(fs.readdirSync(outDir), [path.basename(destination)]);
  });

  test('it creates the folder it is told to write into', async () => {
    await makeUser('J.Johnson');
    const nested = path.join(outDir, 'a', 'b', backupName());
    await backupDatabase(config.dbPath, nested);
    assert.ok(fs.existsSync(nested));
  });

  test('a missing database is an error, not an empty backup', async () => {
    await assert.rejects(
      () => backupDatabase(path.join(outDir, 'nothing.db'), path.join(outDir, 'out.db')),
      /No database at/,
    );
  });

  test('two backups in the same second do not collide', () => {
    const a = backupName(new Date('2026-10-17T18:30:21.100Z'));
    const b = backupName(new Date('2026-10-17T18:30:22.900Z'));
    assert.notEqual(a, b);
    assert.match(a, /^betsend-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/);
  });

  test('the name has no characters Windows refuses', () => {
    const name = backupName(new Date('2026-10-17T18:30:21.000Z'));
    assert.doesNotMatch(name, /[:*?"<>|]/);
  });
});
