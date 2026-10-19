import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LaunchCollector, pathsFromArgv, SEND_FLAG, stageFiles } from '../src/staging.js';

/**
 * Windows runs a shell verb once per selected file, so a thirty-file
 * right-click arrives as thirty separate launches rather than one list.
 * Everything here exists because of that.
 */

describe('reading paths off the command line', () => {
  test('the shape the registry entry produces', () => {
    assert.deepEqual(pathsFromArgv(['C:\\BetSend.exe', SEND_FLAG, 'C:\\report.pdf']), ['C:\\report.pdf']);
  });

  test('several in one launch', () => {
    const argv = ['BetSend.exe', SEND_FLAG, 'a.txt', SEND_FLAG, 'b.txt'];
    assert.deepEqual(pathsFromArgv(argv), ['a.txt', 'b.txt']);
  });

  test('the --send=path form', () => {
    assert.deepEqual(pathsFromArgv(['BetSend.exe', `${SEND_FLAG}=C:\\report.pdf`]), ['C:\\report.pdf']);
  });

  test('Electron and Chromium switches are not files', () => {
    const argv = ['BetSend.exe', '--no-sandbox', '--user-data-dir=/tmp/x', SEND_FLAG, 'a.txt', '--hidden'];
    assert.deepEqual(pathsFromArgv(argv), ['a.txt']);
  });

  test('a dev run, where "." is the app directory and not a file to send', () => {
    assert.deepEqual(pathsFromArgv(['electron', '.', '--no-sandbox']), []);
  });

  test('an ordinary launch sends nothing', () => {
    assert.deepEqual(pathsFromArgv(['C:\\BetSend.exe']), []);
  });

  /** A registry entry that lost its "%1": a switch and no positionals. */
  test('--send with nothing to send is ignored', () => {
    assert.deepEqual(pathsFromArgv(['BetSend.exe', SEND_FLAG]), []);
    assert.deepEqual(pathsFromArgv(['BetSend.exe', SEND_FLAG, '--hidden']), []);
  });

  /**
   * The command line as Chromium actually hands it over, copied from a real
   * second instance. Switches gathered at the front, positionals at the end,
   * so --send is nowhere near its path. The parser used to read the switch
   * that followed, refuse it, and stage nothing -- the right-click menu
   * appeared to do nothing at all.
   */
  test('the reordered command line Chromium really delivers', () => {
    const argv = [
      'C:\\Program Files\\BetSend\\BetSend.exe',
      '--user-data-dir=C:\\Users\\sandro\\AppData\\Roaming\\BetSend',
      '--send',
      '--allow-file-access-from-files',
      '.',
      'C:\\Users\\sandro\\Documents\\report.pdf',
    ];
    assert.deepEqual(pathsFromArgv(argv), ['C:\\Users\\sandro\\Documents\\report.pdf']);
  });

  test('the attached form survives reordering, which is why it is used', () => {
    const argv = [
      'BetSend.exe',
      `${SEND_FLAG}=C:\\report.pdf`,
      '--allow-file-access-from-files',
      '.',
    ];
    assert.deepEqual(pathsFromArgv(argv), ['C:\\report.pdf']);
  });

  test('several positionals after a bare --send are all files', () => {
    const argv = ['BetSend.exe', '--send', '--some-switch', '.', 'a.txt', 'b.txt'];
    assert.deepEqual(pathsFromArgv(argv), ['a.txt', 'b.txt']);
  });

  /** No --send at all means a normal launch, whatever else is on the line. */
  test('positionals without --send are not files to send', () => {
    assert.deepEqual(pathsFromArgv(['electron', '.', '--no-sandbox']), []);
    assert.deepEqual(pathsFromArgv(['BetSend.exe', 'C:\\something.pdf']), []);
  });

  test('a path containing spaces survives, since argv is already split', () => {
    assert.deepEqual(pathsFromArgv(['BetSend.exe', SEND_FLAG, 'C:\\My Files\\the report.pdf']), [
      'C:\\My Files\\the report.pdf',
    ]);
  });
});

describe('checking what was dropped on us', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-staging-'));
  });

  function file(name: string, contents = 'x'): string {
    const full = path.join(dir, name);
    fs.writeFileSync(full, contents);
    return full;
  }

  test('ordinary files are measured and named', () => {
    const a = file('report.pdf', 'hello');
    const { files, skipped } = stageFiles([a]);

    assert.equal(skipped.length, 0);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'report.pdf');
    assert.equal(files[0].size, 5);
    assert.equal(files[0].path, a);
  });

  test('a file that is not there is reported, not thrown', () => {
    const { files, skipped } = stageFiles([path.join(dir, 'gone.txt')]);
    assert.equal(files.length, 0);
    assert.match(skipped[0].reason, /could not be found/);
  });

  /** A folder could be four files or forty thousand; it is not for us to decide. */
  test('a folder is refused with something the user can act on', () => {
    fs.mkdirSync(path.join(dir, 'pictures'));
    const { files, skipped } = stageFiles([path.join(dir, 'pictures')]);
    assert.equal(files.length, 0);
    assert.match(skipped[0].reason, /folder/);
  });

  test('the same file twice in one batch is staged once', () => {
    const a = file('a.txt');
    assert.equal(stageFiles([a, a]).files.length, 1);
  });

  /**
   * Windows is not consistent about the case it hands paths over in, and its
   * filesystem does not care, so the same file can arrive looking different.
   */
  test('a file already staged is not staged again, whatever its case', () => {
    const a = file('Report.PDF');
    const first = stageFiles([a]);
    const second = stageFiles([a.toLowerCase()], first.files);
    assert.equal(second.files.length, 0);
  });

  test('ids are unique across separate calls', () => {
    const ids = [...stageFiles([file('a.txt')]).files, ...stageFiles([file('b.txt')]).files].map((f) => f.id);
    assert.equal(new Set(ids).size, 2);
  });

  test('good files still come through when one of them is bad', () => {
    const good = file('good.txt');
    const { files, skipped } = stageFiles([path.join(dir, 'missing.txt'), good]);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'good.txt');
    assert.equal(skipped.length, 1);
  });

  test('an empty file is a file', () => {
    const { files } = stageFiles([file('empty.txt', '')]);
    assert.equal(files.length, 1);
    assert.equal(files[0].size, 0);
  });
});

describe('gathering separate launches into one transfer', () => {
  /** A clock under test control, so this does not wait out real timers. */
  function fakeTimers() {
    let now = 0;
    const jobs: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    return {
      schedule: (fn: () => void, ms: number) => {
        const id = nextId++;
        jobs.push({ at: now + ms, fn, id });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      unschedule: (handle: ReturnType<typeof setTimeout>) => {
        const i = jobs.findIndex((j) => j.id === (handle as unknown as number));
        if (i >= 0) jobs.splice(i, 1);
      },
      advance(ms: number) {
        now += ms;
        for (const job of jobs.filter((j) => j.at <= now)) {
          jobs.splice(jobs.indexOf(job), 1);
          job.fn();
        }
      },
    };
  }

  test('thirty launches become one batch', () => {
    const clock = fakeTimers();
    const batches: string[][] = [];
    const collector = new LaunchCollector((p) => batches.push(p), 600, clock.schedule, clock.unschedule);

    for (let i = 0; i < 30; i++) {
      collector.add([`file${i}.txt`]);
      clock.advance(5); // the shell launches them a few ms apart
    }
    assert.equal(batches.length, 0, 'nothing should be delivered while they are still arriving');

    clock.advance(600);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 30);
  });

  test('a second right-click later is a second transfer', () => {
    const clock = fakeTimers();
    const batches: string[][] = [];
    const collector = new LaunchCollector((p) => batches.push(p), 600, clock.schedule, clock.unschedule);

    collector.add(['a.txt']);
    clock.advance(700);
    collector.add(['b.txt']);
    clock.advance(700);

    assert.deepEqual(batches, [['a.txt'], ['b.txt']]);
  });

  test('nothing is delivered when nothing arrived', () => {
    const clock = fakeTimers();
    const batches: string[][] = [];
    const collector = new LaunchCollector((p) => batches.push(p), 600, clock.schedule, clock.unschedule);

    collector.add([]);
    clock.advance(1000);
    collector.flush();
    assert.equal(batches.length, 0);
  });

  test('flush delivers immediately, and only once', () => {
    const clock = fakeTimers();
    const batches: string[][] = [];
    const collector = new LaunchCollector((p) => batches.push(p), 600, clock.schedule, clock.unschedule);

    collector.add(['a.txt']);
    assert.equal(collector.waiting, 1);
    collector.flush();
    assert.deepEqual(batches, [['a.txt']]);

    // The timer must not fire a second, empty delivery afterwards.
    clock.advance(1000);
    assert.equal(batches.length, 1);
    assert.equal(collector.waiting, 0);
  });
});
