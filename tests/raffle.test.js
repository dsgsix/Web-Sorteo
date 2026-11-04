import assert from 'node:assert/strict';
import test from 'node:test';
import { drawWinners, parseParticipants, resultsToCSV, secureRandomInt } from '../src/lib/raffle.js';

test('participant parsing removes blanks and recognizes different line endings', () => {
  assert.deepEqual(parseParticipants(' Ana \r\n\nLuis\rMarta\n'), {
    names: ['Ana', 'Luis', 'Marta'], duplicateCount: 0,
  });
});

test('participant parsing deduplicates case, spacing and Unicode equivalents', () => {
  assert.deepEqual(parseParticipants('  José   Pérez\nJOSÉ PÉREZ\nJose\u0301 Pe\u0301rez\nMaría'), {
    names: ['José Pérez', 'María'], duplicateCount: 2,
  });
  assert.deepEqual(parseParticipants(' \n\t'), { names: [], duplicateCount: 0 });
  assert.throws(() => parseParticipants(null), TypeError);
});

test('draw samples deterministically without modifying the supplied participants', () => {
  const participants = ['Ana', 'Luis', 'Marta', 'Juan'];
  const bounds = [];
  const winners = drawWinners(participants, 3, (bound) => {
    bounds.push(bound);
    return bound - 1;
  });
  assert.deepEqual(winners, ['Juan', 'Ana', 'Luis']);
  assert.deepEqual(bounds, [4, 3, 2]);
  assert.deepEqual(participants, ['Ana', 'Luis', 'Marta', 'Juan']);
});

test('draw can select the entire pool once and secure sampling stays in range', () => {
  const participants = ['Ana', 'Luis', 'Marta'];
  const winners = drawWinners(participants, participants.length);
  assert.equal(new Set(winners).size, participants.length);
  assert.deepEqual([...winners].sort(), [...participants].sort());
  for (const bound of [1, 3, 7, 256, 2 ** 32]) {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const random = secureRandomInt(bound);
      assert.ok(Number.isInteger(random) && random >= 0 && random < bound);
    }
  }
});

test('secure integer bounds are validated', () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity, '3', 2 ** 32 + 1]) {
    assert.throws(() => secureRandomInt(invalid), RangeError);
  }
});

test('secure integer sampling discards the incomplete bucket to avoid modulo bias', (context) => {
  const values = [2 ** 32 - 1, 4];
  let calls = 0;
  context.mock.method(globalThis.crypto, 'getRandomValues', (buffer) => {
    buffer[0] = values[calls++];
    return buffer;
  });
  assert.equal(secureRandomInt(3), 1);
  assert.equal(calls, 2);
});

test('draw rejects invalid counts, empty pools and malformed names', () => {
  for (const count of [0, -1, 1.5, 4, NaN, '2']) {
    assert.throws(() => drawWinners(['Ana', 'Luis', 'Marta'], count), RangeError);
  }
  assert.throws(() => drawWinners([], 1), RangeError);
  for (const participants of [null, 'Ana', ['Ana', ' '], ['Ana', 42]]) {
    assert.throws(() => drawWinners(participants, 1), TypeError);
  }
});

test('draw rejects normalized duplicate names and malformed generators', () => {
  assert.throws(() => drawWinners(['Ana María', ' ana   MARÍA '], 1), RangeError);
  assert.throws(() => drawWinners(['Ana'], 1, null), TypeError);
  for (const output of [-1, 2, 0.5, NaN, '0']) {
    assert.throws(() => drawWinners(['Ana', 'Luis'], 1, () => output), RangeError);
  }
});

test('CSV preserves names, quotes and dates with BOM and CRLF', () => {
  const csv = resultsToCSV({
    title: 'Una "gran" tarde', createdAt: '2026-11-04T10:00:00Z', winners: ['Pérez, Ana', 'Luis'],
  });
  assert.equal(csv, '\uFEFF"Posición","Ganador","Sorteo","Fecha"\r\n'
    + '"1","Pérez, Ana","Una ""gran"" tarde","2026-11-04T10:00:00.000Z"\r\n'
    + '"2","Luis","Una ""gran"" tarde","2026-11-04T10:00:00.000Z"\r\n');
});

test('CSV neutralizes spreadsheet formulas in names and titles', () => {
  const csv = resultsToCSV({
    title: '=HYPERLINK("https://example.com")', createdAt: 0,
    winners: ['=1+1', '+SUM(A1)', '-2+4', '@SUM(A1)', '  =1+1', '\tformula'],
  });
  for (const dangerous of ['=1+1', '+SUM(A1)', '-2+4', '@SUM(A1)', '  =1+1', '\tformula']) {
    assert.ok(csv.includes(`"'${dangerous}"`));
  }
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.com"")"'));
});

test('CSV rejects malformed results and dates', () => {
  for (const draw of [null, {}, { title: 'Sorteo', winners: [null], createdAt: 0 },
    { title: 'Sorteo', winners: ['Ana'], createdAt: 'invalid' },
    { title: 'Sorteo', winners: ['Ana'] }]) {
    assert.throws(() => resultsToCSV(draw), TypeError);
  }
});
