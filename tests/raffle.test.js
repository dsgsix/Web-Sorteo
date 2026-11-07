import assert from 'node:assert/strict';
import test from 'node:test';
import {
  drawWinners, parseParticipants, resultsToCSV, secureRandomInt, normalizeNameKey,
  parseTicketParticipants, drawTicketWinners, ticketPoolSummary,
  serializeTicketParticipants, mergeTicketParticipants, ticketIdentity, normalizeTicketId,
} from '../src/lib/raffle.js';

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

test('ticket parsing adds repeated names and keeps the first normalized spelling', () => {
  assert.deepEqual(parseTicketParticipants(' José   Pérez\nJOSÉ PÉREZ\nJose\u0301 Pe\u0301rez;3\nAna,2'), {
    participants: [{ name: 'José Pérez', tickets: 5 }, { name: 'Ana', tickets: 2 }], totalTickets: 7,
  });
  assert.equal(normalizeNameKey('  Jose\u0301  PÉREZ '), 'josé pérez');
  assert.deepEqual(parseTicketParticipants(' \r\n\t'), { participants: [], totalTickets: 0 });
});

test('ticket parsing handles CSV headers, BOM, quoted commas and escaped quotes', () => {
  assert.deepEqual(parseTicketParticipants('\uFEFFnombre,boletos\r\n"Pérez, Ana",3\r\n"Luis ""Lucho""",2\r\n'), {
    participants: [{ name: 'Pérez, Ana', tickets: 3 }, { name: 'Luis "Lucho"', tickets: 2 }], totalTickets: 5,
  });
  assert.deepEqual(parseTicketParticipants('\nNombre;Cantidad\n"Ana; María";4\nLuis'), {
    participants: [{ name: 'Ana; María', tickets: 4 }, { name: 'Luis', tickets: 1 }], totalTickets: 5,
  });
});

test('ticket parsing handles quoted multiline names and retains physical error lines', () => {
  assert.deepEqual(parseTicketParticipants('nombre,boletos\r\n"Ana\r\nMaría",2\r\nLuis,1'), {
    participants: [{ name: 'Ana María', tickets: 2 }, { name: 'Luis', tickets: 1 }], totalTickets: 3,
  });
  assert.throws(() => parseTicketParticipants('nombre,boletos\r\n"Ana\r\nMaría",2\r\nLuis,0'), /Línea 4:/u);
});

test('ticket quantities and malformed CSV produce clear line-specific errors', () => {
  for (const value of ['0', '-1', '1.5', '1e3', 'NaN', '', '1000001', '9007199254740993']) {
    assert.throws(() => parseTicketParticipants(`Ana,1\nLuis,${value}`), /Línea 2:/u);
  }
  for (const invalid of ['Ana,1,2', 'Ana;1,2', '"Ana,1', '"Ana"oops,1', 'An"a,1', ',3', 'Ana\0,1']) {
    assert.throws(() => parseTicketParticipants(invalid), /Línea 1:/u);
  }
  assert.throws(() => parseTicketParticipants('Ana,1000000\nANA'), /Línea 2:/u);
  assert.throws(() => parseTicketParticipants(null), TypeError);
  assert.throws(() => normalizeNameKey(null), TypeError);
});

test('ticket parser enforces participant and uint32 total limits', () => {
  const many = Array.from({ length: 5001 }, (_, index) => `Persona ${index}`).join('\n');
  assert.throws(() => parseTicketParticipants(many), /Línea 5001:.*5\.000/u);
  const almostFull = Array.from({ length: 4294 }, (_, index) => `Persona ${index},1000000`).join('\n');
  const full = parseTicketParticipants(`${almostFull}\nÚltima,967296`);
  assert.equal(full.totalTickets, 2 ** 32);
  assert.throws(() => parseTicketParticipants(`${almostFull}\nÚltima,967297`), /Línea 4295:.*4\.294\.967\.296/u);
});

const weightedParticipants = [{ name: 'Ana', tickets: 3 }, { name: 'Luis', tickets: 1 }];

test('weighted draw maps every ticket interval to its owner with exact 3-to-1 odds', () => {
  const expected = [['Ana', 1, 0.75], ['Ana', 2, 0.75], ['Ana', 3, 0.75], ['Luis', 1, 0.25]];
  for (let ticket = 0; ticket < 4; ticket += 1) {
    const [winner] = drawTicketWinners(weightedParticipants, 1, {
      randomInt: (bound) => { assert.equal(bound, 4); return ticket; },
    });
    assert.deepEqual([winner.name, winner.ticketNumber, winner.probability], expected[ticket]);
    assert.equal(winner.tickets, winner.name === 'Ana' ? 3 : 1);
  }
});

test('unique people mode removes all tickets belonging to the selected winner', () => {
  const bounds = [];
  const snapshot = structuredClone(weightedParticipants);
  const winners = drawTicketWinners(weightedParticipants, 2, {
    randomInt: (bound) => { bounds.push(bound); return 0; },
  });
  assert.deepEqual(winners, [
    { name: 'Ana', ticketNumber: 1, tickets: 3, probability: 0.75 },
    { name: 'Luis', ticketNumber: 1, tickets: 1, probability: 0.25 },
  ]);
  assert.deepEqual(bounds, [4, 1]);
  assert.deepEqual(weightedParticipants, snapshot);
});

test('ticket mode permits the same person to win with distinct original tickets', () => {
  const bounds = [];
  const winners = drawTicketWinners(weightedParticipants, 4, {
    uniquePeople: false, randomInt: (bound) => { bounds.push(bound); return 0; },
  });
  assert.deepEqual(winners.map(({ name, ticketNumber }) => [name, ticketNumber]), [
    ['Ana', 1], ['Ana', 2], ['Ana', 3], ['Luis', 1],
  ]);
  assert.deepEqual(bounds, [4, 3, 2, 1]);
  assert.deepEqual(winners.map(({ probability }) => probability), [0.75, 0.75, 0.75, 0.25]);
});

test('ticket mode maps remaining ranks correctly after middle tickets are removed', () => {
  const offsets = [1, 1, 0];
  const winners = drawTicketWinners([{ name: 'Ana', tickets: 3 }], 3, {
    uniquePeople: false, randomInt: () => offsets.shift(),
  });
  assert.deepEqual(winners.map(({ ticketNumber }) => ticketNumber), [2, 3, 1]);
});

test('name exclusions use Unicode, whitespace and case normalization', () => {
  const participants = [{ name: 'José Pérez', tickets: 30 }, { name: 'Ana', tickets: 2 }];
  const options = { excludeNames: ['JOSE\u0301   PÉREZ', 'Ausente'] };
  assert.deepEqual(ticketPoolSummary(participants, options), { eligibleParticipants: 1, totalTickets: 2 });
  assert.deepEqual(drawTicketWinners(participants, 1, { ...options, randomInt: () => 1 }), [
    { name: 'Ana', ticketNumber: 2, tickets: 2, probability: 1 },
  ]);
});

test('prior winning tickets are excluded once while their owners remain eligible', () => {
  const options = { excludeTickets: [
    { name: 'ANA', ticketNumber: 2 }, { name: ' Ana ', ticketNumber: 2 },
    { name: 'Ausente', ticketNumber: 1 }, { name: 'Ana', ticketNumber: 99 },
  ] };
  assert.deepEqual(ticketPoolSummary(weightedParticipants, options), { eligibleParticipants: 2, totalTickets: 3 });
  const winners = drawTicketWinners(weightedParticipants, 3, { ...options, uniquePeople: false, randomInt: () => 0 });
  assert.deepEqual(winners.map(({ name, ticketNumber }) => [name, ticketNumber]), [['Ana', 1], ['Ana', 3], ['Luis', 1]]);
  assert.equal(winners[0].tickets, 3);
  assert.equal(winners[0].probability, 2 / 3);
  assert.equal(winners[2].probability, 1 / 3);
});

test('exclusions can exhaust a person or the whole pool and count validation follows the mode', () => {
  const exclusions = [1, 2, 3].map((ticketNumber) => ({ name: 'Ana', ticketNumber }));
  assert.deepEqual(ticketPoolSummary(weightedParticipants, { excludeTickets: exclusions }), {
    eligibleParticipants: 1, totalTickets: 1,
  });
  assert.deepEqual(ticketPoolSummary(weightedParticipants, { excludeNames: ['Ana', 'Luis'] }), {
    eligibleParticipants: 0, totalTickets: 0,
  });
  assert.throws(() => drawTicketWinners(weightedParticipants, 3), RangeError);
  assert.throws(() => drawTicketWinners(weightedParticipants, 5, { uniquePeople: false }), RangeError);
  assert.throws(() => drawTicketWinners(weightedParticipants, 1, { excludeNames: ['Ana', 'Luis'] }), RangeError);
  assert.throws(() => drawTicketWinners([{ name: 'Ana', tickets: 10000 }], 5001, { uniquePeople: false }), RangeError);
  for (const count of [0, -1, 1.5, NaN, '1']) assert.throws(() => drawTicketWinners(weightedParticipants, count), RangeError);
});

test('weighted draw rejects malformed pools, exclusions and random outputs', () => {
  for (const participants of [null, [null], [{ name: '', tickets: 1 }], [{ name: 'Ana', tickets: 0 }],
    [{ name: 'Ana', tickets: 1.5 }], [{ name: 'Ana', tickets: 1000001 }],
    [{ name: 'Ana', tickets: 1 }, { name: 'ANA', tickets: 2 }]]) {
    assert.throws(() => drawTicketWinners(participants, 1));
  }
  assert.throws(() => ticketPoolSummary(weightedParticipants, { excludeNames: [null] }), TypeError);
  assert.throws(() => ticketPoolSummary(weightedParticipants, { excludeTickets: [{ name: 'Ana', ticketNumber: 0 }] }), TypeError);
  assert.throws(() => drawTicketWinners(weightedParticipants, 1, { uniquePeople: 'false' }), TypeError);
  assert.throws(() => drawTicketWinners(weightedParticipants, 1, { randomInt: null }), TypeError);
  for (const output of [-1, 4, 0.5, NaN, '0']) {
    assert.throws(() => drawTicketWinners(weightedParticipants, 1, { randomInt: () => output }), RangeError);
  }
});

test('weighted CSV exports stage, prize, original ticket and initial probability', () => {
  const draw = {
    title: 'Gran sorteo', stageName: 'Etapa 1', prize: 'Una bicicleta', createdAt: '2026-11-05T10:00:00Z',
    winners: ['Ana'], winnerDetails: [{ name: 'Ana', tickets: 3, ticketNumber: 2, probability: 0.75 }],
  };
  assert.equal(resultsToCSV(draw), '\uFEFF"Posición","Ganador","Sorteo","Fecha","Etapa","Premio","Boleto","Boletos","Probabilidad"\r\n'
    + '"1","Ana","Gran sorteo","2026-11-05T10:00:00.000Z","Etapa 1","Una bicicleta","2","3","75%"\r\n');
});

test('weighted CSV can infer names from details and prevents formulas in new columns', () => {
  const csv = resultsToCSV({
    title: 'Sorteo', stageName: '=1+1', prize: '@SUM(A1)', createdAt: 0,
    winnerDetails: [{ name: '=HYPERLINK("evil")', tickets: 1, ticketNumber: 1, probability: 1 }],
  });
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"\'@SUM(A1)"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
});

test('weighted CSV rejects mismatched or invalid ticket details', () => {
  const draw = { title: 'Sorteo', createdAt: 0, winners: ['Ana'] };
  for (const winnerDetails of [null, [], [{ name: 'Luis', tickets: 1, ticketNumber: 1, probability: 1 }],
    [{ name: 'Ana', tickets: 1, ticketNumber: 2, probability: 1 }],
    [{ name: 'Ana', tickets: 1, ticketNumber: 1, probability: 0 }]]) {
    assert.throws(() => resultsToCSV({ ...draw, winnerDetails }), TypeError);
  }
});

test('singular Boleto header imports one real ticket per row and preserves printed IDs', () => {
  assert.deepEqual(parseTicketParticipants('\uFEFFNombre;Boleto\r\nAna;001\r\nLuis;A-007\r\nANA;002\r\n'), {
    participants: [
      { name: 'Ana', tickets: 2, ticketIds: ['001', '002'] },
      { name: 'Luis', tickets: 1, ticketIds: ['A-007'] },
    ], totalTickets: 3,
  });
  assert.deepEqual(parseTicketParticipants('Número,Nombre\n"C,004","Pérez, Ana"'), {
    participants: [{ name: 'Pérez, Ana', tickets: 1, ticketIds: ['C,004'] }], totalTickets: 1,
  });
  assert.deepEqual(parseTicketParticipants('Numero;Nombre\n0008;Ana'), {
    participants: [{ name: 'Ana', tickets: 1, ticketIds: ['0008'] }], totalTickets: 1,
  });
  assert.deepEqual(parseTicketParticipants('Nombre;Boletos\nAna;003'), {
    participants: [{ name: 'Ana', tickets: 3 }], totalTickets: 3,
  });
});

test('real-ticket parsing rejects missing IDs, duplicates and numeric padding aliases by line', () => {
  for (const suffix of ['Ana;', 'Ana', 'Ana;001\nLuis;1', 'Ana;A-007\nLuis;a-007', `Ana;${'X'.repeat(101)}`]) {
    assert.throws(() => parseTicketParticipants(`Nombre;Boleto\n${suffix}`), /Línea [23]:/u);
  }
  assert.equal(normalizeTicketId('  000001 '), '1');
  assert.equal(normalizeTicketId('000'), '0');
  assert.equal(normalizeTicketId('A-007'), 'a-007');
  assert.equal(normalizeTicketId('e\u0301-7'), normalizeTicketId('É-7'));
  for (const invalid of [1, null, '', ' \t ', 'a\nb', 'a\0b', 'x'.repeat(101)]) {
    assert.throws(() => normalizeTicketId(invalid), TypeError);
  }
});

const numberedParticipants = [
  { name: 'Ana', tickets: 3, ticketIds: ['001', '008', 'A-007'] },
  { name: 'Luis', tickets: 1, ticketIds: ['020'] },
];

test('serialization roundtrips real IDs, quoted names and legacy counts without mutation', () => {
  const snapshot = structuredClone(numberedParticipants);
  const numberedCSV = serializeTicketParticipants(numberedParticipants);
  assert.ok(numberedCSV.startsWith('Nombre;Boleto\n'));
  assert.deepEqual(parseTicketParticipants(numberedCSV), { participants: numberedParticipants, totalTickets: 4 });
  assert.deepEqual(numberedParticipants, snapshot);
  const tricky = [{ name: 'Ana "A", Pérez; López', tickets: 1, ticketIds: ['00;5'] }];
  assert.deepEqual(parseTicketParticipants(serializeTicketParticipants(tricky)).participants, tricky);
  const countsCSV = serializeTicketParticipants(weightedParticipants);
  assert.ok(countsCSV.startsWith('Nombre;Boletos\n'));
  assert.deepEqual(parseTicketParticipants(countsCSV), { participants: weightedParticipants, totalTickets: 4 });
  assert.deepEqual(parseTicketParticipants(serializeTicketParticipants([])), { participants: [], totalTickets: 0 });
});

test('ticket identity returns original IDs or legacy ordinals', () => {
  assert.equal(ticketIdentity(numberedParticipants[0], 1), '001');
  assert.equal(ticketIdentity(numberedParticipants[0], 3), 'A-007');
  assert.equal(ticketIdentity(weightedParticipants[0], 2), 2);
  for (const ordinal of [0, 4, 1.5, '1']) assert.throws(() => ticketIdentity(numberedParticipants[0], ordinal), RangeError);
  assert.throws(() => ticketIdentity({ name: 'Ana', tickets: 2, ticketIds: ['001'] }, 1), TypeError);
});

test('merging groups matching owners while retaining real IDs and rejects mixed or duplicate tickets', () => {
  const first = [{ name: 'Ana', tickets: 1, ticketIds: ['001'] }];
  const second = [{ name: 'ANA', tickets: 1, ticketIds: ['002'] }, { name: 'Luis', tickets: 1, ticketIds: ['A-007'] }];
  const snapshot = structuredClone([first, second]);
  assert.deepEqual(mergeTicketParticipants(first, second), [
    { name: 'Ana', tickets: 2, ticketIds: ['001', '002'] }, { name: 'Luis', tickets: 1, ticketIds: ['A-007'] },
  ]);
  assert.deepEqual([first, second], snapshot);
  assert.deepEqual(mergeTicketParticipants([{ name: 'Ana', tickets: 2 }], [{ name: 'ANA', tickets: 3 }]), [{ name: 'Ana', tickets: 5 }]);
  assert.deepEqual(mergeTicketParticipants([], first), first);
  assert.throws(() => mergeTicketParticipants(first, [{ name: 'Luis', tickets: 1, ticketIds: ['1'] }]), /repetido/u);
  assert.throws(() => mergeTicketParticipants(first, weightedParticipants), /mezclar boletos numerados con cantidades/u);
});

test('each real ticket occupies exactly one equal-probability interval in the draw', () => {
  const expectedIds = ['001', '008', 'A-007', '020'];
  for (let offset = 0; offset < 4; offset += 1) {
    const [winner] = drawTicketWinners(numberedParticipants, 1, { randomInt: (bound) => {
      assert.equal(bound, 4); return offset;
    } });
    assert.equal(winner.ticketId, expectedIds[offset]);
    assert.equal(winner.ticketNumber, offset < 3 ? offset + 1 : 1);
    assert.equal(winner.probability, offset < 3 ? 0.75 : 0.25);
  }
  const all = drawTicketWinners(numberedParticipants, 4, { uniquePeople: false, randomInt: () => 0 });
  assert.deepEqual(all.map(({ ticketId }) => ticketId), expectedIds);
  assert.equal(new Set(all.map(({ ticketId }) => ticketId)).size, 4);
});

test('real-ticket exclusions follow global IDs after rows reorder or owners change names', () => {
  const changed = [
    { name: 'Nombre corregido', tickets: 2, ticketIds: ['008', '001'] },
    { name: 'Luis', tickets: 1, ticketIds: ['020'] },
  ];
  const options = { excludeTickets: [{ name: 'Ana', ticketNumber: 1, ticketId: '1' }, { ticketId: '000001' }] };
  assert.deepEqual(ticketPoolSummary(changed, options), { eligibleParticipants: 2, totalTickets: 2 });
  const all = drawTicketWinners(changed, 2, { ...options, uniquePeople: false, randomInt: () => 0 });
  assert.deepEqual(all.map(({ ticketId }) => ticketId), ['008', '020']);
  assert.equal(all[0].ticketNumber, 1);
  assert.equal(all[0].tickets, 2);
  assert.equal(all[0].probability, 0.5);
  assert.deepEqual(ticketPoolSummary(numberedParticipants, { excludeTickets: [{ ticketId: 'a-007' }] }), {
    eligibleParticipants: 2, totalTickets: 3,
  });
});

test('ordinal exclusions never accidentally remove a real ticket and explicit IDs never remove legacy counts', () => {
  assert.deepEqual(ticketPoolSummary(numberedParticipants, { excludeTickets: [{ name: 'Ana', ticketNumber: 1 }] }), {
    eligibleParticipants: 2, totalTickets: 4,
  });
  assert.deepEqual(ticketPoolSummary(weightedParticipants, { excludeTickets: [{ name: 'Ana', ticketNumber: 1, ticketId: '001' }] }), {
    eligibleParticipants: 2, totalTickets: 4,
  });
});

test('real-ticket pools validate IDs globally before applying exclusions', () => {
  const duplicate = [{ name: 'Ana', tickets: 1, ticketIds: ['001'] }, { name: 'Luis', tickets: 1, ticketIds: ['1'] }];
  assert.throws(() => ticketPoolSummary(duplicate, { excludeNames: ['Ana'] }), /repetido/u);
  for (const invalid of [
    [{ name: 'Ana', tickets: 2, ticketIds: ['001'] }],
    [{ name: 'Ana', tickets: 1, ticketIds: [1] }],
    [{ name: 'Ana', tickets: 1, ticketIds: [''] }],
    [{ name: 'Ana', tickets: 1, ticketIds: null }],
    [{ name: 'Ana', tickets: 1, ticketIds: ['001'] }, { name: 'Luis', tickets: 1 }],
  ]) {
    assert.throws(() => drawTicketWinners(invalid, 1));
    assert.throws(() => serializeTicketParticipants(invalid));
  }
});

test('real winning IDs stay literal in CSV and formula-like IDs are neutralized', () => {
  const draw = { title: 'Sorteo', createdAt: 0, winnerDetails: [
    { name: 'Ana', tickets: 3, ticketNumber: 2, ticketId: '001', probability: 0.75 },
  ] };
  assert.ok(resultsToCSV(draw).includes(',"001","3","75%"'));
  draw.winnerDetails[0].ticketId = '=1+1';
  assert.ok(resultsToCSV(draw).includes(',"\'=1+1","3","75%"'));
  for (const ticketId of ['', null, 1, 'x'.repeat(101), 'a\nb']) {
    draw.winnerDetails[0].ticketId = ticketId;
    assert.throws(() => resultsToCSV(draw), TypeError);
  }
});
