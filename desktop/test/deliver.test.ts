import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, describeDelivery, type DeliveryOptions, type Timing } from '../src/peer/deliver.js';
import type { DirectTarget, Offer } from '../src/peer/link.js';
import type { SendableFile } from '../src/peer/sender.js';

/**
 * Who gets the files by which route, and what happens when the direct one
 * lets them down. This is the part that has to be right: the user chose
 * "direct" as a preference, not as a condition, and a transfer that is
 * silently lost because somebody's PC was off would be worse than never
 * having offered the choice.
 */

const FILES: SendableFile[] = [
  { path: '/tmp/a.pdf', name: 'a.pdf', size: 1000 },
  { path: '/tmp/b.pdf', name: 'b.pdf', size: 2000 },
];

function target(name: string): DirectTarget {
  return { name, token: `token-for-${name}`, host: '10.0.0.5', port: 7777 };
}

interface Spy {
  offered: { recipients: string[]; files: { name: string; size: number }[] }[];
  directed: string[];
  servered: string[][];
  timings: { route: string; timing: Timing }[];
}

/** Options with everything working, which each test then breaks on purpose. */
function scenario(
  overrides: Partial<DeliveryOptions> & { offerResult?: Offer },
): { options: DeliveryOptions; spy: Spy } {
  const spy: Spy = { offered: [], directed: [], servered: [], timings: [] };

  const options: DeliveryOptions = {
    route: 'direct',
    recipients: ['A.Alpha'],
    files: FILES,
    note: 'here you go',
    offer: async (recipients, files) => {
      spy.offered.push({ recipients, files });
      return overrides.offerResult ?? { ready: recipients.map(target), unreachable: [] };
    },
    direct: async (t) => {
      spy.directed.push(t.name);
      return { bytes: 3000, milliseconds: 500 };
    },
    viaServer: async (recipients) => {
      spy.servered.push(recipients);
      return { bytes: 3000, milliseconds: 4000 };
    },
    onTiming: (route, timing) => spy.timings.push({ route, timing }),
    ...overrides,
  };

  return { options, spy };
}

describe('choosing a route', () => {
  test('direct, when everybody can take it', async () => {
    const { options, spy } = scenario({ recipients: ['A.Alpha', 'B.Beta'] });

    const report = await deliver(options);

    assert.deepEqual(report.direct, ['A.Alpha', 'B.Beta']);
    assert.deepEqual(report.viaServer, []);
    assert.deepEqual(spy.servered, [], 'the server should not have been touched');
  });

  test('through the server, when that is what was asked for', async () => {
    const { options, spy } = scenario({ route: 'server', recipients: ['A.Alpha', 'B.Beta'] });

    const report = await deliver(options);

    assert.deepEqual(report.viaServer, ['A.Alpha', 'B.Beta']);
    assert.deepEqual(report.direct, []);
    assert.deepEqual(spy.offered, [], 'nobody should have been asked for a direct token');
    assert.deepEqual(spy.directed, []);
  });

  test('the file list sent with the offer is sizes, not paths', async () => {
    const { options, spy } = scenario({});
    await deliver(options);
    assert.deepEqual(spy.offered[0].files, [
      { name: 'a.pdf', size: 1000 },
      { name: 'b.pdf', size: 2000 },
    ]);
  });

  test('nobody to send to is not an error, and touches nothing', async () => {
    const { options, spy } = scenario({ recipients: [] });
    const report = await deliver(options);
    assert.deepEqual(report, { direct: [], viaServer: [], fellBack: [], failed: [] });
    assert.deepEqual(spy.offered, []);
  });
});

describe('falling back when direct does not work', () => {
  test('somebody whose app is not running goes through the server', async () => {
    const { options, spy } = scenario({
      recipients: ['A.Alpha', 'B.Beta'],
      offerResult: { ready: [target('A.Alpha')], unreachable: ['B.Beta'] },
    });

    const report = await deliver(options);

    assert.deepEqual(report.direct, ['A.Alpha']);
    assert.deepEqual(report.viaServer, ['B.Beta']);
    assert.deepEqual(spy.servered, [['B.Beta']]);
  });

  /** The case the user actually asked about: it breaks mid-file. */
  test('a connection that dies halfway is retried through the server', async () => {
    const { options, spy } = scenario({
      recipients: ['A.Alpha'],
      direct: async () => {
        throw new Error('The other machine closed the connection.');
      },
    });

    const report = await deliver(options);

    assert.deepEqual(report.direct, []);
    assert.deepEqual(report.viaServer, ['A.Alpha']);
    assert.deepEqual(report.fellBack, [
      { name: 'A.Alpha', reason: 'The other machine closed the connection.' },
    ]);
    assert.deepEqual(spy.servered, [['A.Alpha']]);
  });

  test('one failure does not drag the others off the direct route', async () => {
    const { options, spy } = scenario({
      recipients: ['A.Alpha', 'B.Beta', 'C.Gamma'],
      direct: async (t) => {
        if (t.name === 'B.Beta') throw new Error('Connection reset.');
        return { bytes: 3000, milliseconds: 500 };
      },
    });

    const report = await deliver(options);

    assert.deepEqual(report.direct, ['A.Alpha', 'C.Gamma']);
    assert.deepEqual(report.viaServer, ['B.Beta']);
    assert.deepEqual(spy.servered, [['B.Beta']], 'one server upload, for the one who needed it');
  });

  test('everyone who needs the server is uploaded to once, not once each', async () => {
    const { options, spy } = scenario({
      recipients: ['A.Alpha', 'B.Beta', 'C.Gamma'],
      offerResult: { ready: [], unreachable: ['A.Alpha', 'B.Beta', 'C.Gamma'] },
    });

    await deliver(options);

    assert.equal(spy.servered.length, 1);
    assert.deepEqual(spy.servered[0], ['A.Alpha', 'B.Beta', 'C.Gamma']);
  });

  test('if the server cannot even be asked, everything goes the long way', async () => {
    const { options, spy } = scenario({
      recipients: ['A.Alpha', 'B.Beta'],
      offer: async () => {
        throw new Error('The server answered with 503.');
      },
    });

    const report = await deliver(options);

    assert.deepEqual(report.viaServer, ['A.Alpha', 'B.Beta']);
    assert.equal(report.fellBack.length, 2);
    assert.deepEqual(spy.directed, []);
  });

  test('when the server leg fails too, it is reported as not sent', async () => {
    const { options } = scenario({
      route: 'server',
      recipients: ['A.Alpha'],
      viaServer: async () => {
        throw new Error('Out of disk space on the server.');
      },
    });

    const report = await deliver(options);

    assert.deepEqual(report.viaServer, []);
    assert.deepEqual(report.failed, [{ name: 'A.Alpha', reason: 'Out of disk space on the server.' }]);
  });

  test('a direct success is kept even when the server leg for somebody else fails', async () => {
    const { options } = scenario({
      recipients: ['A.Alpha', 'B.Beta'],
      offerResult: { ready: [target('A.Alpha')], unreachable: ['B.Beta'] },
      viaServer: async () => {
        throw new Error('Out of disk space on the server.');
      },
    });

    const report = await deliver(options);

    assert.deepEqual(report.direct, ['A.Alpha']);
    assert.deepEqual(report.failed.map((f) => f.name), ['B.Beta']);
  });
});

describe('timing each leg, so the next estimate is measured', () => {
  test('a direct leg is timed as direct', async () => {
    const { options, spy } = scenario({});
    await deliver(options);
    assert.deepEqual(spy.timings, [{ route: 'direct', timing: { bytes: 3000, milliseconds: 500 } }]);
  });

  test('a server leg is timed as the server', async () => {
    const { options, spy } = scenario({ route: 'server' });
    await deliver(options);
    assert.deepEqual(spy.timings, [{ route: 'server', timing: { bytes: 3000, milliseconds: 4000 } }]);
  });

  /** A failed attempt took time but moved nothing; timing it would lie. */
  test('a leg that failed is not timed', async () => {
    const { options, spy } = scenario({
      direct: async () => {
        throw new Error('Connection reset.');
      },
      viaServer: async () => {
        throw new Error('nope');
      },
    });

    await deliver(options);
    assert.deepEqual(spy.timings, []);
  });
});

describe('telling the sender what happened', () => {
  test('the plain case names the route', async () => {
    const message = describeDelivery({ direct: ['A.Alpha'], viaServer: [], fellBack: [], failed: [] });
    assert.match(message, /A\.Alpha — sent directly\./);
  });

  test('a fallback is said out loud, with the reason', async () => {
    const message = describeDelivery({
      direct: [],
      viaServer: ['B.Beta'],
      fellBack: [{ name: 'B.Beta', reason: 'Their app is not running.' }],
      failed: [],
    });

    assert.match(message, /sent through the server/);
    assert.match(message, /B\.Beta could not be reached directly: Their app is not running\./);
  });

  test('a failure is not buried', async () => {
    const message = describeDelivery({
      direct: ['A.Alpha'],
      viaServer: [],
      fellBack: [],
      failed: [{ name: 'B.Beta', reason: 'Out of disk space on the server.' }],
    });

    assert.match(message, /Not sent to B\.Beta: Out of disk space on the server\./);
  });
});
