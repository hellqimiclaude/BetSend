import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, readSettings, writeSettings, type Settings } from '../src/settings.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsend-desktop-'));
  file = path.join(dir, 'settings.json');
});

function write(contents: string): void {
  fs.writeFileSync(file, contents);
}

describe('remembering settings', () => {
  test('a round trip keeps everything', () => {
    const settings: Settings = {
      serverUrl: 'http://betsend-pc:8080',
      startWithWindows: false,
      window: { width: 1200, height: 800, x: 10, y: 20, maximized: true },
    };
    writeSettings(file, settings);
    assert.deepEqual(readSettings(file), settings);
  });

  test('it creates the folder it is told to write into', () => {
    const nested = path.join(dir, 'a', 'b', 'settings.json');
    writeSettings(nested, DEFAULTS);
    assert.ok(fs.existsSync(nested));
  });

  /**
   * Every one of these used to be a way to make the app refuse to open. The
   * worst a broken settings file may cost somebody is retyping the address.
   */
  describe('a damaged file never stops the app starting', () => {
    test('missing entirely', () => {
      assert.deepEqual(readSettings(path.join(dir, 'nope.json')), DEFAULTS);
    });

    test('not JSON', () => {
      write('{ this is not');
      assert.deepEqual(readSettings(file), DEFAULTS);
    });

    test('JSON, but not an object', () => {
      write('"a string"');
      assert.deepEqual(readSettings(file), DEFAULTS);
      write('null');
      assert.deepEqual(readSettings(file), DEFAULTS);
      write('[1, 2, 3]');
      assert.equal(readSettings(file).serverUrl, null);
    });

    test('empty', () => {
      write('');
      assert.deepEqual(readSettings(file), DEFAULTS);
    });

    test('with a byte-order mark, as a Windows editor would leave it', () => {
      write('﻿{"serverUrl":"http://betsend-pc:8080"}');
      assert.equal(readSettings(file).serverUrl, 'http://betsend-pc:8080');
    });

    test('fields of the wrong type', () => {
      write('{"serverUrl": 42, "startWithWindows": "yes", "window": "big"}');
      const settings = readSettings(file);
      assert.equal(settings.serverUrl, null);
      assert.equal(settings.startWithWindows, DEFAULTS.startWithWindows);
      assert.equal(settings.window, null);
    });

    test('an empty server address counts as none', () => {
      write('{"serverUrl": ""}');
      assert.equal(readSettings(file).serverUrl, null);
    });
  });

  describe('window geometry', () => {
    test('a size too small to grab is ignored', () => {
      write('{"window":{"width":1,"height":1}}');
      assert.equal(readSettings(file).window, null);
    });

    test('a position is kept only when both halves are there', () => {
      write('{"window":{"width":1000,"height":700,"x":5}}');
      const window = readSettings(file).window;
      assert.deepEqual(window, { width: 1000, height: 700, maximized: false });
    });

    test('fractional sizes are rounded', () => {
      write('{"window":{"width":1000.6,"height":700.2}}');
      assert.deepEqual(readSettings(file).window, { width: 1001, height: 700, maximized: false });
    });
  });
});
